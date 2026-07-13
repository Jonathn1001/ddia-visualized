import { useEffect, useState } from 'react';
import { Simulation, type NodeId } from '../../../engine';
import type { SimModule } from '../../../engine';
import { BROKER_TOPOLOGY, CONSUMERS, type Triple } from '../../../modules/brokers-shared';
import { detectKafkaDup, kafkalog, kafkaTriple, type KafkaState } from '../../../modules/kafkalog';
import { detectRabbitRedelivery, rabbitqueue, rabbitTriple, type RabbitState } from '../../../modules/rabbitqueue';
import { detectRedisLost, redispubsub, redisTriple, type RedisState } from '../../../modules/redispubsub';
import { SimDriver } from '../../bridge/SimDriver';
import { useSimStore } from '../../bridge/simStore';
import { BrokerInternals, type BrokerMode, type ConsumerView } from '../../kit/BrokerInternals';
import { ChallengePanel } from '../../kit/ChallengePanel';
import { ChaosToolbar } from '../../kit/ChaosToolbar';
import { MetricsPanel } from '../../kit/MetricsPanel';
import { TimelineScrubber } from '../../kit/TimelineScrubber';
import { btn, btnPrimary } from '../../kit/classes';
import { Scoreboard } from './Scoreboard';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MODULES: Record<BrokerMode, SimModule<any, any>> = {
  kafka: kafkalog,
  rabbit: rabbitqueue,
  redis: redispubsub,
};

const TABS: { mode: BrokerMode; label: string }[] = [
  { mode: 'kafka', label: 'Kafka' },
  { mode: 'rabbit', label: 'RabbitMQ' },
  { mode: 'redis', label: 'Redis' },
];

const emptyScores = (): Record<BrokerMode, Triple | null> => ({ kafka: null, rabbit: null, redis: null });
const allStale = (): Record<BrokerMode, boolean> => ({ kafka: true, rabbit: true, redis: true });

function tripleFor(mode: BrokerMode, states: Map<NodeId, unknown>): Triple {
  if (mode === 'kafka') return kafkaTriple(states as Map<NodeId, KafkaState>);
  if (mode === 'rabbit') return rabbitTriple(states as Map<NodeId, RabbitState>);
  return redisTriple(states as Map<NodeId, RedisState>);
}

/** The driver bundled with the mode it was built for, so data never desyncs. */
interface Session {
  driver: SimDriver<unknown, unknown>;
  mode: BrokerMode;
}

