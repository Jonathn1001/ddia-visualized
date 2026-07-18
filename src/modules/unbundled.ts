import type { NodeId } from '../engine/events';
import type { Effect, InspectorTree, SimModule } from '../engine/module';
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
  wipes: number;
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
  wipes: number;
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
  return { offset: 0, paused: false, dedup: false, wipes: 0, index: {}, keyTerms: {} };
}
function freshCache(): CacheView {
  return { offset: 0, paused: false, dedup: false, wipes: 0, map: {} };
}
function freshAnalytics(): AnalyticsView {
  return { offset: 0, paused: false, dedup: false, wipes: 0, tally: emptyTally() };
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
  // wipes increments (never resets) so a wipe leaves a durable trace even if
  // the rebuild finishes within a single batched publish (see UnbundledLab).
  if (view === 'search') return { ...s, search: { ...freshSearch(), dedup: s.search.dedup, wipes: s.search.wipes + 1 } };
  if (view === 'cache') return { ...s, cache: { ...freshCache(), dedup: s.cache.dedup, wipes: s.cache.wipes + 1 } };
  return { ...s, analytics: { ...freshAnalytics(), dedup: s.analytics.dedup, wipes: s.analytics.wipes + 1 } };
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
      search: {
        offset: state.search.offset,
        paused: state.search.paused,
        dedup: state.search.dedup,
        wipes: state.search.wipes,
        index: state.search.index,
      },
      cache: {
        offset: state.cache.offset,
        paused: state.cache.paused,
        dedup: state.cache.dedup,
        wipes: state.cache.wipes,
        map: state.cache.map,
      },
      analytics: {
        offset: state.analytics.offset,
        paused: state.analytics.paused,
        dedup: state.analytics.dedup,
        wipes: state.analytics.wipes,
        tally: state.analytics.tally,
      },
    } as unknown as InspectorTree;
  },
};
