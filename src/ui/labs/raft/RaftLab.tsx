// src/ui/labs/raft/RaftLab.tsx
import { useEffect, useState } from 'react';
import { Simulation, type NodeId } from '../../../engine';
import { checkLinearizable, type Verdict } from '../../../modules/linearizable';
import { completedOps, mergedHistory, raft, type RaftInspect, type RaftState } from '../../../modules/raft';
import { CHECK_CAP, RAFT_NODES } from '../../../modules/raft-shared';
import { SimDriver } from '../../bridge/SimDriver';
import { useSimStore } from '../../bridge/simStore';
import { ChallengePanel } from '../../kit/ChallengePanel';
import { ChaosToolbar } from '../../kit/ChaosToolbar';
import { MetricsPanel } from '../../kit/MetricsPanel';
import { TimelineScrubber } from '../../kit/TimelineScrubber';
import { btn, inputBox } from '../../kit/classes';
import { HistoryPanel } from './HistoryPanel';
import { RaftView } from './RaftView';

export function RaftLab() {
  const [epoch, setEpoch] = useState(0);
  const [driver, setDriver] = useState<SimDriver<RaftState> | null>(null);
  const [selectedNode, setSelectedNode] = useState<NodeId>(RAFT_NODES[0]);
  const [writeValue, setWriteValue] = useState(1);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  // Challenge gates, engine-verified wins still require the UI flag to have
  // fired first this epoch (Ch3/Ch8 lesson: no auto-win off a stale state).
  const [partitionedFlag, setPartitionedFlag] = useState(false);
  const [healedFlag, setHealedFlag] = useState(false);

  useEffect(() => {
    useSimStore.getState().reset();
    const seed = 9000 + epoch;
    const sim = new Simulation<RaftState>({ module: raft, config: { nodeIds: RAFT_NODES }, seed });
    const d = new SimDriver({ sim, seed, publish: (v) => useSimStore.getState().publish(v) });
    // Drain exactly the RAFT_NODES.length init events so every node's election
    // timer is armed (raft.test.ts `fresh()` precedent). Unlike LeaseLab's
    // `while (pending > 0)` drain, Raft's timers never settle to zero —
    // heartbeats and election retries re-arm forever — so an unbounded drain
    // here would hang the mount effect.
    for (let i = 0; i < RAFT_NODES.length; i++) d.stepOnce();
    setDriver(d);
    setSelectedNode(RAFT_NODES[0]);
    setWriteValue(1);
    setVerdict(null);
    setPartitionedFlag(false);
    setHealedFlag(false);
    return () => d.pause();
  }, [epoch]);

  const view = useSimStore();
  if (!driver) return null;

  const nodeIds = driver.sim.config.nodeIds;
  const allStates = () => nodeIds.map((id) => driver.sim.getState(id));

  const states = new Map(nodeIds.map((id) => [id, driver.sim.getState(id)] as const));
  const rows = mergedHistory(states);
  const ops = completedOps(rows);
  const capped = ops.length > CHECK_CAP;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
        <button className={btn} onClick={() => setEpoch((e) => e + 1)}>reset (new seed)</button>
        <button data-action="lab-step" className={btn} onClick={() => driver.stepOnce()}>step</button>
        <span className="text-dim">reads are served from the leader's local register — no quorum round</span>
      </div>

      <TimelineScrubber
        processed={view.processed}
        pending={view.pending}
        running={view.running}
        onPlayPause={() => (view.running ? driver.pause() : driver.start())}
        onStep={() => driver.stepOnce()}
        onScrub={(i) => {
          // forward only: a backward scrub can't be replayed against the
          // React-side challenge flags (partitionedFlag/healedFlag), which
          // survive the scrub and would desync from the replayed sim
          if (i >= view.processed) driver.scrubTo(i);
        }}
      />

      <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
        <span className="text-dim">client:</span>
        <select
          data-control="node"
          className={inputBox}
          value={selectedNode}
          onChange={(e) => setSelectedNode(e.target.value)}
        >
          {nodeIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <button
          data-action="client-write"
          className={btn}
          onClick={() => {
            driver.external(selectedNode, { cmd: 'write', value: writeValue });
            setWriteValue((v) => v + 1);
          }}
        >
          write {writeValue}
        </button>
        <button data-action="client-read" className={btn} onClick={() => driver.external(selectedNode, { cmd: 'read' })}>
          read
        </button>
      </div>

      <RaftView
        nodes={view.nodes.map((n) => n.inspect as unknown as RaftInspect)}
        deadNodes={view.nodes.filter((n) => n.dead).map((n) => n.id)}
      />

      <div className="flex flex-wrap items-start gap-4">
        <HistoryPanel rows={rows} verdict={verdict} capped={capped} onCheck={() => setVerdict(checkLinearizable(ops))} />
        <MetricsPanel history={view.metricsHistory} />
      </div>

      <ChaosToolbar
        caps={raft.chaos}
        nodeIds={nodeIds}
        deadNodes={view.nodes.filter((n) => n.dead).map((n) => n.id)}
        onAction={(a) => {
          driver.control(a);
          if (a.type === 'partition') setPartitionedFlag(true);
          if (a.type === 'heal' && partitionedFlag) setHealedFlag(true);
        }}
      />

      <ChallengePanel
        title="Challenge: the minority cannot decide"
        storageKeyPrefix="ddia:ch09:minority"
        prompt="Partition the cluster so the current leader ends up on the smaller side (fewer than 3 nodes). Predict: what happens to a write sent to the isolated leader?"
        runningHint="partition: check the leader (and maybe one more) to isolate it → write @ the isolated leader → step until the majority side elects a new leader with a higher term."
        check={() => {
          if (!partitionedFlag) return null;
          const all = allStates();
          for (const s of all) {
            const pending = s.history.find((h) => h.op === 'write' && h.outcome === 'pending');
            if (!pending) continue;
            const higherLeader = all.find((o) => o.role === 'leader' && o.term > s.term);
            if (higherLeader) return { stuck: s.id, stuckTerm: s.term, leader: higherLeader.id, leaderTerm: higherLeader.term };
          }
          return null;
        }}
        onWin={() => driver.pause()}
        renderWin={(w, prediction) => (
          <>
            <p>
              {w.stuck}'s write never got a majority of acks — it can't, stuck alone (or with one buddy) on the
              minority side. Meanwhile the other side, seeing no heartbeats, elected {w.leader} at term{' '}
              {w.leaderTerm} (higher than {w.stuck}'s term {w.stuckTerm}) and kept going without it. No quorum,
              no commit — that's the safety half of Raft's majority rule.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />

      <ChallengePanel
        title="Challenge: heal and repent"
        storageKeyPrefix="ddia:ch09:heal"
        prompt="Same partition. Let the isolated leader accept one more write, then let the majority side elect and commit one of its own — and heal. Predict: what happens to the isolated leader's dangling write?"
        runningHint="partition isolating the leader → write @ it (goes pending) → step until the majority elects a successor and commits its own write → heal → step until the old leader rejoins as a follower."
        check={() => {
          if (!healedFlag) return null;
          const all = allStates();
          if (!all.some((s) => s.history.some((h) => h.outcome === 'lost'))) return null;
          for (let i = 0; i < all.length; i++) {
            for (let j = i + 1; j < all.length; j++) {
              const a = all[i];
              const b = all[j];
              const minC = Math.min(a.commitIndex, b.commitIndex);
              for (let k = 0; k < minC; k++) {
                if (a.log[k]?.seq !== b.log[k]?.seq) return null;
              }
            }
          }
          return { ok: true };
        }}
        onWin={() => driver.pause()}
        renderWin={(_w, prediction) => (
          <>
            <p>
              On rejoining, the old leader hears a higher term and steps down — its dangling entry was never
              acknowledged by a majority, so the new leader's AppendEntries truncates it on contact. Every node's
              committed prefix agrees, right up to the last index they share: the log-matching property, restored.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />

      <ChallengePanel
        title="Challenge: catch the stale read"
        storageKeyPrefix="ddia:ch09:stale"
        prompt="Commit a write, then partition the leader alone and let the majority elect a successor and commit a new value. Now read straight from the old (isolated) leader — before it notices anything's wrong. Predict: what value comes back, and does the checker call it linearizable?"
        runningHint="write @ leader → step to commit → partition isolating the leader alone → step until a successor commits a new write → read @ the old leader → check linearizability."
        check={() => (verdict && verdict.verdict === 'violation' ? verdict : null)}
        onWin={() => driver.pause()}
        renderWin={(_w, prediction) => (
          <>
            <p>
              The old leader still believes it's in charge, so it answered the read straight from its local
              register — no quorum round, no check that anyone still follows it. The checker found no
              real-time-consistent order for the observed values: that stale read is the linearizability gap this
              module was built to expose.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />
    </div>
  );
}
