import { expect, test } from 'vitest';
import { btreeInit, btreeReduce, btreeGet, type BtreeState } from './btree';
import { STORAGE_TOPOLOGY, BTREE, BTREE_ORDER, type StoragePayload, type StorageFault } from './storage-shared';

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

test('a large workload splits index pages and grows height past 2, never exceeding order', () => {
  let s = btreeInit(cfg);
  const n = 24;
  for (let i = 0; i < n; i++) s = put(s, `k${String(i).padStart(2, '0')}`, String(i));
  // root index itself overflowed and split → a third level appeared
  expect(s.height).toBeGreaterThan(2);
  // no page (leaf or index) ever exceeds the fixed fanout
  for (const p of Object.values(s.pages)) {
    expect(p.keys.length).toBeLessThanOrEqual(BTREE_ORDER);
    if (!p.leaf) expect(p.children.length).toBe(p.keys.length + 1); // index invariant
  }
  // every acknowledged key is still retrievable at its written value
  for (let i = 0; i < n; i++) expect(btreeGet(s, `k${String(i).padStart(2, '0')}`).value).toBe(String(i));
  // read cost stays equal to height (read amplification = height, still truthful)
  expect(btreeGet(s, 'k00').state.lastReadCost).toBe(s.height);
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

const fault = (f: StorageFault['fault']) => ({ kind: 'external' as const, self: BTREE, time: 0, payload: { fault: f } });

test('crash-mid-write rebuilds every WAL-acked key from the redo log', () => {
  let s = btreeInit(cfg);
  for (let i = 0; i <= BTREE_ORDER; i++) s = btreeReduce(s, ev({ op: 'put', key: `k${i}`, val: String(i) }))[0];
  s = btreeReduce(s, fault('crash-mid-write'))[0];
  expect(s.phase).toBe('idle');
  for (let i = 0; i <= BTREE_ORDER; i++) expect(btreeGet(s, `k${i}`).value).toBe(String(i));
});

test('crash-mid-write repairs a torn structure by replaying the WAL (non-vacuous)', () => {
  let s = btreeInit(cfg);
  for (let i = 0; i <= BTREE_ORDER; i++) s = btreeReduce(s, ev({ op: 'put', key: `k${i}`, val: String(i) }))[0];
  // simulate a torn split: blank a live leaf so its keys vanish from the tree
  // (but remain in the durable redo WAL) — recovery must replay them back.
  const leaf = Object.values(s.pages).find((p) => p.leaf && p.keys.length > 0)!;
  const torn: BtreeState = { ...s, pages: { ...s.pages, [leaf.id]: { ...leaf, keys: [], vals: [] } } };
  expect(btreeGet(torn, leaf.keys[0]).value).toBeUndefined(); // key lost from live structure
  const recovered = btreeReduce(torn, fault('crash-mid-write'))[0];
  for (let i = 0; i <= BTREE_ORDER; i++) expect(btreeGet(recovered, `k${i}`).value).toBe(String(i)); // WAL replay restored it
});

test('disk-full rejects the split that an overflow needs', () => {
  let s = btreeInit(cfg);
  s = btreeReduce(s, fault('disk-full'))[0];
  const pagesBefore = Object.keys(s.pages).length;
  for (let i = 0; i <= BTREE_ORDER; i++) s = btreeReduce(s, ev({ op: 'put', key: `k${i}`, val: String(i) }))[0];
  expect(s.diskFull).toBe(true);
  expect(Object.keys(s.pages).length).toBe(pagesBefore); // no new page allocated
});

test('recover clears disk-full and the tree is consistent', () => {
  let s = btreeInit(cfg);
  s = btreeReduce(s, fault('disk-full'))[0];
  for (let i = 0; i <= BTREE_ORDER; i++) s = btreeReduce(s, ev({ op: 'put', key: `k${i}`, val: String(i) }))[0];
  s = btreeReduce(s, fault('recover'))[0];
  expect(s.diskFull).toBe(false);
  for (let i = 0; i <= BTREE_ORDER; i++) expect(btreeGet(s, `k${i}`).value).toBe(String(i));
});
