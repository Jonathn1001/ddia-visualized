// src/modules/lsm.property.test.ts
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { lsmInit, lsmReduce, lsmGet, buildBloom, bloomMightContain, type LsmState } from './lsm';
import { STORAGE_TOPOLOGY, LSM, type StoragePayload } from './storage-shared';

const cfg = { nodeIds: STORAGE_TOPOLOGY };
const ev = (payload: StoragePayload) => ({ kind: 'external' as const, self: LSM, time: 0, payload });

test('property: bloom never false-negative — a present key always probes positive', () => {
  fc.assert(
    fc.property(fc.array(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 20 }), (keys) => {
      const bloom = buildBloom(keys.map((k) => ({ key: k, val: 'v' })));
      for (const k of keys) expect(bloomMightContain(bloom, k)).toBe(true);
    }),
    { numRuns: 200 },
  );
});

test('property: after any op sequence + flushes, get matches a reference map', () => {
  type Op = { op: 'put'; key: string; val: string } | { op: 'delete'; key: string };
  const key = fc.constantFrom('a', 'b', 'c', 'd', 'e');
  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ op: fc.constant<'put'>('put'), key, val: fc.string({ minLength: 1, maxLength: 3 }) }),
    fc.record({ op: fc.constant<'delete'>('delete'), key }),
  );
  fc.assert(
    fc.property(fc.array(opArb, { minLength: 1, maxLength: 40 }), (ops) => {
      let s: LsmState = lsmInit(cfg);
      const ref = new Map<string, string | null>();
      for (const op of ops) {
        s = lsmReduce(s, ev(op))[0];
        ref.set(op.key, op.op === 'put' ? op.val : null);
        // drain any scheduled flush/compact deterministically
        for (const t of ['flush-phase2', 'compact'] as const)
          s = lsmReduce(s, { kind: 'timer', self: LSM, time: 1, payload: { timer: t } })[0];
      }
      for (const [k, v] of ref) expect(lsmGet(s, k).value).toBe(v ?? undefined);
    }),
    { numRuns: 100 },
  );
});

test('property: same op sequence → byte-identical serialized state (determinism)', () => {
  const opArb = fc.record({ key: fc.constantFrom('a', 'b', 'c'), val: fc.string({ minLength: 1, maxLength: 3 }) });
  fc.assert(
    fc.property(fc.array(opArb, { minLength: 1, maxLength: 30 }), (ops) => {
      const run = () => {
        let s: LsmState = lsmInit(cfg);
        for (const o of ops) {
          s = lsmReduce(s, ev({ op: 'put', ...o }))[0];
          s = lsmReduce(s, { kind: 'timer', self: LSM, time: 1, payload: { timer: 'flush-phase2' } })[0];
        }
        return JSON.stringify(s);
      };
      expect(run()).toBe(run());
    }),
    { numRuns: 100 },
  );
});
