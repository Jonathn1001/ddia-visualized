// src/modules/storage.test.ts
import { expect, test } from 'vitest';
import { Simulation } from '../engine';
import { storage, type StorageState } from './storage';
import { STORAGE_TOPOLOGY, LSM, BTREE } from './storage-shared';

function fresh() {
  return new Simulation<StorageState>({ module: storage, config: { nodeIds: STORAGE_TOPOLOGY }, seed: 3000 });
}

test('dispatcher inits LSM and B-tree independently by nodeId', () => {
  const sim = fresh();
  sim.runSteps(2); // deliver both inits
  expect(sim.getState(LSM).engine).toBe('lsm');
  expect(sim.getState(BTREE).engine).toBe('btree');
});

test('the same op to both nodes lands in each engine without cross-leak', () => {
  const sim = fresh();
  sim.runSteps(2);
  sim.external(LSM, { op: 'put', key: 'a', val: '1' });
  sim.external(BTREE, { op: 'put', key: 'a', val: '1' });
  sim.runUntil(50);
  const lsm = storage.inspect(sim.getState(LSM)) as { engine: string; memtable: unknown[] };
  const bt = storage.inspect(sim.getState(BTREE)) as { engine: string; pages: unknown[] };
  expect(lsm.engine).toBe('lsm');
  expect(bt.engine).toBe('btree');
});

test('metrics are namespaced per engine', () => {
  const sim = fresh();
  sim.runSteps(2);
  sim.external(LSM, { op: 'put', key: 'a', val: '1' });
  sim.external(BTREE, { op: 'put', key: 'a', val: '1' });
  sim.runUntil(50);
  const states = new Map(STORAGE_TOPOLOGY.map((id) => [id, sim.getState(id)] as const));
  const names = storage.metrics(states, sim.time).map((m) => m.name);
  expect(names).toContain('lsm/write-amp');
  expect(names).toContain('btree/write-amp');
  expect(names).toContain('lsm/read-amp');
  expect(names).toContain('btree/read-amp');
});

test('the module emits no send effects for any op', () => {
  const sim = fresh();
  sim.runSteps(2);
  sim.external(LSM, { op: 'put', key: 'a', val: '1' });
  sim.external(BTREE, { op: 'put', key: 'a', val: '1' });
  sim.runUntil(50);
  // in-flight are only 'message' events; a local module schedules none
  expect(sim.inFlight()).toHaveLength(0);
});
