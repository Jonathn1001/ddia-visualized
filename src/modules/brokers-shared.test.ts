import { describe, expect, test } from 'vitest';
import { BROKER_TOPOLOGY, CONSUMERS, groupCounts, otherConsumer } from './brokers-shared';

describe('broker topology', () => {
  test('fixed P,B,C1,C2 topology', () => {
    expect(BROKER_TOPOLOGY).toEqual(['P', 'B', 'C1', 'C2']);
    expect(CONSUMERS).toEqual(['C1', 'C2']);
  });
  test('otherConsumer flips between the two consumers', () => {
    expect(otherConsumer('C1')).toBe('C2');
    expect(otherConsumer('C2')).toBe('C1');
  });
});

describe('groupCounts (competing consumers)', () => {
  test('empty group', () => {
    expect(groupCounts([[], []])).toEqual({ delivered: 0, duplicates: 0 });
  });
  test('disjoint processing: unique deliveries, no duplicates', () => {
    expect(groupCounts([['m0', 'm1'], ['m2']])).toEqual({ delivered: 3, duplicates: 0 });
  });
  test('same id processed twice across the group counts one duplicate', () => {
    expect(groupCounts([['m0'], ['m0', 'm1']])).toEqual({ delivered: 2, duplicates: 1 });
  });
  test('an id processed three times counts two extra occurrences', () => {
    expect(groupCounts([['m0', 'm0'], ['m0']])).toEqual({ delivered: 1, duplicates: 2 });
  });
});
