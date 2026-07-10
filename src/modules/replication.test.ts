import { expect, test } from 'vitest';
import { Simulation } from '../engine';
import { replication, type RepPayload, type RepState } from './replication';

const NODES = ['L', 'F1', 'F2'];

function makeSim(mode: 'async' | 'sync', network?: { latency?: [number, number]; dropRate?: number }) {
  return new Simulation<RepState, RepPayload>({
    module: replication,
    config: { nodeIds: NODES, params: { mode } },
    seed: 11,
    network: { latency: [5, 20], ...network },
  });
}

test('async write propagates to all followers and acks immediately', () => {
  const sim = makeSim('async');
  sim.runSteps(3); // inits
  sim.external('L', { cmd: 'write', key: 'x', value: '1' });
  sim.runSteps(1); // leader processes the write
  expect(sim.getState('L').history).toEqual([{ type: 'ack', seq: 1, key: 'x', time: 0 }]);
  sim.runUntil(500);
  for (const id of NODES) {
    expect(sim.getState(id).data['x']).toEqual({ value: '1', seq: 1 });
    expect(sim.getState(id).log).toHaveLength(1);
  }
});

test('sync write acks only after all followers confirm', () => {
  const sim = makeSim('sync');
  sim.runSteps(3);
  sim.external('L', { cmd: 'write', key: 'x', value: '1' });
  sim.runSteps(1);
  expect(sim.getState('L').history).toEqual([]); // not acked yet
  sim.runUntil(500);
  const acks = sim.getState('L').history.filter((h) => h.type === 'ack');
  expect(acks).toEqual([{ type: 'ack', seq: 1, key: 'x', time: expect.any(Number) }]);
});

test('reads record the returned seq per node', () => {
  const sim = makeSim('async');
  sim.runSteps(3);
  sim.external('F1', { cmd: 'read', key: 'x' });
  sim.runSteps(1);
  expect(sim.getState('F1').history).toEqual([{ type: 'read', node: 'F1', key: 'x', returnedSeq: 0, time: 0 }]);
});

test('sync mode retransmits through total drop until the network heals', () => {
  const sim = makeSim('sync', { dropRate: 1 });
  sim.runSteps(3);
  sim.external('L', { cmd: 'write', key: 'k', value: 'v' });
  sim.runUntil(300);
  expect(sim.getState('L').history.filter((h) => h.type === 'ack')).toHaveLength(0);
  expect(sim.getState('F1').log).toHaveLength(0);
  sim.control({ type: 'net', opts: { dropRate: 0 } });
  sim.runUntil(1500);
  expect(sim.getState('L').history.filter((h) => h.type === 'ack')).toHaveLength(1);
  expect(sim.getState('F1').log).toHaveLength(1);
  expect(sim.getState('F2').log).toHaveLength(1);
});

test('followers buffer out-of-order appends and apply in seq order', () => {
  const sim = makeSim('async', { latency: [1, 200] }); // wide latency → reorder likely
  sim.runSteps(3);
  for (let i = 1; i <= 5; i++) sim.external('L', { cmd: 'write', key: `k${i}`, value: String(i) });
  sim.runUntil(2000);
  for (const id of ['F1', 'F2']) {
    expect(sim.getState(id).log.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  }
});

test('metrics reports lag, acked writes, and stale reads', () => {
  const sim = makeSim('async');
  sim.runSteps(3);
  sim.external('L', { cmd: 'write', key: 'x', value: '1' });
  sim.runSteps(1); // acked at leader; appends still in flight
  sim.external('F1', { cmd: 'read', key: 'x' }); // stale: F1 hasn't applied yet
  sim.runSteps(1);
  const states = new Map(NODES.map((id) => [id, sim.getState(id)] as const));
  const m = Object.fromEntries(sim.module.metrics(states, sim.time).map((s) => [s.name, s.value]));
  expect(m['max-replication-lag']).toBe(1);
  expect(m['acked-writes']).toBe(1);
  expect(m['stale-reads']).toBe(1);
});
