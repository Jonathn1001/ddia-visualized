import { useEffect, useState } from 'react';
import { Simulation, type NodeId } from '../../../engine';
import {
  detectStaleRead,
  replication,
  type RepMode,
  type RepPayload,
  type RepState,
} from '../../../modules/replication';
import { SimDriver } from '../../bridge/SimDriver';
import { useSimStore } from '../../bridge/simStore';
import { ChaosToolbar } from '../../kit/ChaosToolbar';
import { ChallengePanel } from '../../kit/ChallengePanel';
import { ClusterView } from '../../kit/ClusterView';
import { KVControls } from '../../kit/KVControls';
import { MetricsPanel } from '../../kit/MetricsPanel';
import { TimelineScrubber } from '../../kit/TimelineScrubber';
import { btn } from '../../kit/classes';

const NODE_IDS = ['L', 'F1', 'F2'];

export function ReplicationLab() {
  const [mode, setMode] = useState<RepMode>('async');
  const [epoch, setEpoch] = useState(0); // bump to rebuild with a fresh seed
  const [driver, setDriver] = useState<SimDriver<RepState, RepPayload> | null>(null);
  // Build the sim/driver in an effect (commit phase), never during render: the
  // SimDriver constructor and the store reset both publish to the shared store,
  // and mutating it mid-render trips React's "cannot update a component while
  // rendering a different component" warning on lab navigation. Rebuilds when
  // mode/epoch change; the cleanup pauses the outgoing driver's rAF loop.
  useEffect(() => {
    useSimStore.getState().reset();
    const seed = 1000 + epoch;
    const sim = new Simulation<RepState, RepPayload>({
      module: replication,
      config: { nodeIds: NODE_IDS, params: { mode } },
      seed,
      network: { latency: [10, 80] },
    });
    const d = new SimDriver({ sim, seed, publish: (v) => useSimStore.getState().publish(v) });
    setDriver(d);
    return () => d.pause();
  }, [mode, epoch]);
  const view = useSimStore();
  if (!driver) return null;

  const statesOf = () =>
    new Map<NodeId, RepState>(
      driver.sim.config.nodeIds.map((id) => [id, driver.sim.getState(id)] as const),
    );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 text-xs font-mono">
        <span>replication:</span>
        {(['async', 'sync'] as const).map((m) => (
          <label key={m} className="flex items-center gap-1">
            <input type="radio" checked={mode === m} onChange={() => setMode(m)} />
            {m}
          </label>
        ))}
        <button className={btn} onClick={() => setEpoch((e) => e + 1)}>
          reset (new seed)
        </button>
        <button
          className={btn}
          onClick={() => {
            const json = driver.exportSession(localStorage.getItem('ddia:ch05:journal') ?? undefined);
            const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = `ddia-ch05-session-${driver.seed}.json`;
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          export session
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
        writeTargets={['L']}
        readTargets={NODE_IDS}
        onWrite={(node, key, value) => driver.external(node, { cmd: 'write', key, value })}
        onRead={(node, key) => driver.external(node, { cmd: 'read', key })}
      />
      <ChaosToolbar
        caps={replication.chaos}
        nodeIds={NODE_IDS}
        deadNodes={view.nodes.filter((n) => n.dead).map((n) => n.id)}
        onAction={(a) => driver.control(a)}
      />
      <ChallengePanel
        title="Chaos Challenge: produce a stale read"
        storageKeyPrefix="ddia:ch05:stale-read"
        prompt="Predict first: how will you cause a stale read? (skippable)"
        runningHint="make a read return older data than an acknowledged write."
        check={() => detectStaleRead(statesOf())}
        onWin={() => driver.pause()}
        renderWin={(win, prediction) => (
          <>
            <p>
              read <code className="text-warn">{win.read.key}</code> @ {win.read.node} returned seq{' '}
              {win.read.returnedSeq} at t={win.read.time}, after write seq {win.ack.seq} was acked at
              t={win.ack.time}.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />
    </div>
  );
}
