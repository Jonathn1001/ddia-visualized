import { describe, expect, test } from 'vitest';
import {
  ADVANCE_EVERY,
  CATEGORIES,
  DB,
  SEED_WRITES,
  UNBUNDLED_NODES,
  VIEWS,
  deriveAnalytics,
  deriveCache,
  deriveSearch,
  emptyTally,
  tokenize,
  type LogRecord,
} from './unbundled-shared';

const log = (...rs: { key: string; value: { title: string; category: 'book' | 'toy' | 'tool' } }[]): LogRecord[] =>
  rs.map((r, offset) => ({ offset, ...r }));

describe('topology + constants', () => {
  test('single node DB', () => {
    expect(DB).toBe('DB');
    expect(UNBUNDLED_NODES).toEqual(['DB']);
  });
  test('three views, three categories, positive cadence', () => {
    expect(VIEWS).toEqual(['search', 'cache', 'analytics']);
    expect(CATEGORIES).toEqual(['book', 'toy', 'tool']);
    expect(ADVANCE_EVERY).toBeGreaterThan(0);
  });
  test('seed writes are non-empty and unique-keyed', () => {
    const keys = SEED_WRITES.map((w) => w.key);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('pure derivers', () => {
  test('tokenize lowercases and splits on whitespace', () => {
    expect(tokenize('Raft Consensus')).toEqual(['raft', 'consensus']);
    expect(tokenize('  spaced   out ')).toEqual(['spaced', 'out']);
  });
  test('deriveCache is last-write-wins per key', () => {
    const l = log(
      { key: 'p1', value: { title: 'old', category: 'book' } },
      { key: 'p1', value: { title: 'new', category: 'toy' } },
    );
    expect(deriveCache(l)).toEqual({ p1: { title: 'new', category: 'toy' } });
  });
  test('deriveAnalytics counts every record by category', () => {
    const l = log(
      { key: 'p1', value: { title: 'a', category: 'book' } },
      { key: 'p2', value: { title: 'b', category: 'book' } },
      { key: 'p3', value: { title: 'c', category: 'toy' } },
    );
    expect(deriveAnalytics(l)).toEqual({ book: 2, toy: 1, tool: 0 });
  });
  test('deriveSearch is an inverted index with latest-write-wins re-keying', () => {
    const l = log(
      { key: 'p1', value: { title: 'raft log', category: 'book' } },
      { key: 'p2', value: { title: 'raft toy', category: 'toy' } },
      { key: 'p1', value: { title: 'paxos', category: 'book' } }, // p1 re-keyed: raft/log dropped
    );
    const idx = deriveSearch(l);
    expect(idx['raft']).toEqual(['p2']); // p1 no longer matches raft
    expect(idx['paxos']).toEqual(['p1']);
    expect(idx['log']).toBeUndefined();
  });
  test('emptyTally is all zeros', () => {
    expect(emptyTally()).toEqual({ book: 0, toy: 0, tool: 0 });
  });
});
