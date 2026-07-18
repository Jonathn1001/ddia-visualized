# Ch12 Unbundled Database Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship DDIA Chapter 12 (The Future of Data Systems) as the capstone lab `12.1 Unbundled Database`: one `upsert` write enters an append-only changelog and fans out to three derived views (search index / cache / analytics) that each lag the source — teaching that derived data is a lagging, disposable projection of the one log that is the source of truth.

**Architecture:** One `SimModule` on a single sim node `DB` (spec §2, plan-time decision). `DB` owns the append-only `log` plus three view sub-states, each with its own `offset`, `paused`, `dedup`, and contents. A per-view `{t:'advance'}` timer (armed on the `init` event, re-armed every `ADVANCE_EVERY` ticks) applies `log[offset]` and advances `offset` toward head unless paused. All reader actions (write / pause / resume / wipe / redeliver / toggle-dedup) are external commands to `DB`. Queries are read-only, computed in the UI from the `inspect` tree. No network — pacing is internal timer effects. The three-lane fan-out is a UI rendering of `DB`'s inspect tree.

**Tech Stack:** TypeScript, React 18, Vite, Vitest + jsdom, fast-check (property tests), Tailwind utility classes, MDX (debrief). Existing `Simulation`/`SimModule` engine (`src/engine`), `SimDriver`/`useSimStore` bridge, `ChallengePanel`/`TimelineScrubber`/`MetricsPanel`/`DebriefArticle`/`SurpriseJournal` kit.

## Global Constraints

- **Single sim node:** `nodeIds: ['DB']`. Module `chaos: []` (no ChaosToolbar).
- **Determinism:** module ignores `rng` (pure). No `Date.now`/`Math.random`.
- **Module contract:** `SimModule<S,P>` — `init(nodeId, config, rng): S`, `reduce(state, event, rng): [S, Effect[]]`, `metrics(states, time): MetricSample[]`, `inspect(state): InspectorTree`. Timers armed in `reduce` on `event.kind === 'init'` (batch/ping-pong precedent — `init()` returns state only, no effects).
- **Effects:** `{ type:'timer'; delay:number; payload }` for pacing; no `send` (single node).
- **Immutability:** `reduce` returns new state objects (never mutate inputs).
- **Lab-mount drain:** the lab drains exactly `UNBUNDLED_NODES.length` (== 1) init events on mount to arm the advance timers, then holds (advance timers keep the queue non-empty forever, so do NOT loop-drain to empty).
- **Challenge wins are UI-flag-gated per epoch** (Ch3/Ch8/Ch9 lesson: engine-verified `check()` only fires after the reader set the epoch flag by driving the sequence; no auto-win off stale state).
- **Forward-only `TimelineScrubber`** (Ch8 lesson: backward scrub desyncs React-side challenge flags).
- **ids:** `12.1` (lab) + `12.d` (debrief), journal key `ddia:ch12:journal`, challenge key prefixes `ddia:ch12:staleread` / `ddia:ch12:rebuild` / `ddia:ch12:exactlyonce`.
- **Gate each task:** `npx vitest run <touched files>` green, then before commit `npx tsc -b && npx eslint <touched files>`. Full-suite gate (`npx vitest run && npx tsc -b && npm run build`) at Task 10.
- **Commits:** conventional; end body with the two trailers used across this repo (`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` / `Claude-Session: …`). Commit specific files, never `-A`.

---

### Task 1: Shared vocabulary — topology, fixture, types, pure derivers

**Files:**
- Create: `src/modules/unbundled-shared.ts`
- Test: `src/modules/unbundled-shared.test.ts`

**Interfaces:**
- Produces (consumed by every later task):
  - `DB: NodeId`, `UNBUNDLED_NODES: NodeId[]` (`['DB']`)
  - `ViewId = 'search' | 'cache' | 'analytics'`, `VIEWS: ViewId[]`
  - `Category = 'book' | 'toy' | 'tool'`, `CATEGORIES: Category[]`
  - `Key = string`, `RecordValue = { title: string; category: Category }`, `LogRecord = { offset: number; key: Key; value: RecordValue }`
  - `SEED_WRITES: { key: Key; value: RecordValue }[]`, `ADVANCE_EVERY: number`
  - `SearchIndex = Record<string, Key[]>`, `CacheMap = Record<Key, RecordValue>`, `Tally = Record<Category, number>`
  - `tokenize(title): string[]`, `deriveSearch(prefix): SearchIndex`, `deriveCache(prefix): CacheMap`, `deriveAnalytics(prefix): Tally`, `emptyTally(): Tally`

- [ ] **Step 1: Write the failing test**

Create `src/modules/unbundled-shared.test.ts`:

```ts
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
```

- [ ] **Step 2: RED** — Run: `npx vitest run src/modules/unbundled-shared.test.ts`. Expected: FAIL — cannot resolve `./unbundled-shared`.

- [ ] **Step 3: Implement**

Create `src/modules/unbundled-shared.ts`:

```ts
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
```

- [ ] **Step 4: GREEN + tsc + eslint.** Run: `npx vitest run src/modules/unbundled-shared.test.ts` (PASS), then `npx tsc -b` (0 errors), `npx eslint src/modules/unbundled-shared.ts src/modules/unbundled-shared.test.ts` (0).

- [ ] **Step 5: Commit**

```bash
git add src/modules/unbundled-shared.ts src/modules/unbundled-shared.test.ts
git commit -m "feat(modules): Ch12 shared vocab — DB node, log record, view shapes, pure derivers"
```

---

### Task 2: The unbundled module — state, init, advance, all commands

**Files:**
- Create: `src/modules/unbundled.ts`
- Test: `src/modules/unbundled.test.ts`

**Interfaces:**
- Consumes (Task 1): `DB`, `UNBUNDLED_NODES`, `VIEWS`, `ViewId`, `Key`, `RecordValue`, `LogRecord`, `SearchIndex`, `CacheMap`, `Tally`, `SEED_WRITES`, `ADVANCE_EVERY`, `emptyTally`, `tokenize`.
- Produces (later tasks):
  - `interface ViewCommon { offset: number; paused: boolean; dedup: boolean }`
  - `interface SearchView extends ViewCommon { index: SearchIndex; keyTerms: Record<Key, string[]> }`
  - `interface CacheView extends ViewCommon { map: CacheMap }`
  - `interface AnalyticsView extends ViewCommon { tally: Tally }`
  - `interface DbState { self: NodeId; log: LogRecord[]; search: SearchView; cache: CacheView; analytics: AnalyticsView }`
  - `type UnbundledExternal = { cmd:'write'; key:Key; value:RecordValue } | { cmd:'pause'|'resume'|'wipe'|'redeliver'|'toggle-dedup'; view:ViewId }`
  - `type UnbundledTimer = { t:'advance'; view:ViewId }`
  - `type UnbundledPayload = UnbundledExternal | UnbundledTimer`
  - `interface ViewInspect { offset:number; paused:boolean; dedup:boolean }` plus per-view content in the inspect tree
  - `interface DbInspect { head:number; log:LogRecord[]; search: ViewInspect & { index:SearchIndex }; cache: ViewInspect & { map:CacheMap }; analytics: ViewInspect & { tally:Tally } }`
  - `unbundled: SimModule<DbState, UnbundledPayload>`
  - helpers: `deriveAnalytics` re-exported? NO — tests import derivers from `unbundled-shared`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/unbundled.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { Simulation } from '../engine';
