import { expect, test } from 'vitest';
import { Simulation } from '../engine/sim';
import { pingPong } from './pingpong';

const NODES = ['n0', 'n1', 'n2'];
const mk = (opts: { seed?: number; drop?: number; dup?: number } = {}) =>
  new Simulation({
    module: pingPong,
    config: { nodeIds: NODES },
    seed: opts.seed ?? 42,
    network: { latency: [1, 10], dropRate: opts.drop ?? 0, duplicateRate: opts.dup ?? 0 },
  });

test('token circulates the ring on a clean network', () => {
  const sim = mk();
  sim.runUntil(1000);
  for (const id of NODES) expect(sim.getState(id).lastDelivered).toBeGreaterThan(5);
});

test('duplicates are ignored and the ring still advances', () => {
  const sim = mk({ dup: 0.5 });
  sim.runUntil(2000);
  for (const id of NODES) expect(sim.getState(id).lastDelivered).toBeGreaterThan(5);
});

test('retransmission recovers from drops', () => {
  const sim = mk({ drop: 0.3 });
  sim.runUntil(10_000);
  const max = Math.max(...NODES.map((id) => sim.getState(id).lastDelivered));
  expect(max).toBeGreaterThan(10);
});

test('a partitioned ring stops making progress, then resumes after heal', () => {
  const sim = mk();
  sim.runUntil(500);
  const before = Math.max(...NODES.map((id) => sim.getState(id).lastDelivered));
  sim.control({ type: 'partition', groups: [['n0'], ['n1', 'n2']] });
  sim.runUntil(1500);
  const during = Math.max(...NODES.map((id) => sim.getState(id).lastDelivered));
  expect(during - before).toBeLessThanOrEqual(2); // at most in-flight remnants
  sim.control({ type: 'heal' });
  sim.runUntil(3000);
  const after = Math.max(...NODES.map((id) => sim.getState(id).lastDelivered));
  expect(after).toBeGreaterThan(during + 5); // retransmit revives the token
});

test('metrics and inspect implement the contract', () => {
  const sim = mk();
  sim.runUntil(500);
  const states = new Map(NODES.map((id) => [id, sim.getState(id)]));
  const metrics = pingPong.metrics(states);
  expect(metrics.map((m) => m.name)).toEqual(['max-token', 'total-delivered']);
  expect(metrics[0].value).toBeGreaterThan(0);
  expect(pingPong.inspect(sim.getState('n0'))).toMatchObject({ self: 'n0' });
  expect(pingPong.chaos).toContain('partition');
});
