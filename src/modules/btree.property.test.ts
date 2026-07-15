// src/modules/btree.property.test.ts
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { btreeInit, btreeReduce, btreeGet, type BtreeState } from './btree';
import { STORAGE_TOPOLOGY, BTREE, writeAmp, type StoragePayload } from './storage-shared';

const cfg = { nodeIds: STORAGE_TOPOLOGY };
const ev = (payload: StoragePayload) => ({ kind: 'external' as const, self: BTREE, time: 0, payload });

// fast-check v4 shrinks generated collections small by default; `size: 'max'` forces the
// declared maxLength so op sequences are long enough to split leaves and grow height —
// without it these properties would run almost entirely on trivial single-page trees
// (the vacuity that bit the LSM property suite). Non-vacuity is asserted explicitly below.
const SIZED = { size: 'max' } as const;

test('property: get matches a reference map after any put/delete sequence', () => {
  type Op = { op: 'put'; key: string; val: string } | { op: 'delete'; key: string };
  const key = fc.constantFrom(...'abcdefgh'.split(''));
  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ op: fc.constant<'put'>('put'), key, val: fc.string({ minLength: 1, maxLength: 3 }) }),
    fc.record({ op: fc.constant<'delete'>('delete'), key }),
  );
  fc.assert(
    fc.property(fc.array(opArb, { minLength: 1, maxLength: 40, ...SIZED }), (ops) => {
      let s: BtreeState = btreeInit(cfg);
      const ref = new Map<string, string | null>();
      for (const op of ops) {
        s = btreeReduce(s, ev(op))[0];
        ref.set(op.key, op.op === 'put' ? op.val : null);
      }
      for (const [k, v] of ref) expect(btreeGet(s, k).value).toBe(v ?? undefined);
    }),
    { numRuns: 150 },
  );
});

test('property: get cost never exceeds height (read-amp = height), and the load builds real depth', () => {
  let maxHeight = 0;
  fc.assert(
    fc.property(fc.array(fc.constantFrom(...'abcdefghij'.split('')), { minLength: 1, maxLength: 30, ...SIZED }), (keys) => {
      let s: BtreeState = btreeInit(cfg);
      for (const k of keys) s = btreeReduce(s, ev({ op: 'put', key: k, val: '1' }))[0];
      // a B-tree stays balanced — every leaf sits at depth = height — so read cost is
      // EXACTLY height for every key, not merely bounded by it (the constant read-amp lesson).
      for (const k of keys) expect(btreeGet(s, k).state.lastReadCost).toBe(s.height);
      maxHeight = Math.max(maxHeight, s.height);
    }),
    { numRuns: 150 },
  );
  expect(maxHeight).toBeGreaterThanOrEqual(2); // non-vacuous: some run actually split a leaf and grew height
});

test('property: B-tree write-amp stays bounded (< 4x) — no compaction rewrites', () => {
  let maxAmp = 0;
  fc.assert(
    fc.property(fc.array(fc.constantFrom(...'abcdefghij'.split('')), { minLength: 5, maxLength: 40, ...SIZED }), (keys) => {
      let s: BtreeState = btreeInit(cfg);
      for (const k of keys) s = btreeReduce(s, ev({ op: 'put', key: k, val: '1' }))[0];
      const amp = writeAmp(s);
      expect(amp).toBeLessThan(4);
      maxAmp = Math.max(maxAmp, amp);
    }),
    { numRuns: 100 },
  );
  expect(maxAmp).toBeGreaterThan(1); // non-vacuous: real WAL+page double-write, not a trivial 1x
});

test('property: determinism — identical serialized state for identical op sequences', () => {
  fc.assert(
    fc.property(fc.array(fc.record({ key: fc.constantFrom('a', 'b', 'c', 'd'), val: fc.string({ maxLength: 2 }) }), { minLength: 1, maxLength: 30, ...SIZED }), (ops) => {
      const run = () => {
        let s: BtreeState = btreeInit(cfg);
        for (const o of ops) s = btreeReduce(s, ev({ op: 'put', ...o }))[0];
        return JSON.stringify(s);
      };
      expect(run()).toBe(run());
    }),
    { numRuns: 100 },
  );
});
