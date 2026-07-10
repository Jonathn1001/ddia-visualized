import { useEffect, useRef, useState } from 'react';
import { Simulation } from '../../../engine';
import { replication, type RepMode, type RepPayload, type RepState } from '../../../modules/replication';
import { SimDriver } from '../../bridge/SimDriver';
import { useSimStore } from '../../bridge/simStore';
import { ChaosToolbar } from '../../kit/ChaosToolbar';
import { ClusterView } from '../../kit/ClusterView';
import { MetricsPanel } from '../../kit/MetricsPanel';
import { TimelineScrubber } from '../../kit/TimelineScrubber';
import { ChallengePanel } from './ChallengePanel';
import { ClientControls } from './ClientControls';

const NODE_IDS = ['L', 'F1', 'F2'];

export function ReplicationLab() {
  const [mode, setMode] = useState<RepMode>('async');
  const [epoch, setEpoch] = useState(0); // bump to rebuild with a fresh seed
  const ref = useRef<{ driver: SimDriver<RepState, RepPayload>; key: string } | null>(null);
  const simKey = `${mode}:${epoch}`;
  if (!ref.current || ref.current.key !== simKey) {
    ref.current?.driver.pause();
    useSimStore.getState().reset();
    const seed = 1000 + epoch;
    const sim = new Simulation<RepState, RepPayload>({
      module: replication,
      config: { nodeIds: NODE_IDS, params: { mode } },
      seed,
      network: { latency: [10, 80] },
    });
    ref.current = {
      driver: new SimDriver({ sim, seed, publish: (v) => useSimStore.getState().publish(v) }),
      key: simKey,
    };
  }
  const driver = ref.current.driver;
  useEffect(() => () => driver.pause(), [driver]);
  const view = useSimStore();

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
        <button
          className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-600"
          onClick={() => setEpoch((e) => e + 1)}
        >
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
      <ClientControls
        nodeIds={NODE_IDS}
        leader="L"
        onWrite={(key, value) => driver.external('L', { cmd: 'write', key, value })}
        onRead={(node, key) => driver.external(node, { cmd: 'read', key })}
      />
      <ChaosToolbar
        caps={replication.chaos}
        nodeIds={NODE_IDS}
        deadNodes={view.nodes.filter((n) => n.dead).map((n) => n.id)}
        onAction={(a) => driver.control(a)}
      />
      <ChallengePanel driver={driver} />
    </div>
  );
}
