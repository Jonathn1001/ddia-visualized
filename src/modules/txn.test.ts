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

test('SI: reads are stable against commits after the snapshot', () => {
  const sim = fresh({ x: 10 });
  play(sim, [
    { txn: 'T2', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'write', key: 'x', value: 42 } },
    { txn: 'T1', op: { op: 'commit' } },
    { txn: 'T2', op: { op: 'read', key: 'x' } },
  ]);
  expect(st(sim, 'SI').txns.T2.reads[0].value).toBe(10); // snapshot predates T1's commit
  expect(st(sim, 'RC').txns.T2.reads[0].value).toBe(42); // RC sees the newest committed
});

test('SI: first committer wins — the second writer of the same key aborts', () => {
  const sim = fresh({ counter: 10 });
  play(sim, [
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T2', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'write', key: 'counter', value: 11 } },
    { txn: 'T2', op: { op: 'write', key: 'counter', value: 17 } },
    { txn: 'T1', op: { op: 'commit' } },
    { txn: 'T2', op: { op: 'commit' } },
  ]);
  const si = st(sim, 'SI');
  expect(si.txns.T1.status).toBe('committed');
  expect(si.txns.T2.status).toBe('aborted');
  expect(si.txns.T2.abortReason).toContain('first committer wins');
  // the loser's version is gone; the winner's value stands
  expect(si.store.counter.filter((v) => v.committedAt !== null).at(-1)?.value).toBe(11);
  // RC (no conflict check) let both commit
  expect(st(sim, 'RC').txns.T2.status).toBe('committed');
});

test('SI: disjoint writes both commit (no false conflict)', () => {
  const sim = fresh({ a: 1, b: 2 });
  play(sim, [
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T2', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'write', key: 'a', value: 5 } },
    { txn: 'T2', op: { op: 'write', key: 'b', value: 6 } },
    { txn: 'T1', op: { op: 'commit' } },
    { txn: 'T2', op: { op: 'commit' } },
  ]);
  expect(st(sim, 'SI').txns.T1.status).toBe('committed');
  expect(st(sim, 'SI').txns.T2.status).toBe('committed');
});

test('SER: a second txn queues while the first is active, then drains on commit', () => {
  const sim = fresh({ x: 10 });
  play(sim, [
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T2', op: { op: 'begin' } },
    { txn: 'T2', op: { op: 'read', key: 'x' } },
    { txn: 'T1', op: { op: 'write', key: 'x', value: 42 } },
  ]);
  let ser = st(sim, 'SER');
  expect(ser.txns.T2.status).toBe('waiting');
  expect(ser.queue).toHaveLength(2);
  expect(ser.queuedOps).toBe(2);
  expect(ser.txns.T2.reads).toEqual([]); // nothing ran yet

  play(sim, [{ txn: 'T1', op: { op: 'commit' } }]);
  ser = st(sim, 'SER');
  expect(ser.queue).toEqual([]);
  expect(ser.txns.T2.status).toBe('active');
  // the drained read ran AFTER T1's commit, so it saw 42 — serial order, not schedule order
  expect(ser.txns.T2.reads[0].value).toBe(42);
});

test('SER: drains on abort too, and the drained txn sees pre-abort state', () => {
  const sim = fresh({ x: 10 });
  play(sim, [
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'write', key: 'x', value: 99 } },
    { txn: 'T2', op: { op: 'begin' } },
    { txn: 'T2', op: { op: 'read', key: 'x' } },
    { txn: 'T2', op: { op: 'commit' } },
    { txn: 'T1', op: { op: 'abort' } },
  ]);
  const ser = st(sim, 'SER');
  expect(ser.txns.T2.status).toBe('committed');
  expect(ser.txns.T2.reads[0].value).toBe(10); // T1's write was rolled back first
  expect(ser.anomalies).toEqual([]);
});

test('SER: never dirty-reads, never loses the schedule tail', () => {
  const sim = fresh({ counter: 10 });
  play(sim, [
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T2', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'read', key: 'counter' } },
    { txn: 'T2', op: { op: 'read', key: 'counter' } },
    { txn: 'T1', op: { op: 'write', key: 'counter', value: { inc: 1 } } },
    { txn: 'T1', op: { op: 'commit' } },
    { txn: 'T2', op: { op: 'write', key: 'counter', value: { inc: 1 } } },
    { txn: 'T2', op: { op: 'commit' } },
  ]);
  const ser = st(sim, 'SER');
  expect(ser.txns.T1.status).toBe('committed');
  expect(ser.txns.T2.status).toBe('committed');
  // both increments landed: T2 ran serially after T1
  expect(ser.store.counter.filter((v) => v.committedAt !== null).at(-1)?.value).toBe(12);
  expect(ser.anomalies).toEqual([]);
});

test('ensure: passes at/above the threshold, records its reads', () => {
  const sim = fresh({ alice: 1, bob: 1 });
  play(sim, [
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'ensure', keys: ['alice', 'bob'], atLeast: 2 } },
  ]);
  const rc = st(sim, 'RC');
  expect(rc.txns.T1.status).toBe('active');
  expect(rc.txns.T1.reads.map((r) => r.key)).toEqual(['alice', 'bob']);
});

test('ensure: below the threshold the txn aborts itself', () => {
  const sim = fresh({ alice: 0, bob: 1 });
  play(sim, [
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'ensure', keys: ['alice', 'bob'], atLeast: 2 } },
    { txn: 'T1', op: { op: 'write', key: 'bob', value: 0 } },
  ]);
  const rc = st(sim, 'RC');
  expect(rc.txns.T1.status).toBe('aborted');
  expect(rc.txns.T1.abortReason).toContain('ensure failed');
  expect(rc.skippedOps).toBe(1); // the write after the self-abort was swallowed
  expect(rc.store.bob.at(-1)?.value).toBe(1);
});

test('{inc} with no prior read records the dependency read at write time', () => {
  const sim = fresh({ counter: 10 });
  play(sim, [
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'write', key: 'counter', value: { inc: 5 } } },
  ]);
  const rc = st(sim, 'RC');
  expect(rc.store.counter.at(-1)?.value).toBe(15);
  expect(rc.txns.T1.reads.map((r) => r.key)).toEqual(['counter']);
});