export function BrokersLab() {
  const [mode, setMode] = useState<BrokerMode>('kafka'); // requested tab (drives rebuild + highlight)
  const [epoch, setEpoch] = useState(0);
  const [nextKey, setNextKey] = useState(0);
  const [session, setSession] = useState<Session | null>(null);
  const [scores, setScores] = useState<Record<BrokerMode, Triple | null>>(emptyScores);
  const [stale, setStale] = useState<Record<BrokerMode, boolean>>(allStale);

  // Epoch-rebuild (Ch6): build the sim in the commit phase. Switching mode swaps
  // the module and rebuilds; the driver is stored WITH its mode so every data
  // read below uses a consistent (driver, mode) pair even mid-rebuild.
  useEffect(() => {
    useSimStore.getState().reset();
    const seed = 11000 + epoch;
    const sim = new Simulation<unknown, unknown>({
      module: MODULES[mode] as unknown as SimModule<unknown, unknown>,
      config: { nodeIds: BROKER_TOPOLOGY },
      seed,
      network: { latency: [10, 80] },
    });
    const d = new SimDriver<unknown, unknown>({ sim, seed, publish: (v) => useSimStore.getState().publish(v) });
    setSession({ driver: d, mode });
    setNextKey(0);
    setStale((s) => ({ ...s, [mode]: true }));
    return () => d.pause();
  }, [mode, epoch]);

  const view = useSimStore();

  const statesOf = (d: SimDriver<unknown, unknown>) =>
    new Map<NodeId, unknown>(BROKER_TOPOLOGY.map((id) => [id, d.sim.getState(id)] as const));

  // Capture the triple into the scoreboard when the active run drains.
  useEffect(() => {
    if (!session) return;
    if (view.pending === 0 && view.processed > 0) {
      const t = tripleFor(session.mode, statesOf(session.driver));
      setScores((s) => ({ ...s, [session.mode]: t }));
      setStale((s) => ({ ...s, [session.mode]: false }));
    }
  }, [view.pending, view.processed, session]);

  if (!session) return null;
  const { driver, mode: activeMode } = session;

  const brokerNode = view.nodes.find((n) => n.id === 'B');
  const broker = brokerNode?.inspect as Record<string, unknown> | undefined;
  const consumers: ConsumerView[] = CONSUMERS.map((id) => {
    const n = view.nodes.find((nn) => nn.id === id);
    const processed = ((n?.inspect as { processed?: string[] } | undefined)?.processed ?? []) as string[];
    return { id, dead: n?.dead ?? false, processed };
  });

  const live = tripleFor(activeMode, statesOf(driver));
  const activeLabel = TABS.find((t) => t.mode === activeMode)!.label;

  const produce = () => {
    for (let i = 0; i < 12; i++) driver.external('P', { cmd: 'produce', key: `m${nextKey + i}` });
    setNextKey((n) => n + 12);
    driver.start(); // let the messages flow
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
        {TABS.map((t) => (
          <button
            key={t.mode}
            className={mode === t.mode ? btnPrimary : btn}
            aria-pressed={mode === t.mode}
            onClick={() => setMode(t.mode)}
          >
            {t.label}
          </button>
        ))}
        <button className={btn} onClick={() => setEpoch((e) => e + 1)}>
          reset (new seed)
        </button>
        <span className="text-dim">producer P · broker B · consumers C1 C2</span>
      </div>

      <TimelineScrubber
        processed={view.processed}
        pending={view.pending}
        running={view.running}
        onPlayPause={() => (view.running ? driver.pause() : driver.start())}
        onStep={() => driver.stepOnce()}
        onScrub={(i) => driver.scrubTo(i)}
      />

      <div className="flex flex-wrap items-start gap-6">
        <BrokerInternals mode={activeMode} broker={broker} consumers={consumers} />
        <MetricsPanel history={view.metricsHistory} />
      </div>

      <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
        <button className={btnPrimary} onClick={produce}>
          produce 12
        </button>
        <p className="text-fg">
          {activeLabel}: <span className="text-set font-bold">{live.delivered}</span> delivered ·{' '}
          <span className={live.duplicates > 0 ? 'text-warn font-bold' : ''}>{live.duplicates}</span> duplicates ·{' '}
          <span className={live.lost > 0 ? 'text-warn font-bold' : ''}>{live.lost}</span> lost{' '}
          <span className="text-dim">of {live.produced} produced</span>
        </p>
      </div>

      <div className="rounded border border-line bg-panel p-3">
        <p className="mb-2 font-mono text-[11px] tracking-wider text-dim uppercase">scoreboard — same workload, three fates</p>
        <Scoreboard scores={scores} stale={stale} />
      </div>

      <ChaosToolbar
        caps={MODULES[activeMode].chaos}
        nodeIds={BROKER_TOPOLOGY}
        deadNodes={view.nodes.filter((n) => n.dead).map((n) => n.id)}
        onAction={(a) => driver.control(a)}
      />

      {activeMode === 'kafka' && (
        <ChallengePanel
          title="Chaos Challenge — Make it twice"
          storageKeyPrefix="ddia:ch11:kafka-dup"
          prompt="Predict first: how will you make the group process one message twice? (skippable)"
          runningHint="produce 12, then kill a consumer while messages are still in flight — the rebalance replays uncommitted offsets to the survivor."
          check={() => detectKafkaDup(statesOf(driver) as Map<NodeId, KafkaState>)}
          onWin={() => driver.pause()}
          renderWin={(win, prediction) => (
            <>
              <p>
                the group reprocessed <code className="text-warn">{win.duplicates}</code> message(s). This is{' '}
                <strong>at-least-once</strong>: the log replayed offsets a dead consumer had processed but not
                committed. Exactly-once is dedup/idempotence layered on top — the broker alone never gives it.
              </p>
              <p className="text-dim">your prediction: “{prediction}”</p>
            </>
          )}
        />
      )}
      {activeMode === 'rabbit' && (
        <ChallengePanel
          title="Chaos Challenge — Resurrect a message"
          storageKeyPrefix="ddia:ch11:rabbit-redeliver"
          prompt="Predict first: kill a consumer holding an unacked message — what happens to it? (skippable)"
          runningHint="produce, then kill the consumer a message was just delivered to, before it acks — the ack timeout requeues it to the other consumer."
          check={() => detectRabbitRedelivery(statesOf(driver) as Map<NodeId, RabbitState>)}
          onWin={() => driver.pause()}
          renderWin={(win, prediction) => (
            <>
              <p>
                a redelivered message reached the surviving consumer ({win.redeliveries} redelivery(ies)). Per-message
                ack vs Kafka's per-offset commit — finer-grained, same at-least-once ceiling.
              </p>
              <p className="text-dim">your prediction: “{prediction}”</p>
            </>
          )}
        />
      )}
      {activeMode === 'redis' && (
        <ChallengePanel
          title="Chaos Challenge — Lose it forever"
          storageKeyPrefix="ddia:ch11:redis-lost"
          prompt="Predict first: kill a subscriber, publish, revive it — does it catch up? (skippable)"
          runningHint="kill a subscriber, produce 12, revive it, let it drain — nothing was stored, so the missed messages are gone."
          check={() => (view.pending === 0 ? detectRedisLost(statesOf(driver) as Map<NodeId, RedisState>) : null)}
          onWin={() => driver.pause()}
          renderWin={(win, prediction) => (
            <>
              <p>
                <code className="text-warn">{win.lost}</code> message(s) missed a subscriber and are gone. Nothing was
                stored, so nothing can be replayed — <strong>at-most-once is a storage decision, not a delivery bug.</strong>
              </p>
              <p className="text-dim">your prediction: “{prediction}”</p>
            </>
          )}
        />
      )}
    </div>
  );
}
