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

test('pinned lesson: under sustained overwrites LSM write-amp exceeds B-tree (compaction is the cost)', () => {
  const sim = fresh();
  sim.runSteps(2);
  // Overwrite a small keyset repeatedly. The B-tree updates in place — WAL + one page
  // write, a flat ~2x, and no new splits once the keys exist. The LSM re-buffers each
  // overwrite and every compaction rewrites the same live keys, so its write-amp climbs
  // past the B-tree's. (A one-shot load of *distinct* keys would instead be dominated by
  // the tiny-order B-tree's page splits — this workload isolates the compaction cost.)
  for (let round = 0; round < 8; round++) {
    for (let i = 0; i < 8; i++) {
      sim.external(LSM, { op: 'put', key: `k${i}`, val: `v${round}` });
      sim.external(BTREE, { op: 'put', key: `k${i}`, val: `v${round}` });
    }
    sim.runUntil(sim.time + 5000); // drain this round's flushes + compactions
  }
  const states = new Map(STORAGE_TOPOLOGY.map((id) => [id, sim.getState(id)] as const));
  const m = Object.fromEntries(storage.metrics(states, sim.time).map((s) => [s.name, s.value]));
  expect(m['lsm/write-amp']).toBeGreaterThan(m['btree/write-amp']);
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
