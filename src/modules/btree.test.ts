import { expect, test } from 'vitest';
import { btreeInit, btreeReduce, btreeGet, type BtreeState } from './btree';
import { STORAGE_TOPOLOGY, BTREE, BTREE_ORDER, type StoragePayload } from './storage-shared';

const cfg = { nodeIds: STORAGE_TOPOLOGY };
const ev = (payload: StoragePayload) => ({ kind: 'external' as const, self: BTREE, time: 0, payload });
const put = (s: BtreeState, key: string, val: string) => btreeReduce(s, ev({ op: 'put', key, val }))[0];

test('put then get returns the value; missing key is undefined', () => {
  let s = btreeInit(cfg);
  s = put(s, 'm', '1');
  expect(btreeGet(s, 'm').value).toBe('1');
  expect(btreeGet(s, 'zzz').value).toBeUndefined();
});

test('put appends a redo record and counts a disk write', () => {
  let s = btreeInit(cfg);
  s = put(s, 'm', '1');
  expect(s.wal).toHaveLength(1);
  expect(s.diskWrites).toBeGreaterThan(0);
  expect(s.userBytes).toBe(16);
});

test('overflowing a leaf splits it and grows the tree height', () => {
  let s = btreeInit(cfg);
  expect(s.height).toBe(1);
  for (let i = 0; i <= BTREE_ORDER; i++) s = put(s, `k${i}`, String(i)); // BTREE_ORDER+1 keys > order
  expect(Object.keys(s.pages).length).toBeGreaterThan(1); // at least one split leaf
  expect(s.height).toBe(2);
});

test('get cost equals tree height (read amplification)', () => {
  let s = btreeInit(cfg);
  for (let i = 0; i <= BTREE_ORDER; i++) s = put(s, `k${i}`, String(i));
  const r = btreeGet(s, 'k0');
  expect(r.state.lastReadCost).toBe(s.height);
});

test('delete removes the key in place', () => {
  let s = btreeInit(cfg);
  s = put(s, 'm', '1');
  s = btreeReduce(s, ev({ op: 'delete', key: 'm' }))[0];
  expect(btreeGet(s, 'm').value).toBeUndefined();
});

test('put emits no send effects', () => {
  const [, effects] = btreeReduce(btreeInit(cfg), ev({ op: 'put', key: 'm', val: '1' }));
  expect(effects.every((e) => e.type !== 'send')).toBe(true);
});
