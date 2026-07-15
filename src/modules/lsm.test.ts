import { expect, test } from 'vitest';
import { lsmInit, lsmReduce, lsmGet, type LsmState } from './lsm';
import { STORAGE_TOPOLOGY, LSM, type StoragePayload } from './storage-shared';

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
