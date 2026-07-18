// Ch10 — batch vocabulary: JT + three workers, the fixed access log, task ids,
// message/timer unions. Both sub-engines share this file; nothing here mutates.
import type { NodeId } from '../engine/events';

export const JT: NodeId = 'JT';
export const WORKERS: NodeId[] = ['W1', 'W2', 'W3'];
export const BATCH_NODES: NodeId[] = [JT, ...WORKERS];

export const URLS = ['/home', '/about', '/cart', '/faq', '/login'] as const;
export type Url = (typeof URLS)[number];

/** DDIA fig 10-1 workload: 24 hits, deliberately skewed (/home is hot). */
export const ACCESS_LOG: readonly Url[] = Object.freeze([
  '/home', '/about', '/home', '/cart', '/home', '/about', '/faq', '/home',
  '/home', '/cart', '/about', '/home', '/login', '/home', '/about', '/cart',
  '/home', '/faq', '/about', '/home', '/login', '/home', '/about', '/cart',
] as const);

export const SPLITS: readonly (readonly Url[])[] = Object.freeze([
  Object.freeze(ACCESS_LOG.slice(0, 8)),
  Object.freeze(ACCESS_LOG.slice(8, 16)),
  Object.freeze(ACCESS_LOG.slice(16, 24)),
]);

/** partition = hash(url) % 2, realized as a pinned table (the "hash"). */
export const PARTITION_OF: Record<Url, 0 | 1> = {
  '/home': 0, '/cart': 0, '/login': 0, '/about': 1, '/faq': 1,
};

export const EXPECTED_COUNTS: Record<Url, number> = {
  '/home': 10, '/about': 6, '/cart': 4, '/faq': 2, '/login': 2,
};

export type Side = 'mr' | 'df';
export type MapTaskId = 'm0' | 'm1' | 'm2';
export type ReduceTaskId = 'r0' | 'r1';
export type TaskId = MapTaskId | ReduceTaskId;
export const MAP_TASKS: MapTaskId[] = ['m0', 'm1', 'm2'];
export const REDUCE_TASKS: ReduceTaskId[] = ['r0', 'r1'];
export const SPLIT_OF: Record<MapTaskId, number> = { m0: 0, m1: 1, m2: 2 };

/** Records per reduce task — derived from the skew; r0 owns the hot key. */
export const REDUCE_INPUT: Record<ReduceTaskId, number> = { r0: 16, r1: 8 };

export const RECORD_COST = 4; // execution ticks per record, both sides
export const MAP_RECORDS = 8;
export const MAP_EXEC_TICKS = MAP_RECORDS * RECORD_COST;
export const REDUCE_EXEC_RECORDS = REDUCE_INPUT; // reduce chain length = its input records
export const DISK_WRITE_TICKS = 8; // MR only: materialize one map task's output
export const OUTPUT_TICKS = 6; // final output write, both sides
export const PING_EVERY = 20;
export const DEAD_AFTER = 50; // silence threshold before JT declares a worker dead
export const FETCH_RETRY = 30;
// Dataflow stall watchdog: if a running attempt makes no progress for this long,
// JT restarts it. Covers record loss from an INVISIBLE kill+revive (faster than
// DEAD_AFTER) — the reducer's op survives but is permanently short, and pushed
// records can't be re-driven. Comfortably above one df-start re-drive cycle
// (PING_EVERY) so cheaply-recoverable stalls heal before a restart is spent.
export const DF_STALL = 100;

/** One partition file: per-URL counts from one split for one reducer. */
export type PartFile = Partial<Record<Url, number>>;

/** Map a split into its two reducer-partitioned count files. */
export function mapPartitions(split: readonly Url[]): [PartFile, PartFile] {
  const out: [PartFile, PartFile] = [{}, {}];
  for (const u of split) {
    const f = out[PARTITION_OF[u]];
    f[u] = (f[u] ?? 0) + 1;
  }
  return out;
}

// ---- control plane (side-less: liveness is shared infrastructure; one kill
// hits both branches, so one detector serves both) ----
export type CtlMsg =
  | { kind: 'ping' }
  | { kind: 'pong'; incarnation: number }
  | { kind: 'reset'; incarnation: number }; // JT → revived worker: empty disk, drop everything

// ---- MR plane ----
export type MrMsg =
  | { side: 'mr'; kind: 'assign-map'; task: MapTaskId; attempt: number }
  | { side: 'mr'; kind: 'assign-reduce'; task: ReduceTaskId; attempt: number; sources: Partial<Record<MapTaskId, NodeId>> }
  | { side: 'mr'; kind: 'record-done'; task: TaskId; attempt: number } // worker → JT, exact waste accounting
  | { side: 'mr'; kind: 'map-done'; task: MapTaskId; attempt: number } // after the disk write
  | { side: 'mr'; kind: 'fetch'; task: MapTaskId; reduce: ReduceTaskId; attempt: number } // reducer → mapper's worker
  | { side: 'mr'; kind: 'fetch-resp'; task: MapTaskId; reduce: ReduceTaskId; attempt: number; file: PartFile }
  | { side: 'mr'; kind: 'fetched'; task: MapTaskId; reduce: ReduceTaskId; attempt: number } // reducer → JT bookkeeping
  | { side: 'mr'; kind: 'map-relocated'; task: MapTaskId; worker: NodeId } // JT → running reducers
  | { side: 'mr'; kind: 'reduce-done'; task: ReduceTaskId; attempt: number; rows: [Url, number][] };

// ---- dataflow plane ----
export type DfMsg =
  | { side: 'df'; kind: 'df-start'; attempt: number; maps: MapTaskId[]; reduces: ReduceTaskId[]; reducerAt: Record<ReduceTaskId, NodeId> }
  | { side: 'df'; kind: 'df-record'; url: Url; from: MapTaskId; attempt: number }
  | { side: 'df'; kind: 'df-stream-close'; from: MapTaskId; reduce: ReduceTaskId; attempt: number; sent: number } // sent = records this mapper streamed to THIS reducer worker
  | { side: 'df'; kind: 'df-progress'; attempt: number } // worker → JT, one per streamed record
  | { side: 'df'; kind: 'df-map-done'; task: MapTaskId; attempt: number }
  | { side: 'df'; kind: 'df-reduce-done'; task: ReduceTaskId; attempt: number; rows: [Url, number][] };

export type BatchMsg = CtlMsg | MrMsg | DfMsg;

export type BatchTimer =
  | { t: 'ping' }
  | { t: 'start-job' } // the 1-tick hop after the run-job external
  | { t: 'mr-record'; task: TaskId; attempt: number; nonce: number }
  | { t: 'mr-disk'; task: MapTaskId; attempt: number; nonce: number }
  | { t: 'mr-output'; task: ReduceTaskId; attempt: number; nonce: number }
  | { t: 'mr-fetch-retry'; task: ReduceTaskId; attempt: number; nonce: number }
  | { t: 'df-record'; task: MapTaskId; attempt: number; nonce: number }
  | { t: 'df-output'; task: ReduceTaskId; attempt: number; nonce: number };

export type BatchExternal = { cmd: 'run-job' };
export type BatchPayload = BatchMsg | BatchTimer | BatchExternal;