import {
  ADVANCE_EVERY,
  DB,
  SEED_WRITES,
  UNBUNDLED_NODES,
  deriveAnalytics,
  deriveCache,
  deriveSearch,
} from './unbundled-shared';
import { unbundled, type DbInspect, type DbState, type UnbundledPayload } from './unbundled';

function makeSim(seed = 1): Simulation<DbState, UnbundledPayload> {
  return new Simulation<DbState, UnbundledPayload>({ module: unbundled, config: { nodeIds: UNBUNDLED_NODES }, seed });
}
/** Drain the init event (arms the 3 advance timers), leaving views caught up to the seed. */
function boot(sim: Simulation<DbState, UnbundledPayload>) {
  sim.runSteps(UNBUNDLED_NODES.length);
}
const db = (sim: Simulation<DbState, UnbundledPayload>) => sim.getState(DB);

describe('init', () => {
  test('log holds the seed; views start caught up to it', () => {
    const sim = makeSim();
    boot(sim);
    const s = db(sim);
    expect(s.log).toHaveLength(SEED_WRITES.length);
    expect(s.log[0]).toEqual({ offset: 0, key: SEED_WRITES[0].key, value: SEED_WRITES[0].value });
    // views caught up: offset == head, contents == derive(seed)
    expect(s.search.offset).toBe(SEED_WRITES.length);
    expect(s.cache.map).toEqual(deriveCache(s.log));
    expect(s.analytics.tally).toEqual(deriveAnalytics(s.log));
    expect(s.search.index).toEqual(deriveSearch(s.log));
    for (const v of [s.search, s.cache, s.analytics]) {
      expect(v.paused).toBe(false);
      expect(v.dedup).toBe(false);
    }
  });
  test('inspect exposes head + per-view offset/paused/dedup + contents', () => {
    const sim = makeSim();
    boot(sim);
    const tree = unbundled.inspect(db(sim)) as unknown as DbInspect;
    expect(tree.head).toBe(SEED_WRITES.length);
    expect(tree.cache.offset).toBe(SEED_WRITES.length);
    expect(tree.analytics.tally).toEqual(deriveAnalytics(db(sim).log));
  });
});

describe('write appends to the log and bumps head; views trail', () => {
  test('a fresh write is in the log immediately but not yet in a paused view', () => {
    const sim = makeSim();
    boot(sim);
    sim.external(DB, { cmd: 'pause', view: 'cache' });
    sim.external(DB, { cmd: 'write', key: 'p9', value: { title: 'kafka streams', category: 'tool' } });
    const s = db(sim);
    expect(s.log.at(-1)!.key).toBe('p9'); // source of truth has it
    expect(s.cache.map['p9']).toBeUndefined(); // paused view has NOT caught up
    expect(s.log.length - s.cache.offset).toBeGreaterThanOrEqual(1); // lag > 0
  });
});

describe('advance timer catches an unpaused view up to head', () => {
  test('after enough ticks every view equals its reference derivation', () => {
    const sim = makeSim();
    boot(sim);
    sim.external(DB, { cmd: 'write', key: 'p9', value: { title: 'kafka streams', category: 'tool' } });
    sim.runSteps(ADVANCE_EVERY * 30); // plenty of advance fires
    const s = db(sim);
    expect(s.cache.offset).toBe(s.log.length);
    expect(s.cache.map).toEqual(deriveCache(s.log));
    expect(s.search.index).toEqual(deriveSearch(s.log));
    expect(s.analytics.tally).toEqual(deriveAnalytics(s.log));
  });
  test('a paused view holds its offset while others advance', () => {
    const sim = makeSim();
    boot(sim);
    sim.external(DB, { cmd: 'pause', view: 'search' });
    sim.external(DB, { cmd: 'write', key: 'p9', value: { title: 'kafka streams', category: 'tool' } });
    const before = db(sim).search.offset;
    sim.runSteps(ADVANCE_EVERY * 30);
    const s = db(sim);
    expect(s.search.offset).toBe(before); // frozen
    expect(s.cache.offset).toBe(s.log.length); // caught up
  });
});

describe('resume drains the backlog', () => {
  test('resuming a paused view lets it catch up', () => {
    const sim = makeSim();
    boot(sim);
    sim.external(DB, { cmd: 'pause', view: 'cache' });
    sim.external(DB, { cmd: 'write', key: 'p9', value: { title: 'redis stream', category: 'tool' } });
    sim.runSteps(ADVANCE_EVERY * 5);
    expect(db(sim).cache.map['p9']).toBeUndefined();
    sim.external(DB, { cmd: 'resume', view: 'cache' });
    sim.runSteps(ADVANCE_EVERY * 30);
    expect(db(sim).cache.map['p9']).toEqual({ title: 'redis stream', category: 'tool' });
  });
});
```

- [ ] **Step 2: RED** — Run: `npx vitest run src/modules/unbundled.test.ts`. Expected: FAIL — cannot resolve `./unbundled`.

- [ ] **Step 3: Implement**

Create `src/modules/unbundled.ts`:

```ts
import type { NodeId } from '../engine/events';
import type { Effect, InspectorTree, ModuleEvent, SimModule } from '../engine/module';
import {
  ADVANCE_EVERY,
  DB,
  SEED_WRITES,
  VIEWS,
  emptyTally,
  tokenize,
  type CacheMap,
  type Key,
  type LogRecord,
  type RecordValue,
  type SearchIndex,
  type Tally,
  type ViewId,
} from './unbundled-shared';

export interface ViewCommon {
  offset: number;
  paused: boolean;
  dedup: boolean;
}
export interface SearchView extends ViewCommon {
  index: SearchIndex;
  keyTerms: Record<Key, string[]>; // key -> terms it currently occupies (re-keying bookkeeping)
}
export interface CacheView extends ViewCommon {
  map: CacheMap;
}
export interface AnalyticsView extends ViewCommon {
  tally: Tally;
}
export interface DbState {
  self: NodeId;
  log: LogRecord[];
  search: SearchView;
  cache: CacheView;
  analytics: AnalyticsView;
}

export type UnbundledExternal =
  | { cmd: 'write'; key: Key; value: RecordValue }
  | { cmd: 'pause'; view: ViewId }
  | { cmd: 'resume'; view: ViewId }
  | { cmd: 'wipe'; view: ViewId }
  | { cmd: 'redeliver'; view: ViewId }
  | { cmd: 'toggle-dedup'; view: ViewId };
export type UnbundledTimer = { t: 'advance'; view: ViewId };
export type UnbundledPayload = UnbundledExternal | UnbundledTimer;

export interface ViewInspect {
  offset: number;
  paused: boolean;
  dedup: boolean;
}
export interface DbInspect {
  head: number;
  log: LogRecord[];
  search: ViewInspect & { index: SearchIndex };
  cache: ViewInspect & { map: CacheMap };
  analytics: ViewInspect & { tally: Tally };
}

// ---- fresh (empty, offset 0) views ----
function freshSearch(): SearchView {
  return { offset: 0, paused: false, dedup: false, index: {}, keyTerms: {} };
}
function freshCache(): CacheView {
  return { offset: 0, paused: false, dedup: false, map: {} };
}
function freshAnalytics(): AnalyticsView {
  return { offset: 0, paused: false, dedup: false, tally: emptyTally() };
}

