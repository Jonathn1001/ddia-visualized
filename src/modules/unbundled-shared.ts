// Ch12 — unbundled-database vocabulary: one DB node, the append-only log, the
// three derived-view shapes, and the pure reference derivers. Nothing here mutates.
import type { NodeId } from '../engine/events';

export const DB: NodeId = 'DB';
export const UNBUNDLED_NODES: NodeId[] = [DB];

export type ViewId = 'search' | 'cache' | 'analytics';
export const VIEWS: ViewId[] = ['search', 'cache', 'analytics'];

export type Category = 'book' | 'toy' | 'tool';
export const CATEGORIES: Category[] = ['book', 'toy', 'tool'];

export type Key = string; // 'p1'..'pN'
export interface RecordValue {
  title: string;
  category: Category;
}
export interface LogRecord {
  offset: number;
  key: Key;
  value: RecordValue;
}

/** Preloaded so panels show content on mount; views init caught-up to these. */
export const SEED_WRITES: { key: Key; value: RecordValue }[] = [
  { key: 'p1', value: { title: 'raft consensus', category: 'book' } },
  { key: 'p2', value: { title: 'lego bricks', category: 'toy' } },
  { key: 'p3', value: { title: 'claw hammer', category: 'tool' } },
  { key: 'p4', value: { title: 'saga pattern', category: 'book' } },
];

/** Ticks between one view applying one record — the visible lag cadence. */
export const ADVANCE_EVERY = 10;

// ---- derived-view value shapes ----
export type SearchIndex = Record<string, Key[]>; // term -> keys (unique, sorted)
export type CacheMap = Record<Key, RecordValue>; // key  -> latest value
export type Tally = Record<Category, number>; // category -> count

export function emptyTally(): Tally {
  return { book: 0, toy: 0, tool: 0 };
}

export function tokenize(title: string): string[] {
  return title.toLowerCase().split(/\s+/).filter(Boolean);
}

// ---- pure reference derivers: property + rebuild tests assert equality here ----
export function deriveSearch(prefix: LogRecord[]): SearchIndex {
  // Latest-write-wins: a key contributes only its LAST value's terms.
  const latest = new Map<Key, RecordValue>();
  for (const r of prefix) latest.set(r.key, r.value);
  const idx: SearchIndex = {};
  for (const [key, value] of latest) {
    for (const term of tokenize(value.title)) (idx[term] ??= []).push(key);
  }
  for (const term of Object.keys(idx)) idx[term] = [...new Set(idx[term])].sort();
  return idx;
}

export function deriveCache(prefix: LogRecord[]): CacheMap {
  const map: CacheMap = {};
  for (const r of prefix) map[r.key] = r.value;
  return map;
}

export function deriveAnalytics(prefix: LogRecord[]): Tally {
  const tally = emptyTally();
  for (const r of prefix) tally[r.value.category] += 1;
  return tally;
}
