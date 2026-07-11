import { useEffect, useState } from 'react';
import { Simulation, type NodeId } from '../../../engine';
import {
  detectLostAckedWrite,
  leaderless,
  type LLPayload,
  type LLState,
} from '../../../modules/leaderless';
import { SimDriver } from '../../bridge/SimDriver';
import { useSimStore } from '../../bridge/simStore';
import { ChaosToolbar } from '../../kit/ChaosToolbar';
import { ChallengePanel } from '../../kit/ChallengePanel';
import { ClusterView } from '../../kit/ClusterView';
import { KVControls } from '../../kit/KVControls';
import { MetricsPanel } from '../../kit/MetricsPanel';
import { TimelineScrubber } from '../../kit/TimelineScrubber';
import { btn, inputBox } from '../../kit/classes';

const NODE_IDS = ['A', 'B', 'C', 'D', 'E'];

export function LeaderlessLab() {
  const [w, setW] = useState(2);
  const [r, setR] = useState(2);
  const [sloppy, setSloppy] = useState(false);
  const [coordinator, setCoordinator] = useState<NodeId>('A');
  const [epoch, setEpoch] = useState(0);
  const [driver, setDriver] = useState<SimDriver<LLState, LLPayload> | null>(null);
  // Build the sim/driver in an effect (commit phase), never during render: the
  // SimDriver constructor and the store reset both publish to the shared store,
  // and mutating it mid-render trips React's "cannot update a component while
  // rendering a different component" warning on lab navigation. Rebuilds when
  // w/r/sloppy/epoch change (coordinator only retargets buttons, so it is not a
  // dep); the cleanup pauses the outgoing driver's rAF loop.
  useEffect(() => {
    useSimStore.getState().reset();
    const seed = 3000 + epoch;
    const sim = new Simulation<LLState, LLPayload>({
      module: leaderless,
      config: { nodeIds: NODE_IDS, params: { w, r, sloppy } },
      seed,
      network: { latency: [10, 80] },
    });
    const d = new SimDriver({ sim, seed, publish: (v) => useSimStore.getState().publish(v) });
    setDriver(d);
    return () => d.pause();
  }, [w, r, sloppy, epoch]);
  const view = useSimStore();
  if (!driver) return null;

  const statesOf = () =>
    new Map<NodeId, LLState>(
      driver.sim.config.nodeIds.map((id) => [id, driver.sim.getState(id)] as const),
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-xs font-mono">
        <span>home replicas: A B C · fallbacks: D E · n=3</span>
        <label className="flex items-center gap-1">
          w
          <input type="range" min={1} max={3} value={w} onChange={(e) => setW(Number(e.target.value))} />
          {w}
        </label>
        <label className="flex items-center gap-1">
          r
          <input type="range" min={1} max={3} value={r} onChange={(e) => setR(Number(e.target.value))} />
          {r}
        </label>
        <span className={w + r > 3 ? 'text-set' : 'text-sign'}>
          w+r{w + r > 3 ? '>' : '≤'}n {w + r > 3 ? '(overlap guaranteed)' : '(stale reads possible)'}
        </span>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={sloppy} onChange={(e) => setSloppy(e.target.checked)} />
          sloppy quorum
        </label>
        <label className="flex items-center gap-1">
          coordinator
          <select className={inputBox} value={coordinator} onChange={(e) => setCoordinator(e.target.value)}>
            {NODE_IDS.map((id) => (
              <option key={id}>{id}</option>
            ))}
          </select>
        </label>
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
        writeTargets={[coordinator]}
        readTargets={[coordinator]}
        onWrite={(node, key, value) => driver.external(node, { cmd: 'write', key, value })}
        onRead={(node, key) => driver.external(node, { cmd: 'read', key })}
      />
      <ChaosToolbar
        caps={leaderless.chaos}
        nodeIds={NODE_IDS}
        deadNodes={view.nodes.filter((n) => n.dead).map((n) => n.id)}
        onAction={(a) => driver.control(a)}
      />
      <ChallengePanel
        title="Chaos Challenge: sloppy quorum loses an acked write"
        storageKeyPrefix="ddia:ch05:sloppy-loss"
        prompt="Predict first: how does a sloppy-quorum ack lose data? (skippable)"
        runningHint="get a write acked through hints, then destroy every copy before handoff."
        check={() => detectLostAckedWrite(statesOf(), driver.sim.deadNodes())}
        onWin={() => driver.pause()}
        renderWin={(win, prediction) => (
          <>
            <p>
              write <code className="text-warn">{win.ack.key}</code> was acked at {win.coordinator}{' '}
              (t={win.ack.time}) — but every node holding it is dead. The sloppy quorum promised
              durability it could not keep.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />
    </div>
  );
}
