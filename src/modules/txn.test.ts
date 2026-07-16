// src/modules/txn.test.ts
import { expect, test } from 'vitest';
import { Simulation } from '../engine';
import { txn, type TxnState } from './txn';
import { TXN_TOPOLOGY, type Level, type ScheduleStep, type TxnPayload } from './txn-shared';

export function fresh(initial: Record<string, number>, seed = 7000) {
  const sim = new Simulation<TxnState, TxnPayload>({
    module: txn,
    config: { nodeIds: TXN_TOPOLOGY, params: { initial } },
    seed,
  });
  sim.runSteps(TXN_TOPOLOGY.length); // deliver the four inits
  return sim;
}

export function play(sim: ReturnType<typeof fresh>, steps: ScheduleStep[], nodes: Level[] = TXN_TOPOLOGY) {
  for (const s of steps) {
    for (const id of nodes) sim.external(id, { schedule: s });
    sim.runSteps(nodes.length);
  }
}

const st = (sim: ReturnType<typeof fresh>, id: Level) => sim.getState(id);

test('init seeds every level with the same committed store', () => {
  const sim = fresh({ x: 10 });
  for (const id of TXN_TOPOLOGY) {
    expect(st(sim, id).level).toBe(id);
    expect(st(sim, id).store.x).toEqual([{ value: 10, txn: null, committedAt: 0 }]);
  }
});

test('RU reads a foreign uncommitted version and flags dirty-read; RC reads last committed', () => {
  const sim = fresh({ x: 10 });
  play(sim, [
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'write', key: 'x', value: 99 } },
    { txn: 'T2', op: { op: 'begin' } },
    { txn: 'T2', op: { op: 'read', key: 'x' } },
  ]);
  const ru = st(sim, 'RU');
  const rc = st(sim, 'RC');
  expect(ru.txns.T2.reads[0].value).toBe(99);
  expect(ru.anomalies.map((a) => a.type)).toEqual(['dirty-read']);
  expect(rc.txns.T2.reads[0].value).toBe(10);
  expect(rc.anomalies).toEqual([]);
});

test('a txn always reads its own uncommitted writes, at every level', () => {
  const sim = fresh({ x: 10 });
  play(sim, [
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'write', key: 'x', value: 5 } },
    { txn: 'T1', op: { op: 'read', key: 'x' } },
  ]);
  for (const id of TXN_TOPOLOGY) {
    expect(st(sim, id).txns.T1.reads.at(-1)?.value).toBe(5);
    // reading your own write is not a dirty read
    expect(st(sim, id).anomalies).toEqual([]);
  }
});

test('commit publishes: RC readers see the value only after commit', () => {
  const sim = fresh({ x: 10 });
  play(sim, [
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'write', key: 'x', value: 42 } },
    { txn: 'T2', op: { op: 'begin' } },
    { txn: 'T2', op: { op: 'read', key: 'x' } },
    { txn: 'T1', op: { op: 'commit' } },
    { txn: 'T2', op: { op: 'read', key: 'x' } },
  ]);
  const rc = st(sim, 'RC');
  expect(rc.txns.T2.reads.map((r) => r.value)).toEqual([10, 42]);
  expect(rc.commits).toBe(1);
});

test('abort discards uncommitted versions', () => {
  const sim = fresh({ x: 10 });
  play(sim, [
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'write', key: 'x', value: 99 } },
    { txn: 'T1', op: { op: 'abort' } },
    { txn: 'T2', op: { op: 'begin' } },
    { txn: 'T2', op: { op: 'read', key: 'x' } },
  ]);
  for (const id of TXN_TOPOLOGY) {
    expect(st(sim, id).store.x).toHaveLength(1);
    expect(st(sim, id).txns.T2.reads[0].value).toBe(10);
    expect(st(sim, id).txns.T1.status).toBe('aborted');
    expect(st(sim, id).aborts).toBe(1);
  }
});

test('ops after commit/abort are swallowed and counted as skipped', () => {
  const sim = fresh({ x: 10 });
  play(sim, [
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'commit' } },
    { txn: 'T1', op: { op: 'write', key: 'x', value: 1 } },
  ]);
  const rc = st(sim, 'RC');
  expect(rc.skippedOps).toBe(1);
  expect(rc.store.x).toHaveLength(1);
});

test('reduce ignores non-schedule payloads and non-external events', () => {
  const sim = fresh({ x: 10 });
  sim.external('RC', { nonsense: true } as unknown as TxnPayload);
  sim.runSteps(1);
  expect(st(sim, 'RC').skippedOps).toBe(0);
  expect(st(sim, 'RC').store.x).toHaveLength(1);
});
