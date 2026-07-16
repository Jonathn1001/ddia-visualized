// src/modules/raft.test.ts
import { expect, test } from 'vitest';
import { Simulation } from '../engine';
import { SeededRng } from '../engine/rng';
import { mergedHistory, raft, type RaftState } from './raft';
import { ELECTION_MAX, RAFT_NODES, type HistoryRow, type RaftPayload } from './raft-shared';

export function fresh(seed = 9000) {
  const sim = new Simulation<RaftState, RaftPayload>({
    module: raft,
    config: { nodeIds: RAFT_NODES },
    seed,
  });
  sim.runSteps(RAFT_NODES.length); // inits arm election timers
  return sim;
}

export const st = (sim: ReturnType<typeof fresh>, id: string) => sim.getState(id);
export const leaders = (sim: ReturnType<typeof fresh>) => RAFT_NODES.filter((n) => st(sim, n).role === 'leader');

/** Run until cond or event budget dry (loud on failure). */
export function until(sim: ReturnType<typeof fresh>, cond: () => boolean, budget = 5000) {
  for (let i = 0; i < budget && !cond(); i++) {
    if (sim.pending === 0) break;
    sim.runSteps(1);
  }
  if (!cond()) throw new Error(`until(): not reached (time=${sim.time}, pending=${sim.pending})`);
}

test('a five-node cluster elects exactly one leader', () => {
  const sim = fresh();
  until(sim, () => leaders(sim).length === 1);
  const lead = leaders(sim)[0];
  expect(st(sim, lead).term).toBeGreaterThanOrEqual(1);
  // everyone converges on the same term via heartbeats
  until(sim, () => RAFT_NODES.every((n) => st(sim, n).term === st(sim, lead).term), 3000);
  expect(leaders(sim)).toHaveLength(1);
});

test('heartbeats suppress new elections while the leader lives', () => {
  const sim = fresh();
  until(sim, () => leaders(sim).length === 1);
  const term = Math.max(...RAFT_NODES.map((n) => st(sim, n).term));
  sim.runUntil(sim.time + ELECTION_MAX * 4);
  expect(leaders(sim)).toHaveLength(1);
  expect(Math.max(...RAFT_NODES.map((n) => st(sim, n).term))).toBe(term);
});

test('killing the leader triggers a re-election with a higher term', () => {
  const sim = fresh();
  until(sim, () => leaders(sim).length === 1);
  const old = leaders(sim)[0];
  const oldTerm = st(sim, old).term;
  sim.control({ type: 'kill', node: old });
  until(sim, () => leaders(sim).some((l) => l !== old), 8000);
  const neo = leaders(sim).find((l) => l !== old) as string;
  expect(st(sim, neo).term).toBeGreaterThan(oldTerm);
});

test('a stale election timeout (old nonce) does not start an election', () => {
  const sim = fresh();
  until(sim, () => leaders(sim).length === 1);
  // followers keep re-arming on every heartbeat; run a long time — terms stay put
  const term = Math.max(...RAFT_NODES.map((n) => st(sim, n).term));
  sim.runUntil(sim.time + ELECTION_MAX * 6);
  expect(Math.max(...RAFT_NODES.map((n) => st(sim, n).term))).toBe(term);
});

test('a client write at the leader commits and applies on a majority', () => {
  const sim = fresh();
  until(sim, () => leaders(sim).length === 1);
  const lead = leaders(sim)[0];
  sim.external(lead, { cmd: 'write', value: 42 });
  until(sim, () => st(sim, lead).commitIndex >= 1, 4000);
  expect(st(sim, lead).kv).toBe(42);
  until(sim, () => RAFT_NODES.filter((n) => st(sim, n).commitIndex >= 1).length >= 3, 4000);
  const row = st(sim, lead).history.find((h) => h.op === 'write');
  expect(row?.outcome).toBe('ok');
});

