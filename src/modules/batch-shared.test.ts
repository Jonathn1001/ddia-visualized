import { expect, test } from 'vitest';
import {
  ACCESS_LOG, BATCH_NODES, EXPECTED_COUNTS, JT, MAP_TASKS, PARTITION_OF,
  REDUCE_INPUT, SPLITS, URLS, WORKERS, mapPartitions,
} from './batch-shared';

test('topology: JT plus three workers', () => {
  expect(BATCH_NODES).toEqual([JT, ...WORKERS]);
  expect(WORKERS).toEqual(['W1', 'W2', 'W3']);
});

test('the access log is 24 records in 3 splits of 8, with the designed skew', () => {
  expect(ACCESS_LOG).toHaveLength(24);
  expect(SPLITS).toHaveLength(3);
  for (const s of SPLITS) {
    expect(s).toHaveLength(8);
  }
  const counts: Record<string, number> = {};
  for (const u of ACCESS_LOG) {
    counts[u] = (counts[u] ?? 0) + 1;
  }
  expect(counts).toEqual(EXPECTED_COUNTS);
  expect(EXPECTED_COUNTS['/home']).toBe(10); // the hot key
});

test('partitioning is total and skewed 16/8', () => {
  for (const u of URLS) {
    expect([0, 1]).toContain(PARTITION_OF[u]);
  }
  let r0 = 0;
  let r1 = 0;
  for (const u of ACCESS_LOG) {
    if (PARTITION_OF[u] === 0) {
      r0++;
    } else {
      r1++;
    }
  }
  expect(r0).toBe(REDUCE_INPUT.r0);
  expect(r1).toBe(REDUCE_INPUT.r1);
  expect(REDUCE_INPUT).toEqual({ r0: 16, r1: 8 });
});

test('mapPartitions splits a split by reducer and preserves totals', () => {
  const [p0, p1] = mapPartitions(SPLITS[0]);
  const total = [...Object.values(p0), ...Object.values(p1)].reduce((a, b) => a + b, 0);
  expect(total).toBe(8);
  for (const u of Object.keys(p0)) {
    expect(PARTITION_OF[u as keyof typeof PARTITION_OF]).toBe(0);
  }
  for (const u of Object.keys(p1)) {
    expect(PARTITION_OF[u as keyof typeof PARTITION_OF]).toBe(1);
  }
});

test('fixtures are frozen — the twin branches can never share-and-mutate them', () => {
  expect(Object.isFrozen(ACCESS_LOG)).toBe(true);
  expect(Object.isFrozen(SPLITS)).toBe(true);
  expect(Object.isFrozen(SPLITS[0])).toBe(true);
  expect(MAP_TASKS).toEqual(['m0', 'm1', 'm2']);
});
