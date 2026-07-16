// src/modules/raft-lesson.test.ts
// The Ch9 lesson, pinned: a minority-partitioned leader can't commit, a majority
// elects a successor, the deposed leader keeps answering — and answering stale —
// until the checker (and then the heal) catches up with it. Deliberately inlines
// its own fresh/until/st helpers rather than importing raft.test.ts: this is the
// challenge-verifier contract, and it must stand on its own.
import { expect, test } from 'vitest';
import { Simulation } from '../engine';
import { checkLinearizable } from './linearizable';
import { completedOps, mergedHistory, raft, type RaftState } from './raft';
import { RAFT_NODES, type RaftPayload } from './raft-shared';

function fresh(seed = 9042) {
  const sim = new Simulation<RaftState, RaftPayload>({
    module: raft,
    config: { nodeIds: RAFT_NODES },
    seed,
  });
  sim.runSteps(RAFT_NODES.length); // inits arm election timers
  return sim;
}

const st = (sim: ReturnType<typeof fresh>, id: string) => sim.getState(id);
const leaders = (sim: ReturnType<typeof fresh>) => RAFT_NODES.filter((n) => st(sim, n).role === 'leader');

/** Run until cond or event budget dry (loud on failure). */
function until(sim: ReturnType<typeof fresh>, cond: () => boolean, budget = 20000) {
  for (let i = 0; i < budget && !cond(); i++) {
    if (sim.pending === 0) break;
    sim.runSteps(1);
  }
  if (!cond()) throw new Error(`until(): not reached (time=${sim.time}, pending=${sim.pending})`);
}

test('the Ch9 lesson: minority partition → stale read → checker violation → heal → checker ok', () => {
  const sim = fresh(9042);

  // elect: exactly one leader
  until(sim, () => leaders(sim).length === 1);
  const old = leaders(sim)[0];
  expect(st(sim, old).term).toBeGreaterThanOrEqual(1);

  // write 1 at the leader — commits
  sim.external(old, { cmd: 'write', value: 1 });
  until(sim, () => st(sim, old).commitIndex >= 1, 6000);
  expect(st(sim, old).kv).toBe(1);
  const write1 = st(sim, old).history.find((h) => h.op === 'write' && h.value === 1);
  expect(write1?.outcome).toBe('ok');

  // partition the leader ALONE — a minority of one
  const others = RAFT_NODES.filter((n) => n !== old);
  sim.control({ type: 'partition', groups: [[old], others] });

  // write 99 at the old leader — appended locally but stuck pending; a minority
  // of one can never reach a majority ack, so it can never commit
  sim.external(old, { cmd: 'write', value: 99 });
  until(sim, () => st(sim, old).history.some((h) => h.op === 'write' && h.value === 99), 200);
  const write99 = st(sim, old).history.find((h) => h.op === 'write' && h.value === 99);
  expect(write99?.outcome).toBe('pending');
  expect(st(sim, old).commitIndex).toBe(1); // unchanged — only write 1 is committed

  // the majority (everyone but the isolated old leader) elects a successor
  until(sim, () => others.some((n) => st(sim, n).role === 'leader'), 20000);
  const neo = others.find((n) => st(sim, n).role === 'leader') as string;
  expect(st(sim, neo).term).toBeGreaterThan(st(sim, old).term); // old is alone: its term never moves

  // write 2 at the new leader — commits on the majority
  sim.external(neo, { cmd: 'write', value: 2 });
  until(sim, () => st(sim, neo).commitIndex >= 2, 8000);
  expect(st(sim, neo).kv).toBe(2);
  const write2 = st(sim, neo).history.find((h) => h.op === 'write' && h.value === 2);
  expect(write2?.outcome).toBe('ok');

  // the old leader still believes it's in charge; it serves its stale register
  // straight off — no quorum round. The module's client-op timer hop guarantees
  // this read's invokedAt lands strictly after write 2's settle tick.
  sim.external(old, { cmd: 'read' });
  until(sim, () => st(sim, old).history.some((h) => h.op === 'read'), 200);
  const staleRead = st(sim, old).history.find((h) => h.op === 'read');
  expect(staleRead?.outcome).toBe('ok'); // the old leader answers — it doesn't know it's deposed
  expect(staleRead?.value).toBe(1); // stale: write 2 already committed elsewhere

  // the checker sees write 1 → write 2 → (real-time-later) read 1 and flags it
  const preHealStates = new Map(RAFT_NODES.map((n) => [n, st(sim, n)] as const));
  const preHealOps = completedOps(mergedHistory(preHealStates));
  expect(checkLinearizable(preHealOps).verdict).toBe('violation');

  // heal the partition
  sim.control({ type: 'heal' });

  // the old leader steps down and converges on the majority's log
  until(sim, () => st(sim, old).role === 'follower' && st(sim, old).kv === 2, 20000);
  // its dangling write-99 entry got truncated by the real leader's log — lost
  until(sim, () => st(sim, old).history.find((h) => h.op === 'write' && h.value === 99)?.outcome === 'lost', 6000);

  // logs converge: same index + same term → same entry, everywhere
  for (const a of RAFT_NODES) {
    for (const b of RAFT_NODES) {
      const la = st(sim, a).log;
      const lb = st(sim, b).log;
      for (let i = 0; i < Math.min(la.length, lb.length); i++) {
        if (la[i].term === lb[i].term) expect(la[i].seq).toBe(lb[i].seq);
      }
    }
  }
  // committed prefixes are identical everywhere they overlap
  const commit = st(sim, neo).commitIndex;
  for (const n of RAFT_NODES) {
    const s = st(sim, n);
    for (let i = 0; i < Math.min(commit, s.commitIndex); i++) {
      expect(s.log[i].seq).toBe(st(sim, neo).log[i].seq);
    }
  }

  // post-heal, the same history minus the stale read is linearizable again —
  // the checker's verdict was specifically about that one read, nothing else
  const postHealStates = new Map(RAFT_NODES.map((n) => [n, st(sim, n)] as const));
  const postHealOps = completedOps(mergedHistory(postHealStates));
  const withoutStaleRead = postHealOps.filter((o) => !(o.op === 'read' && o.value === 1));
  expect(checkLinearizable(withoutStaleRead).verdict).toBe('ok');
});
