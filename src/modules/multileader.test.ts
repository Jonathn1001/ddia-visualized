import { expect, test } from 'vitest';
import { Simulation, type NodeId } from '../engine';
import { detectLostWrite, multiLeader, type MLPayload, type MLState } from './multileader';

const NODES = ['DC1', 'DC2'];

function makeSim(network?: { latency?: [number, number]; dropRate?: number }) {
  return new Simulation<MLState, MLPayload>({
    module: multiLeader,
    config: { nodeIds: NODES },
    seed: 21,
    network: { latency: [5, 20], ...network },
  });
}

function statesOf(sim: Simulation<MLState, MLPayload>) {
  return new Map<NodeId, MLState>(NODES.map((id) => [id, sim.getState(id)] as const));
}

test('write acks immediately and replicates to the peer', () => {
  const sim = makeSim();
  sim.runSteps(2); // inits
  sim.external('DC1', { cmd: 'write', key: 'x', value: 'a' });
  sim.runSteps(1);
  expect(sim.getState('DC1').history).toEqual([
    { type: 'ack', key: 'x', ts: 1, origin: 'DC1', time: 0 }, // Lamport bump: max(0, 0+1)
  ]);
  sim.runUntil(500);
  expect(sim.getState('DC2').data['x']).toEqual({ value: 'a', ts: 1, origin: 'DC1' });
});

test('concurrent writes converge; the loser is discarded and detected as a lost acked write', () => {
  const sim = makeSim();
  sim.runSteps(2);
  sim.external('DC1', { cmd: 'write', key: 'x', value: 'from-dc1' });
  sim.external('DC2', { cmd: 'write', key: 'x', value: 'from-dc2' });
  sim.runUntil(500);
  // Same Lamport ts (1,DC1) vs (1,DC2) -> DC2 wins the origin tiebreak everywhere.
  expect(sim.getState('DC1').data['x']).toEqual({ value: 'from-dc2', ts: 1, origin: 'DC2' });
  expect(sim.getState('DC2').data['x']).toEqual({ value: 'from-dc2', ts: 1, origin: 'DC2' });
  const lost = detectLostWrite(statesOf(sim));
  expect(lost).not.toBeNull();
  expect(lost!.discarded).toMatchObject({ key: 'x', value: 'from-dc1', origin: 'DC1' });
  expect(lost!.ack).toMatchObject({ key: 'x', origin: 'DC1' });
});

test('Lamport bump: a write issued after seeing a newer update wins everywhere', () => {
  const sim = makeSim({ latency: [1, 1] });
  sim.runSteps(2);
  sim.external('DC2', { cmd: 'write', key: 'x', value: 'old' });
  sim.runUntil(50); // DC1 has (1, DC2)
  sim.external('DC1', { cmd: 'write', key: 'x', value: 'new' }); // ts = max(50, 1+1) = 50
  sim.runUntil(200);
  expect(sim.getState('DC1').data['x']!.value).toBe('new');
  expect(sim.getState('DC2').data['x']!.value).toBe('new');
  expect(detectLostWrite(statesOf(sim))).toBeNull(); // causal overwrite is not a conflict
});

test('reads record the returned timestamp', () => {
  const sim = makeSim();
  sim.runSteps(2);
  sim.external('DC2', { cmd: 'read', key: 'x' });
  sim.runSteps(1);
  expect(sim.getState('DC2').history).toEqual([
    { type: 'read', node: 'DC2', key: 'x', returnedTs: 0, time: 0 },
  ]);
});

test('metrics: divergent-keys counts a permanently dropped update', () => {
  const sim = makeSim({ dropRate: 1 });
  sim.runSteps(2);
  sim.external('DC1', { cmd: 'write', key: 'x', value: 'a' }); // update to DC2 dropped
  sim.runUntil(500);
  const m = Object.fromEntries(
    sim.module.metrics(statesOf(sim), sim.time).map((s) => [s.name, s.value]),
  );
  expect(m['divergent-keys']).toBe(1);
  expect(m['acked-writes']).toBe(1);
  expect(m['conflicts-detected']).toBe(0);
});
