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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MODULES: Record<BrokerMode, SimModule<any, any>> = {
  kafka: kafkalog,
  rabbit: rabbitqueue,
  redis: redispubsub,
};

const LABELS: Record<BrokerMode, string> = { kafka: 'Kafka', rabbit: 'RabbitMQ', redis: 'Redis' };

function tripleFor(mode: BrokerMode, states: Map<NodeId, unknown>): Triple {
  if (mode === 'kafka') return kafkaTriple(states as Map<NodeId, KafkaState>);
  if (mode === 'rabbit') return rabbitTriple(states as Map<NodeId, RabbitState>);
  return redisTriple(states as Map<NodeId, RedisState>);
}

/**
 * A single broker's flow (spec §1, three-separate-flows layout). One module, one
 * chaos challenge. Kafka / RabbitMQ / Redis each mount this with a fixed `mode`;
 * the delivery guarantee falls out of what that broker stores and acks.
 */
export function BrokersLab({ mode }: { mode: BrokerMode }) {
  const [epoch, setEpoch] = useState(0);
  const [nextKey, setNextKey] = useState(0);
  const [driver, setDriver] = useState<SimDriver<unknown, unknown> | null>(null);

  // Epoch-rebuild (Ch6): build the sim in the commit phase. `mode` is fixed per
  // page, so there is no tab-desync; reset() bumps the seed.
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
    d.setSpeed(5); // gentle animation so a consumer can be killed mid-flight
    setDriver(d);
    setNextKey(0);
    return () => d.pause();
  }, [mode, epoch]);

  const view = useSimStore();

  const statesOf = (d: SimDriver<unknown, unknown>) =>
    new Map<NodeId, unknown>(BROKER_TOPOLOGY.map((id) => [id, d.sim.getState(id)] as const));

  if (!driver) return null;

  const brokerNode = view.nodes.find((n) => n.id === 'B');
  const broker = brokerNode?.inspect as Record<string, unknown> | undefined;
  const consumers: ConsumerView[] = CONSUMERS.map((id) => {
    const n = view.nodes.find((nn) => nn.id === id);
    const processed = ((n?.inspect as { processed?: string[] } | undefined)?.processed ?? []) as string[];
    return { id, dead: n?.dead ?? false, processed };
  });

  const live = tripleFor(mode, statesOf(driver));

  const produce = () => {
    for (let i = 0; i < 12; i++) driver.external('P', { cmd: 'produce', key: `m${nextKey + i}` });
    setNextKey((n) => n + 12);
    // Queue the work; the learner drives it with play/step (Ch6 pattern) so a
    // consumer can be killed mid-flight — the whole point of the challenge.
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
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
        <BrokerInternals mode={mode} broker={broker} consumers={consumers} />
        <MetricsPanel history={view.metricsHistory} />
      </div>

      <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
        <button className={btnPrimary} onClick={produce}>
          produce 12
        </button>
        <p className="text-fg">
          {LABELS[mode]}: <span className="text-set font-bold">{live.delivered}</span> delivered ·{' '}
          <span className={live.duplicates > 0 ? 'text-warn font-bold' : ''}>{live.duplicates}</span> duplicates ·{' '}
          <span className={live.lost > 0 ? 'text-warn font-bold' : ''}>{live.lost}</span> lost{' '}
          <span className="text-dim">of {live.produced} produced</span>
        </p>
      </div>

      <ChaosToolbar
        caps={MODULES[mode].chaos}
        nodeIds={BROKER_TOPOLOGY}
        deadNodes={view.nodes.filter((n) => n.dead).map((n) => n.id)}
        onAction={(a) => driver.control(a)}
      />

      {mode === 'kafka' && (
        <ChallengePanel
          title="Chaos Challenge — Make it twice"
          storageKeyPrefix="ddia:ch11:kafka-dup"
          prompt="Predict first: how will you make the group process one message twice? (skippable)"
          runningHint="produce 12, tap step to start delivering, kill C1 mid-flight, then play — the rebalance replays uncommitted offsets to the survivor."
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
      {mode === 'rabbit' && (
        <ChallengePanel
          title="Chaos Challenge — Resurrect a message"
          storageKeyPrefix="ddia:ch11:rabbit-redeliver"
          prompt="Predict first: kill a consumer holding an unacked message — what happens to it? (skippable)"
          runningHint="produce, tap step until a message is delivered to C1, kill C1 before it acks, then play — the ack timeout requeues it to the other consumer."
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
      {mode === 'redis' && (
        <ChallengePanel
          title="Chaos Challenge — Lose it forever"
          storageKeyPrefix="ddia:ch11:redis-lost"
          prompt="Predict first: kill a subscriber, publish, revive it — does it catch up? (skippable)"
          runningHint="kill a subscriber, produce 12, press play to drain, then revive it — nothing was stored, so the missed messages are gone."
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
