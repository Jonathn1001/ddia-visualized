import { useEffect, useState } from 'react';
import { Simulation, type NodeId } from '../../../engine';
import {
  detectHotspot,
  hashring,
  modNMovedCount,
  movedInLatestChange,
  type HRInspect,
  type HRPayload,
  type HRState,
} from '../../../modules/hashring';
import { SimDriver } from '../../bridge/SimDriver';
import { useSimStore } from '../../bridge/simStore';
import { ChaosToolbar } from '../../kit/ChaosToolbar';
import { ChallengePanel } from '../../kit/ChallengePanel';
import { MetricsPanel } from '../../kit/MetricsPanel';
import { RingView, type KeyPlacement } from '../../kit/RingView';
import { TimelineScrubber } from '../../kit/TimelineScrubber';
import { btn, inputBox } from '../../kit/classes';

const NODE_IDS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

export function HashRingLab() {
  const [vnodes, setVnodes] = useState(2);
  const [epoch, setEpoch] = useState(0);
  const [putCount, setPutCount] = useState(24);
  const [nextKey, setNextKey] = useState(0);
  const [addPick, setAddPick] = useState<NodeId>('D');
  const [removePick, setRemovePick] = useState<NodeId>('C');
  const [lastChange, setLastChange] = useState<{ from: NodeId[]; to: NodeId[] } | null>(null);
  const [driver, setDriver] = useState<SimDriver<HRState, HRPayload> | null>(null);
  // Driver-in-effect pattern (PR #2): build the sim in the commit phase, never
  // during render. V is build-time (spec §2) — changing it rebuilds with a
  // fresh seed/epoch, so vnodes joins epoch in the dep list.
  useEffect(() => {
    useSimStore.getState().reset();
    const seed = 6000 + epoch;
    const sim = new Simulation<HRState, HRPayload>({
      module: hashring,
      config: { nodeIds: NODE_IDS, params: { vnodes } },
      seed,
      network: { latency: [10, 80] },
    });
    const d = new SimDriver({ sim, seed, publish: (v) => useSimStore.getState().publish(v) });
    setDriver(d);
    setNextKey(0);
    setLastChange(null);
    return () => d.pause();
  }, [vnodes, epoch]);
  const view = useSimStore();
  if (!driver) return null;

  const statesOf = () =>
    new Map<NodeId, HRState>(
      driver.sim.config.nodeIds.map((id) => [id, driver.sim.getState(id)] as const),
    );

  // Render from the published store view only (one-directional bridge).
  const inspects = new Map(view.nodes.map((n) => [n.id, n.inspect as unknown as HRInspect]));
  const ringView = [...inspects.values()].reduce(
    (a, b) => (b.changeSeq > (a?.changeSeq ?? -1) ? b : a),
    null as HRInspect | null,
  );
  const members = ringView?.members ?? [];
  const placements: KeyPlacement[] = members.flatMap(
    (m) => (inspects.get(m)?.keys ?? []).map((key) => ({ key, owner: m })),
  );
  const coordinator = members[0];
  const addable = NODE_IDS.filter((n) => !members.includes(n));
  // Clamp the picks to the live lists: after a successful add/remove the stored
  // pick leaves its list, and acting on the stale value would feed a corrupted
  // membership (duplicate id in `to`) into modNMovedCount.
  const addSel = addable.includes(addPick) ? addPick : addable[0];
  const removeSel = members.includes(removePick) ? removePick : members[0];
  const allKeys = placements.map((p) => p.key);
  const actualMoved = lastChange ? movedInLatestChange(statesOf()) : 0;
  const modNMoved = lastChange ? modNMovedCount(allKeys, lastChange.from, lastChange.to) : 0;

  const change = (cmd: 'addNode' | 'removeNode', node: NodeId | undefined) => {
    if (!node) return;
    if (cmd === 'addNode' && members.includes(node)) return;
    if (cmd === 'removeNode' && !members.includes(node)) return;
    const to = cmd === 'addNode' ? [...members, node].sort() : members.filter((m) => m !== node);
    setLastChange({ from: members, to });
    driver.external(coordinator, { cmd, node });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
        <label className="flex items-center gap-1">
          vnodes/node (rebuilds)
          <input
            type="range"
            min={1}
            max={100}
            value={vnodes}
            onChange={(e) => setVnodes(Number(e.target.value))}
          />
          {vnodes}
        </label>
        <button className={btn} onClick={() => setEpoch((e) => e + 1)}>
          reset (new seed)
        </button>
        <span className="text-dim">ring: {members.join(' ')} · pool of {NODE_IDS.length}</span>
      </div>
      <TimelineScrubber
        processed={view.processed}
        pending={view.pending}
        running={view.running}
        onPlayPause={() => (view.running ? driver.pause() : driver.start())}
        onStep={() => driver.stepOnce()}
        onScrub={(i) => driver.scrubTo(i)}
      />
      <div className="flex items-start gap-6">
        <RingView pool={NODE_IDS} members={members} vnodes={vnodes} placements={placements} />
        <MetricsPanel history={view.metricsHistory} />
      </div>
      <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
        <input
          type="number"
          min={1}
          max={64}
          className={`w-16 ${inputBox}`}
          value={putCount}
          onChange={(e) => setPutCount(Number(e.target.value))}
          aria-label="key count"
        />
        <button
          className={btn}
          onClick={() => {
            for (let i = 0; i < putCount; i++)
              driver.external(coordinator, { cmd: 'put', key: `k${nextKey + i}` });
            setNextKey((n) => n + putCount);
          }}
        >
          put {putCount} keys
        </button>
        <select className={inputBox} value={addSel} onChange={(e) => setAddPick(e.target.value)}>
          {addable.map((id) => (
            <option key={id}>{id}</option>
          ))}
        </select>
        <button className={btn} disabled={addable.length === 0} onClick={() => change('addNode', addSel)}>
          add node
        </button>
        <select className={inputBox} value={removeSel} onChange={(e) => setRemovePick(e.target.value)}>
          {members.map((id) => (
            <option key={id}>{id}</option>
          ))}
        </select>
        <button
          className={btn}
          disabled={members.length <= 1}
          onClick={() => change('removeNode', removeSel)}
        >
          remove node
        </button>
      </div>
      {lastChange && (
        <p className="font-mono text-xs text-fg">
          last change: ring moved <span className="text-set font-bold">{actualMoved}</span> keys ·{' '}
          naive <code>hash mod N</code> would move{' '}
          <span className="text-warn font-bold">{modNMoved}</span> of {allKeys.length}
        </p>
      )}
      <ChaosToolbar
        caps={hashring.chaos}
        nodeIds={NODE_IDS}
        deadNodes={view.nodes.filter((n) => n.dead).map((n) => n.id)}
        onAction={(a) => driver.control(a)}
      />
      <ChallengePanel
        title="Chaos Challenge: create a hotspot"
        storageKeyPrefix="ddia:ch06:hotspot"
        prompt="Predict first: how will you make one node carry ≥2× its fair share? (skippable)"
        runningHint="low vnodes make big arcs — put keys, then shrink the ring so one node inherits its neighbours."
        check={() => detectHotspot(statesOf())}
        onWin={() => driver.pause()}
        renderWin={(win, prediction) => (
          <>
            <p>
              node <code className="text-warn">{win.node}</code> holds {win.load} keys — fair share
              is {win.fairShare.toFixed(1)}. One node is doing {(win.load / win.fairShare).toFixed(1)}×
              its share of the work. Now raise vnodes (rebuild) or add a node and watch{' '}
              <code>max-load-ratio</code> fall.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />
    </div>
  );
}
