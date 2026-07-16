// src/modules/raft.test.ts
import { expect, test } from 'vitest';
import { Simulation } from '../engine';
import { raft, type RaftState } from './raft';
import { ELECTION_MAX, RAFT_NODES, type RaftPayload } from './raft-shared';

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
  sim.runSteps(1);
  expect(st(sim, follower).log).toHaveLength(0);
  expect(st(sim, follower).history[0]?.outcome).toBe('redirect');
});