// ---- apply ONE record to a view's CONTENT (offset untouched) ----
function applySearchContent(v: SearchView, r: LogRecord): SearchView {
  const index: SearchIndex = { ...v.index };
  const oldTerms = v.keyTerms[r.key] ?? [];
  for (const t of oldTerms) {
    const arr = (index[t] ?? []).filter((k) => k !== r.key);
    if (arr.length) index[t] = arr;
    else delete index[t];
  }
  const newTerms = tokenize(r.value.title);
  for (const t of newTerms) index[t] = [...new Set([...(index[t] ?? []), r.key])].sort();
  return { ...v, index, keyTerms: { ...v.keyTerms, [r.key]: newTerms } };
}
function applyCacheContent(v: CacheView, r: LogRecord): CacheView {
  return { ...v, map: { ...v.map, [r.key]: r.value } };
}
function applyAnalyticsContent(v: AnalyticsView, r: LogRecord): AnalyticsView {
  return { ...v, tally: { ...v.tally, [r.value.category]: v.tally[r.value.category] + 1 } };
}

function getView(s: DbState, view: ViewId): ViewCommon {
  return view === 'search' ? s.search : view === 'cache' ? s.cache : s.analytics;
}

/** Apply the record at a view's frontier and advance its offset (no-op if paused / caught up). */
function advance(s: DbState, view: ViewId): DbState {
  const v = getView(s, view);
  if (v.paused || v.offset >= s.log.length) return s;
  const r = s.log[v.offset];
  if (view === 'search') return { ...s, search: { ...applySearchContent(s.search, r), offset: v.offset + 1 } };
  if (view === 'cache') return { ...s, cache: { ...applyCacheContent(s.cache, r), offset: v.offset + 1 } };
  return { ...s, analytics: { ...applyAnalyticsContent(s.analytics, r), offset: v.offset + 1 } };
}

/** Re-apply the last-consumed record WITHOUT advancing offset — a crash-retry.
 *  Idempotent (no-op) when dedup is on; double-applies when dedup is off. */
function redeliver(s: DbState, view: ViewId): DbState {
  const v = getView(s, view);
  if (v.offset === 0 || v.dedup) return s; // nothing applied yet, or dedup skips the replay
  const r = s.log[v.offset - 1];
  if (view === 'search') return { ...s, search: applySearchContent(s.search, r) };
  if (view === 'cache') return { ...s, cache: applyCacheContent(s.cache, r) };
  return { ...s, analytics: applyAnalyticsContent(s.analytics, r) };
}

function setFlag(s: DbState, view: ViewId, patch: Partial<ViewCommon>): DbState {
  if (view === 'search') return { ...s, search: { ...s.search, ...patch } };
  if (view === 'cache') return { ...s, cache: { ...s.cache, ...patch } };
  return { ...s, analytics: { ...s.analytics, ...patch } };
}

function wipe(s: DbState, view: ViewId): DbState {
  // Clear contents + reset offset to 0; keep dedup, force unpaused so it rebuilds.
  if (view === 'search') return { ...s, search: { ...freshSearch(), dedup: s.search.dedup } };
  if (view === 'cache') return { ...s, cache: { ...freshCache(), dedup: s.cache.dedup } };
  return { ...s, analytics: { ...freshAnalytics(), dedup: s.analytics.dedup } };
}

const advanceTimer = (view: ViewId): Effect => ({ type: 'timer', delay: ADVANCE_EVERY, payload: { t: 'advance', view } });

export const unbundled: SimModule<DbState, UnbundledPayload> = {
  id: 'unbundled-db',
  chaos: [],

  init(nodeId) {
    let s: DbState = {
      self: nodeId,
      log: SEED_WRITES.map((w, offset) => ({ offset, key: w.key, value: w.value })),
      search: freshSearch(),
      cache: freshCache(),
      analytics: freshAnalytics(),
    };
    // Catch every view up to the seed so panels render content on mount.
    for (const view of VIEWS) while (getView(s, view).offset < s.log.length) s = advance(s, view);
    return s;
  },

  reduce(state, event): [DbState, Effect[]] {
    if (event.kind === 'init') return [state, VIEWS.map(advanceTimer)];

    if (event.kind === 'timer') {
      const p = event.payload as UnbundledTimer;
      if (p.t === 'advance') return [advance(state, p.view), [advanceTimer(p.view)]]; // always re-arm
      return [state, []];
    }

    if (event.kind === 'external') {
      const p = event.payload as UnbundledExternal;
      switch (p.cmd) {
        case 'write': {
          const rec: LogRecord = { offset: state.log.length, key: p.key, value: p.value };
          return [{ ...state, log: [...state.log, rec] }, []];
        }
        case 'pause':
          return [setFlag(state, p.view, { paused: true }), []];
        case 'resume':
          return [setFlag(state, p.view, { paused: false }), []];
        case 'toggle-dedup':
          return [setFlag(state, p.view, { dedup: !getView(state, p.view).dedup }), []];
        case 'wipe':
          return [wipe(state, p.view), []];
        case 'redeliver':
          return [redeliver(state, p.view), []];
        default:
          return [state, []];
      }
    }
    return [state, []];
  },

  metrics(states) {
    const s = states.get(DB);
    if (!s) return [];
    const head = s.log.length;
    return [
      { name: 'head', value: head },
      { name: 'searchLag', value: head - s.search.offset },
      { name: 'cacheLag', value: head - s.cache.offset },
      { name: 'analyticsLag', value: head - s.analytics.offset },
    ];
  },

  inspect(state) {
    return {
      head: state.log.length,
      log: state.log,
      search: { offset: state.search.offset, paused: state.search.paused, dedup: state.search.dedup, index: state.search.index },
      cache: { offset: state.cache.offset, paused: state.cache.paused, dedup: state.cache.dedup, map: state.cache.map },
      analytics: {
        offset: state.analytics.offset,
        paused: state.analytics.paused,
        dedup: state.analytics.dedup,
        tally: state.analytics.tally,
      },
    } as unknown as InspectorTree;
  },
};
```

- [ ] **Step 4: GREEN + tsc + eslint.** Run: `npx vitest run src/modules/unbundled.test.ts` (PASS), `npx tsc -b` (0), `npx eslint src/modules/unbundled.ts src/modules/unbundled.test.ts` (0). Note: `ModuleEvent` import may be unused — if eslint flags it, drop it (kept in the interface via `reduce`'s param typing from `SimModule`).

- [ ] **Step 5: Commit**

```bash
git add src/modules/unbundled.ts src/modules/unbundled.test.ts
git commit -m "feat(modules): Ch12 unbundled DB module — log + three lagging views, timer-paced advance"
```

---

### Task 3: Behavioral gate — rebuild + redelivery (exactly-once)

The core lesson invariants beyond basic lag. Append to `unbundled.test.ts`. Green = Task 2 faithful; a failure is a real module bug — fix minimally toward spec §4/§6 and document.

**Files:**
- Modify: `src/modules/unbundled.test.ts`

- [ ] **Step 1: Append**

```ts
describe('rebuild: wipe a view then replay from offset 0', () => {
  test('a wiped cache rebuilds to an exact copy of the reference derivation', () => {
    const sim = makeSim();
    boot(sim);
    sim.external(DB, { cmd: 'write', key: 'p9', value: { title: 'flink jobs', category: 'tool' } });
    sim.runSteps(ADVANCE_EVERY * 30);
    const full = db(sim).log;
    sim.external(DB, { cmd: 'wipe', view: 'cache' });
    expect(db(sim).cache.offset).toBe(0);
    expect(db(sim).cache.map).toEqual({}); // disposable: gone
    sim.runSteps(ADVANCE_EVERY * 40);
    const s = db(sim);
    expect(s.cache.offset).toBe(s.log.length); // fully rebuilt
    expect(s.cache.map).toEqual(deriveCache(full)); // byte-exact from the log
  });
  test('search rebuilds its inverted index exactly after a wipe', () => {
    const sim = makeSim();
    boot(sim);
    sim.external(DB, { cmd: 'wipe', view: 'search' });
    sim.runSteps(ADVANCE_EVERY * 40);
    const s = db(sim);
    expect(s.search.index).toEqual(deriveSearch(s.log));
  });
});

