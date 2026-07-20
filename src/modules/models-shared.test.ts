import { describe, expect, test } from 'vitest';
import {
  MODELS,
  USER_IDS,
  FOF_MULT,
  M2M_MULT,
  runGraph,
  runDocument,
  runRelational,
  migrationCost,
  type QueryId,
} from './models-shared';

const runners = { graph: runGraph, document: runDocument, relational: runRelational };

describe('runners return the same answer, different round trips', () => {
  test('fof(alice) = {dan,eve,frank} in all three', () => {
    for (const run of Object.values(runners)) {
      expect(run('fof', 'alice').result).toEqual(['dan', 'eve', 'frank']);
    }
  });
  test('m2m (likes a tech post) = {bob,dan,frank} in all three', () => {
    for (const run of Object.values(runners)) {
      expect(run('m2m', 'alice').result).toEqual(['bob', 'dan', 'frank']);
    }
  });
  test('document pays N+1 round trips; graph & relational pay 1', () => {
    expect(runGraph('fof', 'alice').roundTrips).toBe(1);
    expect(runRelational('fof', 'alice').roundTrips).toBe(1);
    expect(runDocument('fof', 'alice').roundTrips).toBeGreaterThanOrEqual(FOF_MULT * 1 + 1);
    expect(runDocument('m2m', 'alice').roundTrips).toBeGreaterThanOrEqual(M2M_MULT * 1 + 1);
  });
  test('every trace has non-empty steps for the animation cursor', () => {
    for (const q of ['fof', 'm2m'] as QueryId[])
      for (const run of Object.values(runners)) {
        expect(run(q, 'alice').steps.length).toBeGreaterThan(0);
      }
  });
});

describe('migrationCost — schema-on-read vs schema-on-write', () => {
  test('adding a field costs 0 for document/graph, >0 for relational', () => {
    expect(migrationCost('document', true)).toBe(0);
    expect(migrationCost('graph', true)).toBe(0);
    expect(migrationCost('relational', true)).toBe(USER_IDS.length);
    for (const m of MODELS) expect(migrationCost(m, false)).toBe(0);
  });
});
