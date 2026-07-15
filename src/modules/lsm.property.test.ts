// src/modules/lsm.property.test.ts
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { lsmInit, lsmReduce, lsmGet, buildBloom, bloomMightContain, type LsmState } from './lsm';
import { STORAGE_TOPOLOGY, LSM, type StoragePayload } from './storage-shared';
import type { Effect } from '../engine/module';

const cfg = { nodeIds: STORAGE_TOPOLOGY };
const ev = (payload: StoragePayload) => ({ kind: 'external' as const, self: LSM, time: 0, payload });
const timerEv = (payload: StoragePayload) => ({ kind: 'timer' as const, self: LSM, time: 1, payload });

/**
 * Deliver the timer effects `lsmReduce` actually scheduled, instead of blindly injecting
 * every known timer after every op. A delivered timer can itself schedule another timer
 * (a flush that fills L0 to `L0_TRIGGER` schedules a compact), so keep delivering until
 * no more timer effects come back. Capped so a genuine runaway (a bug that keeps
 * rescheduling forever) fails the test loudly instead of hanging.
 */
const MAX_DRAIN_ITERATIONS = 50;
function drainTimers(state: LsmState, effects: Effect[]): LsmState {
  let s = state;
  let pending = effects;
  let iterations = 0;
  while (pending.length > 0) {
    if (iterations++ >= MAX_DRAIN_ITERATIONS) {
      throw new Error(`drainTimers: exceeded ${MAX_DRAIN_ITERATIONS} iterations — possible runaway timer scheduling`);
    }
    const next: Effect[] = [];
    for (const eff of pending) {
      if (eff.type !== 'timer') continue;
      const [s2, effs2] = lsmReduce(s, timerEv(eff.payload as StoragePayload));
      s = s2;
      next.push(...effs2);
    }
    pending = next;
  }
  return s;
}

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
    // size: 'max' — fast-check's default size heuristic generates arrays far shorter than
    // maxLength (empirically ~6 avg / 12 max for maxLength: 60); without forcing max size the
    // memtable rarely fills enough to reach MEMTABLE_CAP/L0_TRIGGER and this stays vacuous.
    fc.property(fc.array(opArb, { minLength: 1, maxLength: 60, size: 'max' }), (ops) => {
      let s: LsmState = lsmInit(cfg);
      const ref = new Map<string, string | null>();
      for (const op of ops) {
        const [next, effects] = lsmReduce(s, ev(op));
        // drain whatever flush/compact the engine actually scheduled — this lets the
        // memtable genuinely fill to MEMTABLE_CAP and L0 accumulate to L0_TRIGGER
        // before a flush/compact fires, instead of forcing one after every op.
        s = drainTimers(next, effects);
        ref.set(op.key, op.op === 'put' ? op.val : null);
      }
      for (const [k, v] of ref) expect(lsmGet(s, k).value).toBe(v ?? undefined);
    }),
    { numRuns: 100 },
  );
});

test('property: same op sequence → byte-identical serialized state (determinism)', () => {
  // 5-key domain (not 3) so the memtable can actually exceed MEMTABLE_CAP=4 and drive a
  // real flush; wide enough op count so L0 can reach L0_TRIGGER=3 and a real compact fires.
  const opArb = fc.record({ key: fc.constantFrom('a', 'b', 'c', 'd', 'e'), val: fc.string({ minLength: 1, maxLength: 3 }) });
  fc.assert(
    fc.property(fc.array(opArb, { minLength: 1, maxLength: 60, size: 'max' }), (ops) => {
      const run = () => {
        let s: LsmState = lsmInit(cfg);
        for (const o of ops) {
          const [next, effects] = lsmReduce(s, ev({ op: 'put', ...o }));
          s = drainTimers(next, effects);
        }
        return JSON.stringify(s);
      };
      expect(run()).toBe(run());
    }),
    { numRuns: 100 },
  );
});