describe('exactly-once: redelivery double-counts only without dedup', () => {
  test('dedup OFF: redelivering the last record over-counts analytics', () => {
    const sim = makeSim();
    boot(sim);
    sim.external(DB, { cmd: 'write', key: 'p9', value: { title: 'spark rdd', category: 'book' } });
    sim.runSteps(ADVANCE_EVERY * 30); // analytics caught up, exact
    expect(db(sim).analytics.tally).toEqual(deriveAnalytics(db(sim).log));
    sim.external(DB, { cmd: 'redeliver', view: 'analytics' });
    const s = db(sim);
    const truth = deriveAnalytics(s.log);
    expect(s.analytics.tally.book).toBe(truth.book + 1); // the replayed 'book' record counted twice
  });
  test('dedup ON: redelivering the last record is a no-op', () => {
    const sim = makeSim();
    boot(sim);
    sim.external(DB, { cmd: 'write', key: 'p9', value: { title: 'spark rdd', category: 'book' } });
    sim.runSteps(ADVANCE_EVERY * 30);
    sim.external(DB, { cmd: 'toggle-dedup', view: 'analytics' });
    sim.external(DB, { cmd: 'redeliver', view: 'analytics' });
    const s = db(sim);
    expect(s.analytics.tally).toEqual(deriveAnalytics(s.log)); // still exact
  });
  test('cache redelivery is naturally idempotent even without dedup', () => {
    const sim = makeSim();
    boot(sim);
    sim.runSteps(ADVANCE_EVERY * 20);
    const before = db(sim).cache.map;
    sim.external(DB, { cmd: 'redeliver', view: 'cache' }); // last-write-wins → no change
    expect(db(sim).cache.map).toEqual(before);
  });
});
```

- [ ] **Step 2: Run.** Run: `npx vitest run src/modules/unbundled.test.ts`. Green = faithful. If a case fails, the bug is real (likely suspects: `redeliver` reading `log[offset-1]` when offset is 0; `wipe` not resetting `keyTerms`; `advance` mutating shared references). Fix minimally, note the fix in the commit body.

- [ ] **Step 3: Commit**

```bash
git add src/modules/unbundled.test.ts
git commit -m "test(modules): Ch12 behavioral gate — rebuild-from-log + exactly-once redelivery"
```

---

### Task 4: Property suite — eventual consistency, rebuild exactness, exactly-once

**Files:**
- Create: `src/modules/unbundled.property.test.ts`

**Interfaces:** Consumes Task 1 derivers + Task 2 module. Uses `fast-check` (already a dep — see `src/modules/batch.property.test.ts`).

- [ ] **Step 1: Write**

Create `src/modules/unbundled.property.test.ts`:

```ts
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { Simulation } from '../engine';
import {
  ADVANCE_EVERY,
  CATEGORIES,
  DB,
  UNBUNDLED_NODES,
  VIEWS,
  deriveAnalytics,
  deriveCache,
  deriveSearch,
  type Category,
} from './unbundled-shared';
import { unbundled, type DbState, type UnbundledPayload } from './unbundled';

function makeSim(seed: number): Simulation<DbState, UnbundledPayload> {
  const sim = new Simulation<DbState, UnbundledPayload>({ module: unbundled, config: { nodeIds: UNBUNDLED_NODES }, seed });
  sim.runSteps(UNBUNDLED_NODES.length);
  return sim;
}
const CATZ: Category[] = CATEGORIES;
// A small script of writes: (key p0..p5, title from a tiny vocab, category).
const writeArb = fc.record({
  key: fc.integer({ min: 0, max: 5 }).map((n) => `p${n}`),
  title: fc.subarray(['raft', 'kafka', 'spark', 'flink', 'redis', 'saga'], { minLength: 1, maxLength: 2 }).map((ws) => ws.join(' ')),
  category: fc.constantFrom(...CATZ),
});
const scriptArb = fc.array(writeArb, { minLength: 1, maxLength: 8 });

function applyWrites(
  sim: Simulation<DbState, UnbundledPayload>,
  writes: { key: string; title: string; category: Category }[],
) {
  for (const w of writes) sim.external(DB, { cmd: 'write', key: w.key, value: { title: w.title, category: w.category } });
}
const CATCHUP = ADVANCE_EVERY * 60;

describe('property: eventual consistency', () => {
  test('after full catch-up every view equals its reference derivation', () => {
    fc.assert(
      fc.property(scriptArb, fc.integer({ min: 1, max: 999 }), (writes, seed) => {
        const sim = makeSim(seed);
        applyWrites(sim, writes);
        sim.runSteps(CATCHUP);
        const s = sim.getState(DB);
        expect(s.cache.map).toEqual(deriveCache(s.log));
        expect(s.analytics.tally).toEqual(deriveAnalytics(s.log));
        expect(s.search.index).toEqual(deriveSearch(s.log));
      }),
      { numRuns: 40 },
    );
  });
});

describe('property: rebuild exactness', () => {
  test('wiping any view at any time then replaying is exact', () => {
    fc.assert(
      fc.property(scriptArb, fc.constantFrom(...VIEWS), fc.integer({ min: 1, max: 999 }), (writes, view, seed) => {
        const sim = makeSim(seed);
        applyWrites(sim, writes);
        sim.runSteps(ADVANCE_EVERY * 10); // partial progress
        sim.external(DB, { cmd: 'wipe', view });
        sim.runSteps(CATCHUP);
        const s = sim.getState(DB);
        if (view === 'cache') expect(s.cache.map).toEqual(deriveCache(s.log));
        else if (view === 'analytics') expect(s.analytics.tally).toEqual(deriveAnalytics(s.log));
        else expect(s.search.index).toEqual(deriveSearch(s.log));
      }),
      { numRuns: 40 },
    );
  });
});

describe('property: exactly-once under dedup', () => {
  test('with dedup on, any number of redelivers leaves analytics exact', () => {
    fc.assert(
      fc.property(scriptArb, fc.integer({ min: 1, max: 6 }), fc.integer({ min: 1, max: 999 }), (writes, redeliveries, seed) => {
        const sim = makeSim(seed);
        applyWrites(sim, writes);
        sim.runSteps(CATCHUP);
        sim.external(DB, { cmd: 'toggle-dedup', view: 'analytics' });
        for (let i = 0; i < redeliveries; i++) sim.external(DB, { cmd: 'redeliver', view: 'analytics' });
        expect(sim.getState(DB).analytics.tally).toEqual(deriveAnalytics(sim.getState(DB).log));
      }),
      { numRuns: 40 },
    );
  });
});
```

- [ ] **Step 2: Run.** Run: `npx vitest run src/modules/unbundled.property.test.ts`. A counterexample is a REAL bug: shrink, report, fix minimally toward spec, document in the commit body. Note runtime; if the suite exceeds ~30s, halve `numRuns` and say so.

- [ ] **Step 3: Commit**

```bash
git add src/modules/unbundled.property.test.ts
git commit -m "test(modules): Ch12 property suite — eventual consistency, rebuild exactness, exactly-once"
```

---

### Task 5: Pinned lesson test — the three challenge scenarios

Each challenge scenario as its own sim, asserted clause-by-clause. This is the challenge-verifier contract the lab's `check()` functions must satisfy.

**Files:**
- Create: `src/modules/unbundled-lesson.test.ts`

- [ ] **Step 1: Write**

Create `src/modules/unbundled-lesson.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { Simulation } from '../engine';
import { ADVANCE_EVERY, DB, UNBUNDLED_NODES, deriveAnalytics, deriveCache } from './unbundled-shared';
import { unbundled, type DbState, type UnbundledPayload } from './unbundled';

