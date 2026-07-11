// src/modules/leaderless.test.ts
import { expect, test } from 'vitest';
import { Simulation, type NodeId } from '../engine';
import { detectLostAckedWrite, leaderless, type LLPayload, type LLState } from './leaderless';

const NODES = ['A', 'B', 'C', 'D', 'E'];

function makeSim(params?: { w?: number; r?: number; sloppy?: boolean }) {
  return new Simulation<LLState, LLPayload>({
    module: leaderless,
    config: { nodeIds: NODES, params: { w: 2, r: 2, sloppy: false, ...params } },
    seed: 31,
    network: { latency: [5, 20] },
  });
}

function statesOf(sim: Simulation<LLState, LLPayload>) {
  return new Map<NodeId, LLState>(NODES.map((id) => [id, sim.getState(id)] as const));
}

function acksAt(sim: Simulation<LLState, LLPayload>, node: string) {
  return sim.getState(node).history.filter((h) => h.type === 'ack');
}

test('write acks after w replica acks; value lands on home replicas', () => {
  const sim = makeSim();
  sim.runSteps(5);
  sim.external('A', { cmd: 'write', key: 'x', value: '1' });
  sim.runSteps(1);
  expect(acksAt(sim, 'A')).toHaveLength(0); // not yet — needs w=2 storeAcks
  sim.runUntil(1000);
  expect(acksAt(sim, 'A')).toHaveLength(1);
  for (const id of ['A', 'B', 'C']) expect(sim.getState(id).data['x']?.value).toBe('1');
  expect(sim.getState('D').data['x']).toBeUndefined(); // fallbacks untouched
});

test('strict quorum: unreachable replicas fail the write after timeout', () => {
  const sim = makeSim({ sloppy: false });
  sim.runSteps(5);
  sim.control({ type: 'partition', groups: [['A', 'D', 'E'], ['B', 'C']] });
  sim.external('A', { cmd: 'write', key: 'x', value: '1' });
  sim.runUntil(2000);
  expect(acksAt(sim, 'A')).toHaveLength(0);
  expect(sim.getState('A').history.filter((h) => h.type === 'failed-write')).toHaveLength(1);
});

test('sloppy quorum: fallback hints count toward w; handoff completes after heal', () => {
  const sim = makeSim({ sloppy: true });
  sim.runSteps(5);
  sim.control({ type: 'partition', groups: [['A', 'D', 'E'], ['B', 'C']] });
  sim.external('A', { cmd: 'write', key: 'x', value: '1' });
  sim.runUntil(2000);
  expect(acksAt(sim, 'A')).toHaveLength(1); // A itself + a fallback hint = w=2
  const hintsHeld = ['D', 'E'].reduce(
    (n, id) => n + Object.keys(sim.getState(id).hintBuffer).length,
    0,
  );
  expect(hintsHeld).toBeGreaterThan(0);
  sim.control({ type: 'heal' });
  sim.runUntil(5000);
  // handoff delivered: some previously-cut home replica has the value, hints cleared
  expect(['B', 'C'].some((id) => sim.getState(id).data['x']?.value === '1')).toBe(true);
  const hintsAfter = ['D', 'E'].reduce(
    (n, id) => n + Object.keys(sim.getState(id).hintBuffer).length,
    0,
  );
  expect(hintsAfter).toBe(0);
});

test('read quorum returns the newest value and repairs stale replicas', () => {
  const sim = makeSim({ w: 2, r: 3 });
  sim.runSteps(5);
  sim.control({ type: 'partition', groups: [['A', 'B', 'D', 'E'], ['C']] }); // C misses the write
  sim.external('A', { cmd: 'write', key: 'x', value: '1' });
  sim.runUntil(1000);
  expect(acksAt(sim, 'A')).toHaveLength(1); // A+B = w=2
  sim.control({ type: 'heal' });
  sim.runUntil(1100);
  sim.external('B', { cmd: 'read', key: 'x' });
  sim.runUntil(3000);
  const reads = sim.getState('B').history.filter((h) => h.type === 'read');
  expect(reads).toHaveLength(1);
  expect(reads[0]).toMatchObject({ key: 'x', returnedTs: expect.any(Number) });
  expect(reads[0].returnedTs).toBeGreaterThan(0);
  expect(sim.getState('B').history.filter((h) => h.type === 'read-repair')).toHaveLength(1);
  expect(sim.getState('C').data['x']?.value).toBe('1'); // repaired
});

test('sloppy loss: acked write vanishes when fallbacks die before handoff', () => {
  const sim = makeSim({ sloppy: true });
  sim.runSteps(5);
  // Coordinator E is NOT a home replica: all home stores blocked -> pure hint ack.
  sim.control({ type: 'partition', groups: [['D', 'E'], ['A', 'B', 'C']] });
  sim.external('E', { cmd: 'write', key: 'x', value: 'doomed' });
  sim.runUntil(2000);
  expect(acksAt(sim, 'E')).toHaveLength(1); // acked purely via D+E hints
  expect(detectLostAckedWrite(statesOf(sim), sim.deadNodes())).toBeNull(); // hints still alive
  sim.control({ type: 'kill', node: 'D' });
  sim.control({ type: 'kill', node: 'E' });
  sim.runSteps(2);
  const lost = detectLostAckedWrite(statesOf(sim), sim.deadNodes());
  expect(lost).not.toBeNull();
  expect(lost!.ack.key).toBe('x');
  expect(lost!.coordinator).toBe('E');
});

test('read that cannot reach r replies fails after the op timeout', () => {
  const sim = makeSim({ w: 2, r: 3 }); // r=3 needs all three home replicas to reply
  sim.runSteps(5);
  sim.external('A', { cmd: 'write', key: 'x', value: '1' });
  sim.runUntil(1000); // A + B ack (w=2)
  sim.control({ type: 'partition', groups: [['A', 'B', 'D', 'E'], ['C']] }); // C unreachable
  sim.external('A', { cmd: 'read', key: 'x' });
  sim.runUntil(2000);
  // A + B reply (2), C is partitioned -> 2 < r=3 -> the read never resolves -> timeout.
  expect(sim.getState('A').history.filter((h) => h.type === 'read')).toHaveLength(0);
  const failed = sim.getState('A').history.filter((h) => h.type === 'failed-read');
  expect(failed).toHaveLength(1);
  expect(failed[0]).toMatchObject({ node: 'A', key: 'x' });
});

test('a read that reaches its quorum records a read, never a failed-read', () => {
  const sim = makeSim({ w: 2, r: 2 });
  sim.runSteps(5);
  sim.external('A', { cmd: 'write', key: 'x', value: '1' });
  sim.runUntil(1000);
  sim.external('A', { cmd: 'read', key: 'x' });
  sim.runUntil(2000); // the op-timeout fires here, but the read already resolved -> no-op
  expect(sim.getState('A').history.filter((h) => h.type === 'read')).toHaveLength(1);
  expect(sim.getState('A').history.filter((h) => h.type === 'failed-read')).toHaveLength(0);
});
