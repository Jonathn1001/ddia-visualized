import { expect, test } from 'vitest';
import { lsmInit, lsmReduce, lsmGet, bloomMightContain, type LsmState } from './lsm';
import { STORAGE_TOPOLOGY, LSM, MEMTABLE_CAP, type StoragePayload } from './storage-shared';

const cfg = { nodeIds: STORAGE_TOPOLOGY };
const ev = (payload: StoragePayload) => ({ kind: 'external' as const, self: LSM, time: 0, payload });

function put(s: LsmState, key: string, val: string): LsmState {
  return lsmReduce(s, ev({ op: 'put', key, val }))[0];
}

test('put then get returns the value', () => {
  let s = lsmInit(cfg);
  s = put(s, 'a', '1');
  expect(lsmGet(s, 'a').value).toBe('1');
  expect(lsmGet(s, 'missing').value).toBeUndefined();
});

test('put appends a durable WAL record and counts a disk write', () => {
  let s = lsmInit(cfg);
  s = put(s, 'a', '1');
  expect(s.wal).toHaveLength(1);
  expect(s.wal[0]).toMatchObject({ key: 'a', val: '1' });
  expect(s.diskWrites).toBe(1);
  expect(s.userBytes).toBe(16);
});

test('delete writes a tombstone; get sees the key as absent', () => {
  let s = lsmInit(cfg);
  s = put(s, 'a', '1');
  s = lsmReduce(s, ev({ op: 'delete', key: 'a' }))[0];
  expect(lsmGet(s, 'a').value).toBeUndefined();
  expect(s.memtable.find((e) => e.key === 'a')?.val).toBeNull();
});

test('put emits no send effects (local-only module)', () => {
  const [, effects] = lsmReduce(lsmInit(cfg), ev({ op: 'put', key: 'a', val: '1' }));
  expect(effects.every((e) => e.type !== 'send')).toBe(true);
});

test('memtable past cap schedules a flush; the flush-phase2 timer writes an L0 SSTable', () => {
  let s = lsmInit(cfg);
  let effects;
  for (let i = 0; i <= MEMTABLE_CAP; i++) {
    [s, effects] = lsmReduce(s, ev({ op: 'put', key: `k${i}`, val: String(i) }));
  }
  // the write that tips it over cap requests a flush
  expect(s.phase).toBe('flushing');
  expect(effects!.some((e) => e.type === 'timer')).toBe(true);
  // run the flush timer
  [s] = lsmReduce(s, { kind: 'timer', self: LSM, time: 10, payload: { timer: 'flush-phase2' } });
  expect(s.phase).toBe('idle');
  expect(s.memtable).toHaveLength(0);
  expect(s.sstables).toHaveLength(1);
  expect(s.sstables[0].level).toBe(0);
  expect(s.sstables[0].entries.length).toBe(MEMTABLE_CAP + 1);
});

test('a flushed key is still readable from its SSTable', () => {
  let s = lsmInit(cfg);
  for (let i = 0; i <= MEMTABLE_CAP; i++) s = lsmReduce(s, ev({ op: 'put', key: `k${i}`, val: String(i) }))[0];
  [s] = lsmReduce(s, { kind: 'timer', self: LSM, time: 10, payload: { timer: 'flush-phase2' } });
  expect(lsmGet(s, 'k0').value).toBe('0');
});

test('bloom filter never rejects a key that is present', () => {
  let s = lsmInit(cfg);
  for (let i = 0; i <= MEMTABLE_CAP; i++) s = lsmReduce(s, ev({ op: 'put', key: `x${i}`, val: String(i) }))[0];
  [s] = lsmReduce(s, { kind: 'timer', self: LSM, time: 10, payload: { timer: 'flush-phase2' } });
  const bloom = s.sstables[0].bloom;
  for (let i = 0; i <= MEMTABLE_CAP; i++) expect(bloomMightContain(bloom, `x${i}`)).toBe(true);
});