function boot(seed = 7): Simulation<DbState, UnbundledPayload> {
  const sim = new Simulation<DbState, UnbundledPayload>({ module: unbundled, config: { nodeIds: UNBUNDLED_NODES }, seed });
  sim.runSteps(UNBUNDLED_NODES.length);
  return sim;
}
const db = (sim: Simulation<DbState, UnbundledPayload>) => sim.getState(DB);

describe('C1 — stale read (read-your-writes)', () => {
  test('paused search misses a fresh key the log already has, then hits after resume', () => {
    const sim = boot();
    sim.external(DB, { cmd: 'pause', view: 'search' });
    sim.external(DB, { cmd: 'write', key: 'p9', value: { title: 'zookeeper quorum', category: 'tool' } });
    // MISS: the log has p9, but the paused index does not.
    expect(db(sim).log.some((r) => r.key === 'p9')).toBe(true);
    expect(db(sim).search.index['zookeeper']).toBeUndefined();
    // Resume + play → HIT.
    sim.external(DB, { cmd: 'resume', view: 'search' });
    sim.runSteps(ADVANCE_EVERY * 40);
    expect(db(sim).search.index['zookeeper']).toEqual(['p9']);
  });
});

describe('C2 — rebuild from log', () => {
  test('a wiped cache rebuilds byte-exact and offset returns to head', () => {
    const sim = boot();
    sim.external(DB, { cmd: 'write', key: 'p9', value: { title: 'materialize view', category: 'book' } });
    sim.runSteps(ADVANCE_EVERY * 30);
    sim.external(DB, { cmd: 'wipe', view: 'cache' });
    expect(db(sim).cache.map).toEqual({});
    sim.runSteps(ADVANCE_EVERY * 40);
    const s = db(sim);
    expect(s.cache.offset).toBe(s.log.length);
    expect(s.cache.map).toEqual(deriveCache(s.log));
  });
});

describe('C3 — exactly-once', () => {
  test('over-count with dedup off; exact after dedup on + rebuild + redeliver', () => {
    const sim = boot();
    sim.external(DB, { cmd: 'write', key: 'p9', value: { title: 'debezium cdc', category: 'book' } });
    sim.runSteps(ADVANCE_EVERY * 30);
    // Phase A: dedup off, redeliver → over-count.
    sim.external(DB, { cmd: 'redeliver', view: 'analytics' });
    expect(db(sim).analytics.tally.book).toBe(deriveAnalytics(db(sim).log).book + 1);
    // Phase B: dedup on, wipe+replay to truth, redeliver again → stays exact.
    sim.external(DB, { cmd: 'toggle-dedup', view: 'analytics' });
    sim.external(DB, { cmd: 'wipe', view: 'analytics' });
    sim.runSteps(ADVANCE_EVERY * 40);
    sim.external(DB, { cmd: 'redeliver', view: 'analytics' });
    expect(db(sim).analytics.tally).toEqual(deriveAnalytics(db(sim).log));
  });
});
```

- [ ] **Step 2: Run; fix real bugs. Commit.** Run: `npx vitest run src/modules/unbundled-lesson.test.ts` (expect green — the module already satisfies these). Then:

```bash
git add src/modules/unbundled-lesson.test.ts
git commit -m "test(modules): pin the Ch12 lesson — stale read, rebuild, exactly-once"
```

---

### Task 6: DerivedPanel — one view's lag gauge, contents, controls (presentational)

**Files:**
- Create: `src/ui/labs/unbundled/DerivedPanel.tsx`
- Test: `src/ui/labs/unbundled/DerivedPanel.test.tsx`

**Interfaces:**
- Produces:
  - `interface DerivedPanelProps { view: ViewId; label: string; head: number; offset: number; paused: boolean; dedup: boolean; body: ReactNode; onPause: () => void; onWipe: () => void; onRedeliver: () => void; onToggleDedup: () => void }`
  - `export function DerivedPanel(props: DerivedPanelProps): JSX.Element`
- Consumes (Task 1): `ViewId`.
- Pure presentational: no store, no driver — all data via props, all actions via callbacks (the Ch10 `StagePanel` contract). `data-*` attributes for test/DoD selectors: `data-view`, `data-offset`, `data-head`, `data-lag`, `data-paused`.

- [ ] **Step 1: Write the failing test**

Create `src/ui/labs/unbundled/DerivedPanel.test.tsx`:

```tsx
import { render } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { DerivedPanel } from './DerivedPanel';

function setup(over: Partial<React.ComponentProps<typeof DerivedPanel>> = {}) {
  const props = {
    view: 'cache' as const,
    label: 'Cache',
    head: 5,
    offset: 3,
    paused: false,
    dedup: false,
    body: <div>contents</div>,
    onPause: vi.fn(),
    onWipe: vi.fn(),
    onRedeliver: vi.fn(),
    onToggleDedup: vi.fn(),
    ...over,
  };
  return { props, ...render(<DerivedPanel {...props} />) };
}

describe('DerivedPanel', () => {
  test('shows the view id, offset/head, and computed lag', () => {
    const { container } = setup({ head: 5, offset: 3 });
    const root = container.querySelector('[data-view="cache"]')!;
    expect(root).not.toBeNull();
    expect(root.getAttribute('data-offset')).toBe('3');
    expect(root.getAttribute('data-head')).toBe('5');
    expect(root.getAttribute('data-lag')).toBe('2');
  });
  test('marks a paused view', () => {
    const { container } = setup({ paused: true });
    expect(container.querySelector('[data-view="cache"]')!.getAttribute('data-paused')).toBe('true');
  });
  test('renders the body contents', () => {
    const { getByText } = setup();
    expect(getByText('contents')).not.toBeNull();
  });
  test('control buttons invoke their callbacks', () => {
    const { props, getByText } = setup();
    getByText('pause').click();
    getByText('wipe').click();
    getByText('redeliver').click();
    getByText(/dedup/i).click();
    expect(props.onPause).toHaveBeenCalled();
    expect(props.onWipe).toHaveBeenCalled();
    expect(props.onRedeliver).toHaveBeenCalled();
    expect(props.onToggleDedup).toHaveBeenCalled();
  });
  test('pause button reads "resume" when already paused', () => {
    const { getByText } = setup({ paused: true });
    expect(getByText('resume')).not.toBeNull();
  });
});
```

- [ ] **Step 2: RED** — Run: `npx vitest run src/ui/labs/unbundled/DerivedPanel.test.tsx`. Expected: FAIL — cannot resolve `./DerivedPanel`.

- [ ] **Step 3: Implement**

Create `src/ui/labs/unbundled/DerivedPanel.tsx`:

```tsx
import type { ReactNode } from 'react';
import type { ViewId } from '../../../modules/unbundled-shared';
import { btn } from '../../kit/classes';

export interface DerivedPanelProps {
  view: ViewId;
  label: string;
  head: number;
  offset: number;
  paused: boolean;
  dedup: boolean;
  body: ReactNode;
  onPause: () => void;
  onWipe: () => void;
  onRedeliver: () => void;
  onToggleDedup: () => void;
}

