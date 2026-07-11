import { useEffect, useState } from 'react';
import { Simulation, type NodeId } from '../../../engine';
import {
  detectLostWrite,
  multiLeader,
  type MLPayload,
  type MLState,
} from '../../../modules/multileader';
import { SimDriver } from '../../bridge/SimDriver';
import { useSimStore } from '../../bridge/simStore';
import { ChaosToolbar } from '../../kit/ChaosToolbar';
import { ChallengePanel } from '../../kit/ChallengePanel';
import { ClusterView } from '../../kit/ClusterView';
import { KVControls } from '../../kit/KVControls';
import { MetricsPanel } from '../../kit/MetricsPanel';
import { TimelineScrubber } from '../../kit/TimelineScrubber';
import { btn } from '../../kit/classes';

const NODE_IDS = ['DC1', 'DC2'];

export function MultiLeaderLab() {
  const [epoch, setEpoch] = useState(0);
  const [driver, setDriver] = useState<SimDriver<MLState, MLPayload> | null>(null);
  // Build the sim/driver in an effect (commit phase), never during render: the
  // SimDriver constructor and the store reset both publish to the shared store,
  // and mutating it mid-render trips React's "cannot update a component while
  // rendering a different component" warning on lab navigation. Rebuilds when
  // epoch changes; the cleanup pauses the outgoing driver's rAF loop.
  useEffect(() => {
    useSimStore.getState().reset();
    const seed = 2000 + epoch;
    const sim = new Simulation<MLState, MLPayload>({
      module: multiLeader,
      config: { nodeIds: NODE_IDS },
      seed,
      network: { latency: [30, 120] }, // wide window: concurrent writes are easy to produce
    });
    const d = new SimDriver({ sim, seed, publish: (v) => useSimStore.getState().publish(v) });
    setDriver(d);
    return () => d.pause();
  }, [epoch]);
  const view = useSimStore();
  if (!driver) return null;

  const statesOf = () =>
    new Map<NodeId, MLState>(
      driver.sim.config.nodeIds.map((id) => [id, driver.sim.getState(id)] as const),
    );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 text-xs font-mono">
        <span>two leaders, async cross-replication, LWW</span>
        <button className={btn} onClick={() => setEpoch((e) => e + 1)}>
          reset (new seed)
        </button>
      </div>
      <TimelineScrubber
        processed={view.processed}
        pending={view.pending}
        running={view.running}
        onPlayPause={() => (view.running ? driver.pause() : driver.start())}
        onStep={() => driver.stepOnce()}
        onScrub={(i) => driver.scrubTo(i)}
      />
      <div className="flex gap-6 items-start">
        <ClusterView nodes={view.nodes} inFlight={view.inFlight} time={view.time} />
        <MetricsPanel history={view.metricsHistory} />
      </div>
      <KVControls
        writeTargets={NODE_IDS}
        readTargets={NODE_IDS}
        onWrite={(node, key, value) => driver.external(node, { cmd: 'write', key, value })}
        onRead={(node, key) => driver.external(node, { cmd: 'read', key })}
      />
      <ChaosToolbar
        caps={multiLeader.chaos}
        nodeIds={NODE_IDS}
        deadNodes={view.nodes.filter((n) => n.dead).map((n) => n.id)}
        onAction={(a) => driver.control(a)}
      />
      <ChallengePanel
        title="Chaos Challenge: make an acked write silently disappear"
        storageKeyPrefix="ddia:ch05:lost-write"
        prompt="Predict first: how do two leaders lose an acknowledged write? (skippable)"
        runningHint="get a write acked at one leader, then have LWW throw it away."
        check={() => detectLostWrite(statesOf())}
        onWin={() => driver.pause()}
        renderWin={(win, prediction) => (
          <>
            <p>
              write <code className="text-warn">{win.discarded.key}={win.discarded.value}</code> was
              acked at {win.ack.origin} (t={win.ack.time}), then LWW discarded it — the concurrent
              write with the higher (ts, origin) won everywhere. No error was ever shown.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />
    </div>
  );
}
