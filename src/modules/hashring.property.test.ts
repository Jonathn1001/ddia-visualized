// src/modules/hashring.property.test.ts
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { Simulation, type NodeId } from '../engine';
import { hashring, ringOwner, type HRPayload, type HRState } from './hashring';

const POOL = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

test('property: every key routes to exactly one member', () => {
  fc.assert(
    fc.property(
      fc.subarray(POOL, { minLength: 1, maxLength: 8 }),
      fc.integer({ min: 1, max: 8 }),
      fc.string({ minLength: 1, maxLength: 12 }),
      (members, vnodes, key) => {
        const owner = ringOwner(key, members, vnodes);
        expect(members).toContain(owner);
        expect(ringOwner(key, members, vnodes)).toBe(owner); // deterministic
      },
    ),
    { numRuns: 200 },
  );
});

test('property: adding a node moves keys only onto the added node', () => {
  fc.assert(
    fc.property(
      fc.subarray(POOL, { minLength: 2, maxLength: 7 }),
      fc.integer({ min: 1, max: 8 }),
      fc.integer({ min: 0, max: 1000 }),
      (members, vnodes, salt) => {
        const added = POOL.find((n) => !members.includes(n))!;
        const after = [...members, added].sort();
        for (let i = 0; i < 40; i++) {
          const k = `k${salt}-${i}`;
          const was = ringOwner(k, members, vnodes);
          const now = ringOwner(k, after, vnodes);
          if (now !== was) expect(now).toBe(added);
        }
      },
    ),
    { numRuns: 200 },
  );
});

test('property: sequential ops, no chaos — every put key is stored exactly once', () => {
  type Op = { kind: 'add' | 'remove'; node: string } | { kind: 'put'; n: number };
  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ kind: fc.constant<'add'>('add'), node: fc.constantFrom(...POOL) }),
    fc.record({ kind: fc.constant<'remove'>('remove'), node: fc.constantFrom(...POOL) }),
    fc.record({ kind: fc.constant<'put'>('put'), n: fc.integer({ min: 1, max: 8 }) }),
  );
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 2 ** 30 }),
      fc.integer({ min: 1, max: 4 }),
      fc.array(opArb, { minLength: 2, maxLength: 10 }),
      (seed, vnodes, ops) => {
        const sim = new Simulation<HRState, HRPayload>({
          module: hashring,
          config: { nodeIds: POOL, params: { vnodes } },
          seed,
          network: { latency: [1, 40] },
        });
        sim.runSteps(POOL.length);
        const put = new Set<string>();
        let t = 0;
        let nextKey = 0;
        for (const op of ops) {
          if (op.kind === 'put') {
            for (let i = 0; i < op.n; i++) {
              const k = `k${nextKey++}`;
              put.add(k);
              sim.external('A', { cmd: 'put', key: k });
            }
          } else {
            sim.external('A', op.kind === 'add' ? { cmd: 'addNode', node: op.node } : { cmd: 'removeNode', node: op.node });
          }
          t += 1500;
          sim.runUntil(t); // sequential: quiesce between ops
        }
        const holders = new Map<string, NodeId[]>();
        for (const id of POOL)
          for (const k of sim.getState(id).keys) holders.set(k, [...(holders.get(k) ?? []), id]);
        expect(holders.size).toBe(put.size);
        for (const [k, hs] of holders) {
          expect(put.has(k)).toBe(true);
          expect(hs).toHaveLength(1);
        }
      },
    ),
    { numRuns: 50 },
  );
});