export function DerivedPanel({
  view,
  label,
  head,
  offset,
  paused,
  dedup,
  body,
  onPause,
  onWipe,
  onRedeliver,
  onToggleDedup,
}: DerivedPanelProps) {
  const lag = Math.max(0, head - offset);
  const pct = head > 0 ? Math.round((offset / head) * 100) : 100;
  return (
    <section
      data-view={view}
      data-offset={offset}
      data-head={head}
      data-lag={lag}
      data-paused={paused}
      className="border border-line bg-panel rounded p-3 space-y-2 font-mono text-xs"
    >
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-sm text-fg">{label}</h3>
        <span className={lag > 0 ? 'text-dim' : 'text-set'}>
          offset {offset}/{head} · lag {lag}
        </span>
      </div>
      <div className="h-1.5 w-full rounded bg-ink">
        <div className="h-full rounded bg-set" style={{ width: `${pct}%` }} />
      </div>
      <div className="min-h-[3rem] text-fg">{body}</div>
      <div className="flex flex-wrap gap-2">
        <button className={btn} onClick={onPause}>
          {paused ? 'resume' : 'pause'}
        </button>
        <button className={btn} onClick={onWipe}>
          wipe
        </button>
        <button className={btn} onClick={onRedeliver}>
          redeliver
        </button>
        <button className={btn} onClick={onToggleDedup}>
          dedup: {dedup ? 'on' : 'off'}
        </button>
      </div>
    </section>
  );
}
```

Note: confirm `btn` is exported from `src/ui/kit/classes.ts` (BatchLab imports `btn, btnPrimary` from it). If the test runner needs `@testing-library/react`, it is already used by existing `*.test.tsx` (e.g. `StagePanel.test.tsx`).

- [ ] **Step 4: GREEN + tsc + eslint.** Run: `npx vitest run src/ui/labs/unbundled/DerivedPanel.test.tsx` (PASS), `npx tsc -b` (0), `npx eslint src/ui/labs/unbundled/DerivedPanel.tsx src/ui/labs/unbundled/DerivedPanel.test.tsx` (0).

- [ ] **Step 5: Commit**

```bash
git add src/ui/labs/unbundled/DerivedPanel.tsx src/ui/labs/unbundled/DerivedPanel.test.tsx
git commit -m "feat(ui): DerivedPanel — per-view lag gauge, contents, pause/wipe/redeliver/dedup controls"
```

---

### Task 7: UnbundledLab — assembly, source lane, query bar, three challenges

**Files:**
- Create: `src/ui/labs/unbundled/UnbundledLab.tsx`
- Test: `src/ui/labs/unbundled/UnbundledLab.test.tsx`

**Interfaces:**
- Consumes: `unbundled`, `DbInspect`, `DbState`, `UnbundledPayload` (Task 2); `UNBUNDLED_NODES`, `DB`, `VIEWS`, `ViewId`, `CATEGORIES`, `deriveCache`, `deriveAnalytics`, `tokenize` (Task 1); `DerivedPanel` (Task 6); `SimDriver`, `useSimStore`, `ChallengePanel`, `TimelineScrubber`, `MetricsPanel`, `btn`, `btnPrimary`.
- Produces: `export function UnbundledLab(): JSX.Element` (used by App `12.1`).

**Design notes (follow the BatchLab pattern `src/ui/labs/batch/BatchLab.tsx`):**
- `epoch` state → rebuild sim on reset; `useSimStore().reset()`, `new Simulation`, `new SimDriver`, drain `UNBUNDLED_NODES.length` init events, `setDriver`.
- Read `inspect`: `const dbv = view.nodes.find((n) => n.id === DB)?.inspect as unknown as DbInspect | undefined; if (!dbv) return null;`
- **Source lane:** a write form (key select `p1..p9`, title text, category select) → `driver.external(DB, { cmd:'write', key, value })`; the log offset tape from `dbv.log` (each record a cell, head marked).
- **Query bar:** view select + input; compute the answer in the UI from `dbv`:
  - search: `dbv.search.index[term.toLowerCase()] ?? []`
  - cache: `dbv.cache.map[key]`
  - analytics: `dbv.analytics.tally[category]`
  Store the last query result in local state to show "answer vs the log's truth" and to arm the C1 flag.
- **Three DerivedPanels** built from `dbv`, each wired: `onPause → driver.external(DB,{cmd: paused?'resume':'pause', view})`, `onWipe`, `onRedeliver`, `onToggleDedup`. Bodies: search = term→keys list; cache = key→title table; analytics = category tally row.
- **Challenge gates (epoch-scoped flags, per Global Constraints):**
  - **C1 staleread:** `const [c1Miss, setC1Miss] = useState<string | null>(null)`. When the reader runs a **search** query whose term is absent from `search.index` but present in `log` (a token of some logged title), set `c1Miss = term`. `check()`: if `c1Miss && dbv.search.index[c1Miss]?.length` → win `{ term: c1Miss }`.
  - **C2 rebuild:** `const [c2Wiped, setC2Wiped] = useState(false)`; set true in the cache `onWipe`. `check()`: if `c2Wiped && dbv.cache.offset === dbv.head && deepEqual(dbv.cache.map, deriveCache(dbv.log))` → win `{ head: dbv.head }`. Use a tiny local `deepEqual = (a,b) => JSON.stringify(a) === JSON.stringify(b)` (key order is stable: derive and the module both build maps in log order — assert this holds in Task 3; if not, sort keys before compare).
  - **C3 exactlyonce:** `const [c3SawOver, setC3SawOver] = useState(false)` and `const [c3RedeliverUnderDedup, setC3Redup] = useState(false)`. In analytics `onRedeliver`: after the command, read fresh state via `driver.sim.getState(DB)` and compare `analytics.tally` sum to `deriveAnalytics(log)` sum — if greater, `setC3SawOver(true)`; if `analytics.dedup` was on at click, `setC3Redup(true)`. `check()`: if `c3SawOver && c3RedeliverUnderDedup && deepEqual(dbv.analytics.tally, deriveAnalytics(dbv.log))` → win.
- Reset clears all challenge flags in the `epoch` effect (BatchLab precedent).
- `TimelineScrubber` forward-only (guard `if (i >= view.processed) driver.scrubTo(i)`).
- Challenge copy: prompts/hints/renderWin per spec §4. Key prefixes: `ddia:ch12:staleread`, `ddia:ch12:rebuild`, `ddia:ch12:exactlyonce`.

- [ ] **Step 1: Write the failing smoke test**

Create `src/ui/labs/unbundled/UnbundledLab.test.tsx`:

```tsx
import { render } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { UnbundledLab } from './UnbundledLab';

