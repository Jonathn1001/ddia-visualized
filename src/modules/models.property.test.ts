import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import { USER_IDS, runGraph, runDocument, runRelational, type QueryId } from './models-shared';

const userArb = fc.constantFrom(...USER_IDS);
const queryArb = fc.constantFrom<QueryId>('fof', 'm2m');

describe('data-model invariants', () => {
  test('(a) same answer across all three models for any query + root', () => {
    fc.assert(
      fc.property(queryArb, userArb, (q, root) => {
        const g = runGraph(q, root).result;
        const d = runDocument(q, root).result;
        const r = runRelational(q, root).result;
        expect(d).toEqual(g);
        expect(r).toEqual(g);
      }),
      { numRuns: 60 },
    );
  });

  test('(b) trace determinism: same (query, root) → identical trace', () => {
    fc.assert(
      fc.property(queryArb, userArb, (q, root) => {
        expect(JSON.stringify(runDocument(q, root))).toEqual(JSON.stringify(runDocument(q, root)));
        expect(JSON.stringify(runGraph(q, root))).toEqual(JSON.stringify(runGraph(q, root)));
        expect(JSON.stringify(runRelational(q, root))).toEqual(JSON.stringify(runRelational(q, root)));
      }),
      { numRuns: 40 },
    );
  });

  test('(c) result is sorted + de-duplicated; steps non-empty', () => {
    fc.assert(
      fc.property(queryArb, userArb, (q, root) => {
        for (const run of [runGraph, runDocument, runRelational]) {
          const t = run(q, root);
          expect([...t.result]).toEqual([...new Set(t.result)].sort());
          expect(t.steps.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 40 },
    );
  });
});