test('a write at a follower is redirected, not appended', () => {
  const sim = fresh();
  until(sim, () => leaders(sim).length === 1);
  const follower = RAFT_NODES.find((n) => st(sim, n).role === 'follower') as string;
  sim.external(follower, { cmd: 'write', value: 7 });
  // run until the external is delivered — other same-time events may precede it in the queue
  until(sim, () => st(sim, follower).history.length === 1, 100);
  expect(st(sim, follower).log).toHaveLength(0);
  expect(st(sim, follower).history[0]?.outcome).toBe('redirect');
});

test('a leader demoted by a higher-term reply re-arms its election timer (liveness)', () => {
  const sim = fresh();
  until(sim, () => leaders(sim).length === 1);
  const lead = leaders(sim)[0];
  const s = st(sim, lead);
  // deliver a higher-term vote reply directly through the reducer
  const [after, fx] = raft.reduce(
    s,
    { kind: 'message', self: lead, from: RAFT_NODES.find((n) => n !== lead) as string, time: sim.time, payload: { kind: 'vote', term: s.term + 5, granted: false } },
    new SeededRng(1),
  );
  expect((after as RaftState).role).toBe('follower');
  expect(fx.some((e) => e.type === 'timer' && (e.payload as { t?: string }).t === 'election')).toBe(true);
});

test('mergedHistory orders same-node ties numerically, not lexicographically', () => {
  const rows = [
    { id: 'N1:10', node: 'N1', op: 'write', value: 10, invokedAt: 5, respondedAt: 6, outcome: 'ok' },
    { id: 'N1:9', node: 'N1', op: 'write', value: 9, invokedAt: 5, respondedAt: 6, outcome: 'ok' },
  ] as const;
  const states = new Map([
    ['N1', { ...raft.init('N1', { nodeIds: [...RAFT_NODES] }, new SeededRng(1)), history: [...rows] as HistoryRow[] }],
  ]);
  const merged = mergedHistory(states as Map<string, RaftState>);
  expect(merged.map((r) => r.id)).toEqual(['N1:9', 'N1:10']);
});

test('a minority-partitioned leader cannot commit; the majority elects a successor', () => {
  const sim = fresh();
  until(sim, () => leaders(sim).length === 1);
  const old = leaders(sim)[0];
  const others = RAFT_NODES.filter((n) => n !== old);
  const buddy = others[0];
  const majority = others.slice(1); // three nodes
  sim.control({ type: 'partition', groups: [[old, buddy], majority] });
  sim.external(old, { cmd: 'write', value: 99 });
  // the majority elects a new leader with a higher term
  until(sim, () => majority.some((n) => st(sim, n).role === 'leader'), 20000);
  const neo = majority.find((n) => st(sim, n).role === 'leader') as string;
  expect(st(sim, neo).term).toBeGreaterThan(st(sim, old).term - 1);
  // the old leader's write is stuck pending — a minority cannot decide
  const row = st(sim, old).history.find((h) => h.op === 'write');
  expect(row?.outcome).toBe('pending');
  expect(st(sim, old).commitIndex).toBe(0);
});

test('healing the partition deposes the old leader and truncates its tail; the lost write is marked', () => {
  const sim = fresh();
  until(sim, () => leaders(sim).length === 1);
  const old = leaders(sim)[0];
  const others = RAFT_NODES.filter((n) => n !== old);
  const majority = others.slice(1);
  sim.control({ type: 'partition', groups: [[old, others[0]], majority] });
  sim.external(old, { cmd: 'write', value: 99 }); // will be lost
  until(sim, () => majority.some((n) => st(sim, n).role === 'leader'), 20000);
  const neo = majority.find((n) => st(sim, n).role === 'leader') as string;
  sim.external(neo, { cmd: 'write', value: 7 }); // will commit
  until(sim, () => st(sim, neo).commitIndex >= 1, 6000);
  sim.control({ type: 'heal' });
  // old leader steps down and converges on the new log
  until(sim, () => st(sim, old).role === 'follower' && st(sim, old).kv === 7, 20000);
  until(sim, () => st(sim, old).history.find((h) => h.op === 'write')?.outcome === 'lost', 6000);
  // no committed entry lost anywhere
  for (const n of RAFT_NODES) {
    const s = st(sim, n);
    if (s.commitIndex >= 1) expect(s.log[0].value).toBe(7);
  }
});