describe('UnbundledLab smoke', () => {
  test('mounts and renders the three derived panels + a run/step control', () => {
    const { container, getAllByText } = render(<UnbundledLab />);
    expect(container.querySelector('[data-view="search"]')).not.toBeNull();
    expect(container.querySelector('[data-view="cache"]')).not.toBeNull();
    expect(container.querySelector('[data-view="analytics"]')).not.toBeNull();
    // seed content is caught up on mount → cache panel shows a seeded key
    expect(container.textContent).toContain('p1');
    // a step control exists
    expect(getAllByText(/step|write/i).length).toBeGreaterThan(0);
  });
  test('three challenge panels render (predict-before-run)', () => {
    const { getAllByText } = render(<UnbundledLab />);
    expect(getAllByText(/start attempt/i).length).toBe(3);
  });
});
```

- [ ] **Step 2: RED** — Run: `npx vitest run src/ui/labs/unbundled/UnbundledLab.test.tsx`. Expected: FAIL — cannot resolve `./UnbundledLab`.

- [ ] **Step 3: Implement** `src/ui/labs/unbundled/UnbundledLab.tsx` per the Design notes above, mirroring `src/ui/labs/batch/BatchLab.tsx` structure (epoch effect, driver, store view, TimelineScrubber, three panels, MetricsPanel, three ChallengePanels). Build the write form + query bar + log tape inline. Keep the file focused; extract no new shared components (DerivedPanel is the only child).

Reference skeleton (fill in the panel bodies, query bar, and challenge copy):

```tsx
import { useEffect, useState } from 'react';
import { Simulation } from '../../../engine';
import { unbundled, type DbInspect, type DbState, type UnbundledPayload } from '../../../modules/unbundled';
import {
  CATEGORIES,
  DB,
  UNBUNDLED_NODES,
  VIEWS,
  deriveAnalytics,
  deriveCache,
  type Category,
  type ViewId,
} from '../../../modules/unbundled-shared';
import { SimDriver } from '../../bridge/SimDriver';
import { useSimStore } from '../../bridge/simStore';
import { ChallengePanel } from '../../kit/ChallengePanel';
import { MetricsPanel } from '../../kit/MetricsPanel';
import { TimelineScrubber } from '../../kit/TimelineScrubber';
import { btn, btnPrimary } from '../../kit/classes';
import { DerivedPanel } from './DerivedPanel';

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const VIEW_LABEL: Record<ViewId, string> = { search: 'Search Index', cache: 'Cache', analytics: 'Analytics' };

export function UnbundledLab() {
  const [epoch, setEpoch] = useState(0);
  const [driver, setDriver] = useState<SimDriver<DbState, UnbundledPayload> | null>(null);
  // write form
  const [wKey, setWKey] = useState('p9');
  const [wTitle, setWTitle] = useState('kafka streams');
  const [wCat, setWCat] = useState<Category>('tool');
  // challenge flags (epoch-scoped)
  const [c1Miss, setC1Miss] = useState<string | null>(null);
  const [c2Wiped, setC2Wiped] = useState(false);
  const [c3SawOver, setC3SawOver] = useState(false);
  const [c3Redup, setC3Redup] = useState(false);

  useEffect(() => {
    useSimStore.getState().reset();
    const seed = 12000 + epoch;
    const sim = new Simulation<DbState, UnbundledPayload>({ module: unbundled, config: { nodeIds: UNBUNDLED_NODES }, seed });
    const d = new SimDriver({ sim, seed, publish: (v) => useSimStore.getState().publish(v) });
    for (let i = 0; i < UNBUNDLED_NODES.length; i++) d.stepOnce();
    setDriver(d);
    setC1Miss(null);
    setC2Wiped(false);
    setC3SawOver(false);
    setC3Redup(false);
    return () => d.pause();
  }, [epoch]);

  const view = useSimStore();
  if (!driver) return null;
  const dbv = view.nodes.find((n) => n.id === DB)?.inspect as unknown as DbInspect | undefined;
  if (!dbv) return null;

  const sum = (t: Record<string, number>) => Object.values(t).reduce((a, b) => a + b, 0);
  const onView = (v: ViewId) => ({
    onPause: () => driver.external(DB, { cmd: getPaused(dbv, v) ? 'resume' : 'pause', view: v }),
    onWipe: () => {
      driver.external(DB, { cmd: 'wipe', view: v });
      if (v === 'cache') setC2Wiped(true);
    },
    onRedeliver: () => {
      const dedupOn = getDedup(dbv, v);
      driver.external(DB, { cmd: 'redeliver', view: v });
      if (v === 'analytics') {
        const s = driver.sim.getState(DB);
        if (sum(s.analytics.tally) > sum(deriveAnalytics(s.log))) setC3SawOver(true);
        if (dedupOn) setC3Redup(true);
      }
    },
    onToggleDedup: () => driver.external(DB, { cmd: 'toggle-dedup', view: v }),
  });

  // ...render: reset/step/play controls, write form, log tape, query bar,
  //    three <DerivedPanel> with bodies, <MetricsPanel>, three <ChallengePanel>.
  //    (see BatchLab.tsx for the control-row + TimelineScrubber + ChallengePanel shape.)
}

function getPaused(dbv: DbInspect, v: ViewId): boolean {
  return v === 'search' ? dbv.search.paused : v === 'cache' ? dbv.cache.paused : dbv.analytics.paused;
}
function getDedup(dbv: DbInspect, v: ViewId): boolean {
  return v === 'search' ? dbv.search.dedup : v === 'cache' ? dbv.cache.dedup : dbv.analytics.dedup;
}
```

Fill the `check()` bodies exactly:

```tsx
// C1
check={() => (c1Miss && (dbv.search.index[c1Miss]?.length ?? 0) > 0 ? { term: c1Miss } : null)}
// C2
check={() => (c2Wiped && dbv.cache.offset === dbv.head && eq(dbv.cache.map, deriveCache(dbv.log)) ? { head: dbv.head } : null)}
// C3
check={() => (c3SawOver && c3Redup && eq(dbv.analytics.tally, deriveAnalytics(dbv.log)) ? { ok: true } : null)}
```

The search query handler (query bar) that arms C1:

```tsx
const runSearchQuery = (raw: string) => {
  const term = raw.trim().toLowerCase();
  const hits = dbv.search.index[term] ?? [];
  const inLog = dbv.log.some((r) => tokenize(r.value.title).includes(term));
  setQueryResult({ view: 'search', term, hits });
  if (hits.length === 0 && inLog) setC1Miss(term); // miss while the log already has it → RYW armed
};
```

(import `tokenize` from `unbundled-shared`.)

- [ ] **Step 4: GREEN + eslint + tsc + full suite.** Run: `npx vitest run src/ui/labs/unbundled/UnbundledLab.test.tsx` (PASS), `npx eslint src/ui/labs/unbundled/UnbundledLab.tsx` (0), `npx tsc -b` (0), then `npx vitest run` (full suite green).

- [ ] **Step 5: Commit**

```bash
git add src/ui/labs/unbundled/UnbundledLab.tsx src/ui/labs/unbundled/UnbundledLab.test.tsx
git commit -m "feat(ui): UnbundledLab — source lane, query bar, three lagging views, three challenges"
```

---

### Task 8: Debrief, catalog, App, README, DESIGN_PLAN wiring

**Files:**
- Create: `content/ch12/debrief.mdx`, `src/ui/labs/unbundled/Debrief.tsx`
- Modify: `src/ui/shell/catalog.ts`, `src/ui/shell/catalog.test.ts`, `src/ui/App.tsx`, `README.md`, `docs/DESIGN_PLAN.md`, `docs/DESIGN_PLAN.en.md`

- [ ] **Step 1: Debrief.** Create `src/ui/labs/unbundled/Debrief.tsx` (mirror `src/ui/labs/batch/Debrief.tsx`):

```tsx
// src/ui/labs/unbundled/Debrief.tsx
import DebriefContent from '../../../../content/ch12/debrief.mdx';
import { DebriefArticle } from '../../kit/DebriefArticle';
import { SurpriseJournal } from '../../kit/SurpriseJournal';

export function UnbundledDebrief() {
  return (
    <DebriefArticle>
      <DebriefContent />
      <SurpriseJournal storageKey="ddia:ch12:journal" />
    </DebriefArticle>
  );
}
```

Create `content/ch12/debrief.mdx` covering, in order (spec §5): the headline (log = source of truth, views = disposable lagging projections); the lag you watched (RYW anomaly, why derived data is *always* eventually consistent); rebuild = the log replaces backups (Kafka log compaction, Kafka-Streams/Samza local-state rebuild); exactly-once = idempotence keyed on offset (**the end-to-end argument** — dedup belongs at the endpoint, not the middleware); the named cuts (spec §1 Out: multi-partition ordering, XA/distributed transactions, real index internals, backpressure, log-compaction mechanics, schema evolution, secondary indexes); real systems (Debezium/Kafka Connect CDC, Kafka Streams, Materialize, Samza). Close with the terms list: changelog, derived data, materialized view, log compaction, idempotence, offset, read-your-writes, end-to-end argument. Match the prose length/voice of `content/ch10/debrief.mdx`.

- [ ] **Step 2: Catalog.** In `src/ui/shell/catalog.ts`, flip ch12 to active:

```ts
  {
    id: 'ch12',
    title: 'Ch.12 — Future of Data Systems',
    labs: [
      { id: '12.1', label: 'Unbundled Database', status: 'active' },
      { id: '12.d', label: 'Debrief & Journal', status: 'active' },
    ],
  },
```

Append to `src/ui/shell/catalog.test.ts` (mirror the ch10/ch11 shape):

```ts
  test('ch12 ships the unbundled-database lab + debrief, all active', () => {
    const ch12 = CATALOG.find((c) => c.id === 'ch12')!;
    expect(ch12.labs.map((l) => l.id)).toEqual(['12.1', '12.d']);
    expect(ch12.labs.every((l) => l.status === 'active')).toBe(true);
  });
```

- [ ] **Step 3: App.** In `src/ui/App.tsx`: import `{ UnbundledLab }` and `{ UnbundledDebrief }`; add PAGES entries after `'11.d'`:

```tsx
  '12.1': {
    eyebrow: 'Chapter 12 — The Future of Data Systems',
    title: 'Unbundled Database',
    thesis:
      'One write lands in an append-only log, then fans out to a search index, a cache, and an analytics counter — each consuming the log at its own pace. Pause a view and write, and its query lies by omission; wipe a view and the log rebuilds it byte-for-byte; redeliver a record and watch the counter double unless you dedup on the offset. Derived data is a disposable projection of the log.',
    Component: UnbundledLab,
  },
  '12.d': {
    eyebrow: 'Chapter 12 — Debrief',
    title: 'The log is the source of truth',
    thesis:
      'Why every derived view lags, why you can throw any of them away, and where exactly-once actually lives — at the endpoint, keyed on the offset.',
    Component: UnbundledDebrief,
  },
```

- [ ] **Step 4: README.** Add a Ch12 block after the Ch11 block (one bullet for 12.1 naming the three challenges — stale read / rebuild / exactly-once; one for 12.d) and bump the counter line to **"Ten chapters live — eighteen interactive labs."** (Verify the exact current counter string first with `grep -n "chapters live" README.md` and edit that line.)

- [ ] **Step 5: DESIGN_PLAN.** Append a progress note to the Phase 5 paragraph in both `docs/DESIGN_PLAN.md` and `docs/DESIGN_PLAN.en.md`: *(ch12 shipped 2026-07-18 — 12.1 Unbundled Database: one write → append-only log → three lagging derived views [search index / cache / analytics]; single-node authoritative model; the three challenges are stale-read/RYW, rebuild-from-log, and exactly-once-via-offset-dedup — all engine-verified by the property + pinned-lesson suites. Phase 5 complete.)*

- [ ] **Step 6: Gate + commit.** Run: `npx vitest run && npx tsc -b && npm run build` (all green). Then:

```bash
git add content/ch12/debrief.mdx src/ui/labs/unbundled/Debrief.tsx src/ui/shell/catalog.ts src/ui/shell/catalog.test.ts src/ui/App.tsx README.md docs/DESIGN_PLAN.md docs/DESIGN_PLAN.en.md
git commit -m "feat(ui): ship Ch12 unbundled-database lab — catalog 12.1/12.d active, App pages, debrief, roadmap"
```

---

### Task 9: Ship gate + DoD (browser walk)

**Files:** none (verification only).

- [ ] **Step 1: Full gate.** Run: `npx vitest run && npx tsc -b && npm run build`. Record the counts (tests / tsc 0 / build 0). All must be green.

- [ ] **Step 2: Browser DoD (vite + playwright).** `npm run dev`, open the app, select **12.1**, and drive:
  - **C1 (stale read):** on the search panel click `pause`; in the write form write a new key with a distinctive title token; run a search query for that token → **miss** (empty) while the log tape shows the record; `start attempt` on the stale-read challenge first if verifying the banner; click `resume`, play → the query hits → **win banner**.
  - **C2 (rebuild):** on the cache panel click `wipe` (contents empty, offset 0); play → the cache repopulates → `offset N/N`, lag 0 → **win banner**.
  - **C3 (exactly-once):** on the analytics panel with `dedup: off` click `redeliver` → a category count over-shoots the log truth; toggle `dedup: on`, `wipe` analytics, play back to exact, `redeliver` again → count holds → **win banner**.
  - Confirm **0 console errors** (check the console; a real error is fix-forward, e.g. a React key collision — mirror the Ch10 shuffle-dot-key fix).
- [ ] **Step 3: DoD sign-off.** Note in the final report: full gate counts, which challenges were driven to a live win, and console-clean confirmation. NOT pushed — await user go-ahead for the origin push + Pages deploy (Ch10 precedent). If the dev-workflow merge gate (review-hash doc + dev-session transcript + quiz-merge artifact) is wanted, raise it before push.

---

## Self-review notes (2026-07-18)

- **Spec coverage:** §1 scope → Tasks 1–8; §2 module (log/views/offsets/lag/topology) → Tasks 1–2; §3 interaction/commands → Task 2 (engine) + Task 7 (UI); §4 challenges → Task 5 (pinned) + Task 7 (lab `check()`); §5 UI/debrief/wiring → Tasks 6–8; §6 testing → Tasks 3–5 (behavioral + property + lesson) + Tasks 6–7 (jsdom); §7 file plan → all tasks; §8 risks: analytics-as-double-count-victim (Task 3 `dedup off` test), delivery-cadence-vs-legibility (pause knob guarantees C1 setup, Task 5), metrics readability (Task 2 `metrics()` returns head + 3 per-view lags only).
- **Type consistency:** `DbInspect`/`DbState`/`UnbundledPayload` defined in Task 2, consumed verbatim in Tasks 3–7; `ViewId`/derivers/`tokenize` from Task 1 used everywhere; `DerivedPanelProps` (Task 6) consumed by Task 7. `getPaused`/`getDedup` helpers read the same inspect shape Task 2 exports. Challenge `check()` predicates in Task 7 mirror the pinned assertions in Task 5 (C1 miss-then-hit, C2 offset==head && eq(map, deriveCache), C3 sawOver && redeliverUnderDedup && eq(tally, deriveAnalytics)).
- **No placeholders:** every module/test/component step carries complete code; Task 7's lab body is a skeleton + exact `check()`/query-handler code + an explicit "mirror BatchLab.tsx" pointer (the one component too large to inline verbatim — its shape is fully specified by props/handlers and the referenced file).
- **Key-order caveat (Task 7 `eq`):** `deriveCache`/`deriveAnalytics` and the module both build objects in log order, so `JSON.stringify` equality holds; if Task 3's `toEqual` passes but a future reorder breaks `eq`, sort keys before compare. Flagged in Task 7.
