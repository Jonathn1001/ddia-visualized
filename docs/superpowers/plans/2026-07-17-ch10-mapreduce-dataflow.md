# Ch10 MapReduce vs Dataflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship DDIA Ch10 as lab `10.1` — the same web-log URL-count job running simultaneously on a MapReduce sub-engine (barrier, mapper-local disk, shuffle-by-fetch) and a dataflow sub-engine (pipelined, no disk, restart-from-input recovery) — plus debrief `10.d`.

**Architecture:** One `Simulation<BatchState>` over **four** sim nodes: `JT` (the JobTracker/scheduler — immortal because the UI and tests never kill it; ChaosToolbar receives only the workers) and `W1..W3` (workers; each holds BOTH sub-engine branches `{mr, df}`, so one kill hits both sides atomically). Liveness is a JT ping loop: a worker silent longer than `DEAD_AFTER` is declared dead; recovery flows from that declaration. Waste accounting is exact: workers report each completed record to JT, so `ticksWasted` sums real, spent execution ticks. Spec: `docs/superpowers/specs/2026-07-16-ch10-mapreduce-dataflow-design.md`.

**Tech Stack:** TypeScript, React 19, SimDriver/useSimStore bridge, ChaosToolbar/ChallengePanel/MetricsPanel/TimelineScrubber kit, SVG (no Canvas), vitest, fast-check, MDX.

## Global Constraints

- Pure module: reducer `structuredClone(prev)` then mutate; RNG only via the `rng` param; no Date.now/Math.random. Effects only `{type:'send'|'timer'}`.
- The `init` event arrives through `reduce` (kind `'init'`) — that is where JT arms its ping loop. Workers do nothing on init.
- External `run-job` enters via the 1-tick timer hop (Ch9 lesson). One job per epoch — the module ignores a second `run-job`.
- Every timer payload carries a nonce and (where task-scoped) an attempt; stale fires are ignored (Ch9 lesson). Every task-plane message carries `side: 'mr' | 'df'` and an `attempt`; mismatched attempts are ignored on receipt.
- Constants (single source: `batch-shared.ts`): `RECORD_COST = 4`, `DISK_WRITE_TICKS = 8`, `OUTPUT_TICKS = 6`, `PING_EVERY = 20`, `DEAD_AFTER = 50`, `FETCH_RETRY = 30`.
- Execution-tick accounting counts **record-processing ticks only** — disk-write and output-write ticks are never in `ticksWasted` (they're visible instead as `recordsMaterialized` and completion latency). Deliberate simplification; note it in the debrief? No — module-internal, document in batch.ts header comment.
- UI tests: `// @vitest-environment jsdom`, `afterEach(cleanup)`, container/data-attr queries, NO jest-dom; theme tokens ink/panel/line/dim/fg/set/sign/warn; `btn`/`btnPrimary`/`inputBox` from kit/classes.
- Content dir `content/ch10/`; storage keys `ddia:ch10:*` (challenges `ddia:ch10:rerun|lostdisk|damage`, journal `ddia:ch10:journal`).
- Forward-only scrub (Ch8 lesson): `onScrub={(i) => { if (i >= view.processed) driver.scrubTo(i); }}`.
- Lab seed: `10000 + epoch`. Mount drains exactly `BATCH_NODES.length` init events (JT's ping loop never settles — no unbounded drain; Ch9 lesson).
- Property/behavioral tests that drive the sim: `30_000` ms vitest timeouts (Ch9 lesson, commit 470e753).
- Tests `npx vitest run <file>`; `npx tsc -b`; `npx eslint <files>`; commit specific files; conventional commits; work directly on `master` (repo practice).

---

### Task 1: Shared vocabulary — topology, fixture, types, constants

**Files:**
- Create: `src/modules/batch-shared.ts`
- Test: `src/modules/batch-shared.test.ts`

**Interfaces (later tasks import exactly these):** `JT`, `WORKERS`, `BATCH_NODES`, `URLS`, `Url`, `ACCESS_LOG`, `SPLITS`, `PARTITION_OF`, `EXPECTED_COUNTS`, `MAP_TASKS`, `REDUCE_TASKS`, `SPLIT_OF`, `REDUCE_INPUT`, `REDUCE_EXEC_RECORDS`, cost/liveness constants above, `MAP_RECORDS`, `MAP_EXEC_TICKS`, `PartFile`, `mapPartitions`, types `Side`, `MapTaskId`, `ReduceTaskId`, `TaskId`, `BatchMsg`, `BatchTimer`, `BatchExternal`, `BatchPayload`.

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/batch-shared.test.ts
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
  for (const s of SPLITS) expect(s).toHaveLength(8);
  const counts: Record<string, number> = {};
  for (const u of ACCESS_LOG) counts[u] = (counts[u] ?? 0) + 1;
  expect(counts).toEqual(EXPECTED_COUNTS);
  expect(EXPECTED_COUNTS['/home']).toBe(10); // the hot key
});

test('partitioning is total and skewed 16/8', () => {
  for (const u of URLS) expect([0, 1]).toContain(PARTITION_OF[u]);
  let r0 = 0;
  let r1 = 0;
  for (const u of ACCESS_LOG) (PARTITION_OF[u] === 0 ? r0++ : r1++);
  expect(r0).toBe(REDUCE_INPUT.r0);
  expect(r1).toBe(REDUCE_INPUT.r1);
  expect(REDUCE_INPUT).toEqual({ r0: 16, r1: 8 });
});

test('mapPartitions splits a split by reducer and preserves totals', () => {
  const [p0, p1] = mapPartitions(SPLITS[0]);
  const total = [...Object.values(p0), ...Object.values(p1)].reduce((a, b) => a + b, 0);
  expect(total).toBe(8);
  for (const u of Object.keys(p0)) expect(PARTITION_OF[u as keyof typeof PARTITION_OF]).toBe(0);
  for (const u of Object.keys(p1)) expect(PARTITION_OF[u as keyof typeof PARTITION_OF]).toBe(1);
});

test('fixtures are frozen — the twin branches can never share-and-mutate them', () => {
  expect(Object.isFrozen(ACCESS_LOG)).toBe(true);
  expect(Object.isFrozen(SPLITS)).toBe(true);
  expect(Object.isFrozen(SPLITS[0])).toBe(true);
  expect(MAP_TASKS).toEqual(['m0', 'm1', 'm2']);
});
```

- [ ] **Step 2: RED** — module unresolved. Run: `npx vitest run src/modules/batch-shared.test.ts`

- [ ] **Step 3: Implement**

```ts
// src/modules/batch-shared.ts
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
  | { side: 'df'; kind: 'df-stream-close'; from: MapTaskId; attempt: number; sent: number } // sent = records this mapper streamed to THIS reducer worker
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
```

- [ ] **Step 4: GREEN + tsc + eslint.**

Run: `npx vitest run src/modules/batch-shared.test.ts && npx tsc -b && npx eslint src/modules/batch-shared.ts src/modules/batch-shared.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/modules/batch-shared.ts src/modules/batch-shared.test.ts
git commit -m "feat(modules): Ch10 batch vocabulary — topology, skewed log fixture, payload unions"
```

---

### Task 2: The complete batch module

**Files:**
- Create: `src/modules/batch.ts`
- Test: `src/modules/batch.test.ts`

The FULL module lands here (both sub-engines, liveness, recovery, counters); Tasks 3–4 are behavioral gates that append tests and fix only what fails (the Ch8/Ch9 strategy). `metrics`/`inspect` are stubs until Task 5.

**Interfaces:** `BatchState = SchedState | WorkerState` (discriminated on `role`), `batch: SimModule<BatchState, BatchPayload>` with `chaos: ['kill-node']`, exported types `SchedState`, `WorkerState`, `TaskRow`.

**Load-bearing rules (fix toward these, not toward a failing test):**
1. **Death is declared, not observed.** Kill/revive are engine controls the module never sees. JT pings every worker each `PING_EVERY`; a worker whose last pong is older than `DEAD_AFTER` at ping time is declared dead. ALL recovery hangs off that declaration.
2. **Revive = reset.** A revived worker still holds its frozen pre-kill state. When JT hears a pong from a worker it considers dead, it bumps that worker's incarnation and sends `reset`; the worker clears BOTH branches (empty disk — the spec's rule), adopts the incarnation, and pongs back; only that second pong (matching incarnation) marks it live again.
3. **Attempt tags are the staleness guard.** JT bumps a task's attempt when re-scheduling it; a dead worker's in-flight `map-done`/`record-done`/`df-record`/etc. carry the old attempt and are dropped on receipt. Timers additionally carry a nonce (a worker's own stale chains).
4. **Timer chains self-heal on ping.** A worker killed and revived *before* JT's death declaration lost its pending timers (dropped while dead) but keeps its task state — the job would hang. Rule: each running chain records `expectedFireAt`; on every ping receipt, if `now > expectedFireAt` the chain is re-armed with a bumped nonce. Deterministic; no effect on the healthy path.
5. **Dataflow output waits for counted streams.** A `df-stream-close` can overtake the last `df-record`s (random per-message latency). Close carries `sent` (records streamed to that reducer worker); a reducer op is closed only when the close arrived AND its received-count matches. Re-check the trigger on every record AND close receipt.
6. **The two branches never share mutable structures** (spec risk #1): `{mr, df}` are separate top-level keys; fixtures are frozen; the determinism property referees.

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/batch.test.ts
import { expect, test } from 'vitest';
import { Simulation } from '../engine';
import { batch, type BatchState, type SchedState, type WorkerState } from './batch';
import { BATCH_NODES, EXPECTED_COUNTS, JT, WORKERS, type BatchPayload, type Url } from './batch-shared';

export function fresh(seed = 10000) {
  const sim = new Simulation<BatchState, BatchPayload>({
    module: batch,
    config: { nodeIds: BATCH_NODES },
    seed,
  });
  sim.runSteps(BATCH_NODES.length); // inits: JT arms its ping loop
  return sim;
}

export const jt = (sim: ReturnType<typeof fresh>) => sim.getState(JT) as SchedState;
export const wk = (sim: ReturnType<typeof fresh>, id: string) => sim.getState(id) as WorkerState;

/** Run until cond or event budget dry (loud on failure). */
export function until(sim: ReturnType<typeof fresh>, cond: () => boolean, budget = 20000) {
  for (let i = 0; i < budget && !cond(); i++) {
    if (sim.pending === 0) break;
    sim.runSteps(1);
  }
  if (!cond()) throw new Error(`until(): not reached (time=${sim.time}, pending=${sim.pending})`);
}

export function runJob(sim: ReturnType<typeof fresh>) {
  sim.external(JT, { cmd: 'run-job' });
}

const rowsToCounts = (rows: [Url, number][]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [u, n] of rows) out[u] = (out[u] ?? 0) + n;
  return out;
};

test('healthy run: both sides complete with the exact expected output', () => {
  const sim = fresh();
  runJob(sim);
  until(sim, () => jt(sim).mr.completionTick !== null && jt(sim).df.completionTick !== null);
  expect(rowsToCounts(jt(sim).mr.output)).toEqual(EXPECTED_COUNTS);
  expect(rowsToCounts(jt(sim).df.output)).toEqual(EXPECTED_COUNTS);
}, 30_000);

test('healthy run: the dataflow side wins on completion tick', () => {
  const sim = fresh();
  runJob(sim);
  until(sim, () => jt(sim).mr.completionTick !== null && jt(sim).df.completionTick !== null);
  expect(jt(sim).df.completionTick!).toBeLessThan(jt(sim).mr.completionTick!);
  // and the healthy run wasted nothing, re-ran nothing, restarted nothing
  expect(jt(sim).mr.wasted).toBe(0);
  expect(jt(sim).df.wasted).toBe(0);
  expect(jt(sim).mr.reexecuted).toBe(0);
  expect(jt(sim).df.restarts).toBe(0);
}, 30_000);

test('the barrier holds: no reduce task starts until all three maps are done', () => {
  const sim = fresh();
  runJob(sim);
  until(sim, () => jt(sim).mr.tasks.r0.status !== 'waiting' || jt(sim).mr.tasks.r1.status !== 'waiting');
  for (const m of ['m0', 'm1', 'm2'] as const) expect(jt(sim).mr.tasks[m].status).toBe('done');
  expect(jt(sim).mr.phase).toBe('reduce');
}, 30_000);

test('MR materializes to mapper-local disk; dataflow never touches disk', () => {
  const sim = fresh();
  runJob(sim);
  until(sim, () => jt(sim).mr.completionTick !== null && jt(sim).df.completionTick !== null);
  expect(jt(sim).mr.materialized).toBe(24); // 3 maps × 8 records, healthy run
  // dataflow leaves no disk anywhere: only MR wrote disk files
  for (const w of WORKERS) {
    const s = wk(sim, w);
    expect(s.df.maps.every((m) => m.done)).toBe(true);
  }
}, 30_000);

test('a second run-job in the same epoch is ignored', () => {
  const sim = fresh();
  runJob(sim);
  until(sim, () => jt(sim).started);
  const attempt = jt(sim).df.attempt;
  runJob(sim);
  sim.runSteps(50);
  expect(jt(sim).df.attempt).toBe(attempt);
  expect(jt(sim).df.restarts).toBe(0);
}, 30_000);

test('determinism: same seed → identical end states', () => {
  const a = fresh(10007);
  const b = fresh(10007);
  for (const s of [a, b]) {
    runJob(s);
    until(s, () => jt(s).mr.completionTick !== null && jt(s).df.completionTick !== null);
    s.runSteps(500); // let trailing pings settle identically
  }
  for (const n of BATCH_NODES) {
    expect(JSON.stringify(a.getState(n))).toBe(JSON.stringify(b.getState(n)));
  }
}, 30_000);
```

- [ ] **Step 2: RED** — cannot resolve `./batch`.

- [ ] **Step 3: Implement — state shapes and the scheduler half**

```ts
// src/modules/batch.ts
// Ch10 — one module, two sub-engines. JT is the scheduler node (immortal: the
// UI never offers a kill button for it); W1..W3 each run BOTH branches {mr, df}.
// MapReduce: barrier, mapper-local disk, shuffle-by-fetch, task-granular
// recovery. Dataflow: pipelined streaming, no disk, restart-from-input recovery.
// Waste accounting counts record-processing ticks only (disk/output ticks are
// materialization cost, not wasted work).
import type { NodeId } from '../engine/events';
import type { Effect, InspectorTree, MetricSample, SimModule } from '../engine/module';
import {
  DEAD_AFTER, DISK_WRITE_TICKS, FETCH_RETRY, JT, MAP_EXEC_TICKS, MAP_RECORDS,
  MAP_TASKS, OUTPUT_TICKS, PARTITION_OF, PING_EVERY, RECORD_COST,
  REDUCE_EXEC_RECORDS, REDUCE_TASKS, SPLITS, SPLIT_OF, WORKERS, mapPartitions,
  type BatchMsg, type BatchPayload, type BatchTimer, type DfMsg, type MapTaskId,
  type MrMsg, type PartFile, type ReduceTaskId, type TaskId, type Url,
} from './batch-shared';

export interface TaskRow {
  status: 'waiting' | 'runnable' | 'running' | 'done';
  worker: NodeId | null;
  attempt: number;
  /** Execution ticks reported (record-done) for the CURRENT attempt. */
  execTicks: number;
}

export interface SchedState {
  role: 'sched';
  id: NodeId;
  started: boolean;
  lastPong: Record<string, number>;
  live: Record<string, boolean>;
  incarnation: Record<string, number>;
  mr: {
    phase: 'idle' | 'map' | 'reduce' | 'done';
    tasks: Record<TaskId, TaskRow>;
    /** Where each done map task's local-disk output lives. */
    diskAt: Partial<Record<MapTaskId, NodeId>>;
    /** Per reduce task (current attempt): map outputs already pulled into reducer memory. */
    fetched: Record<ReduceTaskId, MapTaskId[]>;
    materialized: number;
    reexecuted: number;
    lostAfterDone: number;
    wasted: number;
    completionTick: number | null;
    output: [Url, number][];
  };
  df: {
    started: boolean;
    attempt: number;
    placement: Partial<Record<TaskId, NodeId>>;
    /** Execution ticks reported (df-progress) for the CURRENT attempt. */
    execTicks: number;
    mapsDone: MapTaskId[];
    reduceDone: ReduceTaskId[];
    restarts: number;
    wasted: number;
    completionTick: number | null;
    output: [Url, number][];
    awaitingRevive: boolean;
  };
}

export interface MrRun {
  task: TaskId;
  attempt: number;
  phase: 'exec' | 'disk' | 'fetch' | 'output';
  recordsDone: number;
  recordsTotal: number;
  /** reduce only */
  sources: Partial<Record<MapTaskId, NodeId>>;
  fetchedFiles: Partial<Record<MapTaskId, PartFile>>;
  nonce: number;
  expectedFireAt: number;
}

export interface DfMapOp {
  task: MapTaskId;
  cursor: number;
  done: boolean;
  /** Records streamed so far, by destination worker — feeds stream-close counts. */
  sentTo: Record<string, number>;
  nonce: number;
  expectedFireAt: number;
}

export interface DfReduceOp {
  task: ReduceTaskId;
  agg: PartFile;
  receivedFrom: Partial<Record<MapTaskId, number>>;
  closedAt: Partial<Record<MapTaskId, number>>; // close's `sent` value, once received
  outputArmed: boolean;
  nonce: number;
  expectedFireAt: number;
}

export interface WorkerState {
  role: 'worker';
  id: NodeId;
  incarnation: number;
  mr: { run: MrRun | null; disk: Partial<Record<MapTaskId, [PartFile, PartFile]>> };
  df: { attempt: number; reducerAt: Record<string, NodeId>; maps: DfMapOp[]; reduces: DfReduceOp[] };
}

export type BatchState = SchedState | WorkerState;

type Ev = { kind: 'init' | 'message' | 'timer' | 'external'; self: NodeId; from?: NodeId; time: number; payload: BatchPayload };

const TASK_ORDER: TaskId[] = ['m0', 'm1', 'm2', 'r0', 'r1'];

const freshTaskRow = (): TaskRow => ({ status: 'waiting', worker: null, attempt: 0, execTicks: 0 });

/** Least-loaded live worker, ties to the lowest number — spec §2 placement. */
function placeDf(live: NodeId[]): Partial<Record<TaskId, NodeId>> {
  const load: Record<string, number> = {};
  for (const w of live) load[w] = 0;
  const placement: Partial<Record<TaskId, NodeId>> = {};
  for (const op of ['r0', 'r1', 'm0', 'm1', 'm2'] as TaskId[]) {
    let best: NodeId | null = null;
    for (const w of live) if (best === null || load[w] < load[best]) best = w;
    if (best === null) return {};
    placement[op] = best;
    load[best] += 1;
  }
  return placement;
}

/** MR: lowest-numbered idle live worker takes the lowest-numbered runnable task. */
function scheduleMr(s: SchedState, fx: Effect[]): void {
  for (;;) {
    const task = TASK_ORDER.find((t) => s.mr.tasks[t].status === 'runnable');
    if (!task) return;
    const busy = new Set(TASK_ORDER.filter((t) => s.mr.tasks[t].status === 'running').map((t) => s.mr.tasks[t].worker));
    const w = WORKERS.find((n) => s.live[n] && !busy.has(n));
    if (!w) return;
    const row = s.mr.tasks[task];
    row.status = 'running';
    row.worker = w;
    row.execTicks = 0;
    if (task === 'r0' || task === 'r1') {
      fx.push({ type: 'send', to: w, payload: { side: 'mr', kind: 'assign-reduce', task, attempt: row.attempt, sources: { ...s.mr.diskAt } } });
    } else {
      fx.push({ type: 'send', to: w, payload: { side: 'mr', kind: 'assign-map', task: task as MapTaskId, attempt: row.attempt } });
    }
  }
}

function startDfAttempt(s: SchedState, fx: Effect[]): void {
  const live = WORKERS.filter((w) => s.live[w]);
  if (live.length === 0) {
    s.df.awaitingRevive = true;
    return;
  }
  s.df.awaitingRevive = false;
  s.df.attempt += 1;
  s.df.execTicks = 0;
  s.df.mapsDone = [];
  s.df.reduceDone = [];
  s.df.output = [];
  s.df.placement = placeDf(live);
  const reducerAt = {
    r0: s.df.placement.r0!,
    r1: s.df.placement.r1!,
  } as Record<ReduceTaskId, NodeId>;
  for (const w of live) {
    const maps = MAP_TASKS.filter((m) => s.df.placement[m] === w);
    const reduces = REDUCE_TASKS.filter((r) => s.df.placement[r] === w);
    if (maps.length || reduces.length) {
      fx.push({ type: 'send', to: w, payload: { side: 'df', kind: 'df-start', attempt: s.df.attempt, maps, reduces, reducerAt } });
    }
  }
}

/** All consequences of "w is dead", both branches. */
function declareDead(s: SchedState, w: NodeId, now: number, fx: Effect[]): void {
  s.live[w] = false;
  // --- MR: the running task on w loses its partial execution ---
  const runningId = TASK_ORDER.find((t) => s.mr.tasks[t].status === 'running' && s.mr.tasks[t].worker === w);
  if (runningId) {
    const row = s.mr.tasks[runningId];
    s.mr.wasted += row.execTicks;
    s.mr.reexecuted += 1;
    row.status = 'runnable';
    row.worker = null;
    row.attempt += 1;
    row.execTicks = 0;
    if (runningId === 'r0' || runningId === 'r1') s.mr.fetched[runningId] = [];
  }
  // --- MR: done-but-unfetched map outputs died with w's disk ---
  for (const m of MAP_TASKS) {
    if (s.mr.diskAt[m] !== w || s.mr.tasks[m].status !== 'done') continue;
    const stillNeeded = REDUCE_TASKS.some((r) => s.mr.tasks[r].status !== 'done' && !s.mr.fetched[r].includes(m));
    delete s.mr.diskAt[m];
    if (stillNeeded) {
      s.mr.lostAfterDone += 1;
      s.mr.reexecuted += 1;
      s.mr.wasted += MAP_EXEC_TICKS; // the first attempt's full execution, discarded
      const row = s.mr.tasks[m];
      row.status = 'runnable';
      row.worker = null;
      row.attempt += 1;
      row.execTicks = 0;
    }
  }
  scheduleMr(s, fx);
  // --- dataflow: a kill poisons in-flight lineage unless w held nothing live ---
  if (s.df.started && s.df.completionTick === null && !s.df.awaitingRevive) {
    const heldReducer = REDUCE_TASKS.some((r) => s.df.placement[r] === w && !s.df.reduceDone.includes(r));
    const heldRunningMap = MAP_TASKS.some((m) => s.df.placement[m] === w && !s.df.mapsDone.includes(m));
    if (heldReducer || heldRunningMap) {
      s.df.restarts += 1;
      s.df.wasted += s.df.execTicks; // per-worker running totals, snapshotted at restart
      startDfAttempt(s, fx);
    }
  }
}
```

*(Step 3 continues below — worker half + module wiring; same file.)*

```ts
// batch.ts (continued) — scheduler reduce
function schedReduce(s: SchedState, ev: Ev, fx: Effect[]): void {
  const p = ev.payload;
  if (ev.kind === 'init') {
    fx.push({ type: 'timer', delay: PING_EVERY, payload: { t: 'ping' } });
    return;
  }
  if (ev.kind === 'external') {
    if ('cmd' in p && p.cmd === 'run-job' && !s.started) {
      s.started = true; // one job per epoch — module-level guard, mirrors the UI
      fx.push({ type: 'timer', delay: 1, payload: { t: 'start-job' } });
    }
    return;
  }
  if (ev.kind === 'timer' && 't' in (p as object)) {
    const t = p as BatchTimer;
    if (t.t === 'ping') {
      for (const w of WORKERS) {
        if (s.live[w] && ev.time - s.lastPong[w] > DEAD_AFTER) declareDead(s, w, ev.time, fx);
        fx.push({ type: 'send', to: w, payload: { kind: 'ping' } });
      }
      fx.push({ type: 'timer', delay: PING_EVERY, payload: { t: 'ping' } });
    } else if (t.t === 'start-job') {
      s.mr.phase = 'map';
      for (const m of MAP_TASKS) s.mr.tasks[m].status = 'runnable';
      scheduleMr(s, fx);
      s.df.started = true;
      startDfAttempt(s, fx);
    }
    return;
  }
  if (ev.kind !== 'message' || !ev.from) return;
  const w = ev.from;
  if ('kind' in p && p.kind === 'pong') {
    s.lastPong[w] = ev.time;
    if (!s.live[w]) {
      if (p.incarnation === s.incarnation[w]) {
        // the worker has applied our reset — it is clean and back
        s.live[w] = true;
        scheduleMr(s, fx);
        if (s.df.awaitingRevive) startDfAttempt(s, fx);
      } else {
        s.incarnation[w] += 1;
        fx.push({ type: 'send', to: w, payload: { kind: 'reset', incarnation: s.incarnation[w] } });
      }
    }
    return;
  }
  if (!('side' in (p as object))) return;
  if ((p as MrMsg | DfMsg).side === 'mr') {
    const m = p as MrMsg;
    switch (m.kind) {
      case 'record-done': {
        const row = s.mr.tasks[m.task];
        if (m.attempt === row.attempt && row.status === 'running') row.execTicks += RECORD_COST;
        break;
      }
      case 'map-done': {
        const row = s.mr.tasks[m.task];
        if (m.attempt !== row.attempt || row.status !== 'running') break;
        row.status = 'done';
        s.mr.diskAt[m.task] = w;
        s.mr.materialized += MAP_RECORDS;
        if (s.mr.phase === 'map' && MAP_TASKS.every((t) => s.mr.tasks[t].status === 'done')) {
          s.mr.phase = 'reduce';
          for (const r of REDUCE_TASKS) if (s.mr.tasks[r].status === 'waiting') s.mr.tasks[r].status = 'runnable';
        } else if (s.mr.phase === 'reduce') {
          // a relocated re-run finished — point running reducers at the new disk
          for (const r of REDUCE_TASKS) {
            const rr = s.mr.tasks[r];
            if (rr.status === 'running' && rr.worker) {
              fx.push({ type: 'send', to: rr.worker, payload: { side: 'mr', kind: 'map-relocated', task: m.task, worker: w } });
            }
          }
        }
        scheduleMr(s, fx);
        break;
      }
      case 'fetched': {
        const rr = s.mr.tasks[m.reduce];
        if (m.attempt === rr.attempt && !s.mr.fetched[m.reduce].includes(m.task)) s.mr.fetched[m.reduce].push(m.task);
        break;
      }
      case 'reduce-done': {
        const rr = s.mr.tasks[m.task];
        if (m.attempt !== rr.attempt || rr.status !== 'running') break;
        rr.status = 'done';
        s.mr.output.push(...m.rows);
        if (REDUCE_TASKS.every((r) => s.mr.tasks[r].status === 'done')) {
          s.mr.phase = 'done';
          s.mr.completionTick = ev.time;
          s.mr.output.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])); // stable display order
        }
        break;
      }
      default:
        break; // assign/fetch/fetch-resp/map-relocated never target JT
    }
    return;
  }
  const d = p as DfMsg;
  if (d.attempt !== s.df.attempt) return; // stale attempt — aborted lineage
  switch (d.kind) {
    case 'df-progress':
      if (s.df.completionTick === null) s.df.execTicks += RECORD_COST;
      break;
    case 'df-map-done':
      if (!s.df.mapsDone.includes(d.task)) s.df.mapsDone.push(d.task);
      break;
    case 'df-reduce-done':
      if (!s.df.reduceDone.includes(d.task)) {
        s.df.reduceDone.push(d.task);
        s.df.output.push(...d.rows);
        if (s.df.reduceDone.length === REDUCE_TASKS.length) {
          s.df.completionTick = ev.time;
          s.df.output.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        }
      }
      break;
    default:
      break;
  }
}
```

```ts
// batch.ts (continued) — worker reduce
function armMrChain(s: WorkerState, delay: number, timer: BatchTimer, now: number, fx: Effect[]): void {
  if (s.mr.run) {
    s.mr.run.nonce += 1;
    s.mr.run.expectedFireAt = now + delay;
    fx.push({ type: 'timer', delay, payload: { ...timer, nonce: s.mr.run.nonce } });
  }
}

/** Reduce op output trigger — rule 5: all three streams closed AND fully drained. */
function maybeArmDfOutput(s: WorkerState, op: DfReduceOp, now: number, fx: Effect[]): void {
  if (op.outputArmed) return;
  const drained = MAP_TASKS.every((m) => op.closedAt[m] !== undefined && (op.receivedFrom[m] ?? 0) === op.closedAt[m]);
  if (!drained) return;
  op.outputArmed = true;
  op.nonce += 1;
  op.expectedFireAt = now + OUTPUT_TICKS;
  fx.push({ type: 'timer', delay: OUTPUT_TICKS, payload: { t: 'df-output', task: op.task, attempt: s.df.attempt, nonce: op.nonce } });
}

function workerReduce(s: WorkerState, ev: Ev, fx: Effect[]): void {
  const p = ev.payload;
  const now = ev.time;
  if (ev.kind === 'init' || ev.kind === 'external') return;

  if (ev.kind === 'timer' && 't' in (p as object)) {
    const t = p as BatchTimer;
    switch (t.t) {
      case 'mr-record': {
        const run = s.mr.run;
        if (!run || run.task !== t.task || run.attempt !== t.attempt || run.nonce !== t.nonce || run.phase !== 'exec') break;
        run.recordsDone += 1;
        fx.push({ type: 'send', to: JT, payload: { side: 'mr', kind: 'record-done', task: run.task, attempt: run.attempt } });
        if (run.recordsDone < run.recordsTotal) {
          armMrChain(s, RECORD_COST, { t: 'mr-record', task: run.task, attempt: run.attempt, nonce: 0 }, now, fx);
        } else if (run.task === 'r0' || run.task === 'r1') {
          run.phase = 'output';
          armMrChain(s, OUTPUT_TICKS, { t: 'mr-output', task: run.task, attempt: run.attempt, nonce: 0 }, now, fx);
        } else {
          run.phase = 'disk';
          armMrChain(s, DISK_WRITE_TICKS, { t: 'mr-disk', task: run.task as MapTaskId, attempt: run.attempt, nonce: 0 }, now, fx);
        }
        break;
      }
      case 'mr-disk': {
        const run = s.mr.run;
        if (!run || run.task !== t.task || run.attempt !== t.attempt || run.nonce !== t.nonce || run.phase !== 'disk') break;
        s.mr.disk[t.task] = mapPartitions(SPLITS[SPLIT_OF[t.task]]);
        fx.push({ type: 'send', to: JT, payload: { side: 'mr', kind: 'map-done', task: t.task, attempt: run.attempt } });
        s.mr.run = null;
        break;
      }
      case 'mr-fetch-retry': {
        const run = s.mr.run;
        if (!run || run.task !== t.task || run.attempt !== t.attempt || run.nonce !== t.nonce || run.phase !== 'fetch') break;
        for (const m of MAP_TASKS) {
          const src = run.sources[m];
          if (run.fetchedFiles[m] === undefined && src) {
            fx.push({ type: 'send', to: src, payload: { side: 'mr', kind: 'fetch', task: m, reduce: t.task, attempt: run.attempt } });
          }
        }
        run.nonce += 1;
        run.expectedFireAt = now + FETCH_RETRY;
        fx.push({ type: 'timer', delay: FETCH_RETRY, payload: { t: 'mr-fetch-retry', task: t.task, attempt: run.attempt, nonce: run.nonce } });
        break;
      }
      case 'mr-output': {
        const run = s.mr.run;
        if (!run || run.task !== t.task || run.attempt !== t.attempt || run.nonce !== t.nonce || run.phase !== 'output') break;
        const counts: PartFile = {};
        for (const m of MAP_TASKS) {
          for (const [u, n] of Object.entries(run.fetchedFiles[m] ?? {})) {
            counts[u as Url] = (counts[u as Url] ?? 0) + (n as number);
          }
        }
        const rows = Object.entries(counts) as [Url, number][];
        fx.push({ type: 'send', to: JT, payload: { side: 'mr', kind: 'reduce-done', task: t.task, attempt: run.attempt, rows } });
        s.mr.run = null;
        break;
      }
      case 'df-record': {
        if (t.attempt !== s.df.attempt) break;
        const op = s.df.maps.find((o) => o.task === t.task);
        if (!op || op.done || op.nonce !== t.nonce) break;
        const url = SPLITS[SPLIT_OF[op.task]][op.cursor];
        op.cursor += 1;
        const dest = s.df.reducerAt[PARTITION_OF[url] === 0 ? 'r0' : 'r1'];
        op.sentTo[dest] = (op.sentTo[dest] ?? 0) + 1;
        fx.push({ type: 'send', to: dest, payload: { side: 'df', kind: 'df-record', url, from: op.task, attempt: s.df.attempt } });
        fx.push({ type: 'send', to: JT, payload: { side: 'df', kind: 'df-progress', attempt: s.df.attempt } });
        if (op.cursor < SPLITS[SPLIT_OF[op.task]].length) {
          op.nonce += 1;
          op.expectedFireAt = now + RECORD_COST;
          fx.push({ type: 'timer', delay: RECORD_COST, payload: { t: 'df-record', task: op.task, attempt: s.df.attempt, nonce: op.nonce } });
        } else {
          op.done = true;
          for (const r of REDUCE_TASKS) {
            const rw = s.df.reducerAt[r];
            fx.push({ type: 'send', to: rw, payload: { side: 'df', kind: 'df-stream-close', from: op.task, attempt: s.df.attempt, sent: op.sentTo[rw] ?? 0 } });
          }
          fx.push({ type: 'send', to: JT, payload: { side: 'df', kind: 'df-map-done', task: op.task, attempt: s.df.attempt } });
        }
        break;
      }
      case 'df-output': {
        if (t.attempt !== s.df.attempt) break;
        const op = s.df.reduces.find((o) => o.task === t.task);
        if (!op || !op.outputArmed || op.nonce !== t.nonce) break;
        const rows = Object.entries(op.agg) as [Url, number][];
        fx.push({ type: 'send', to: JT, payload: { side: 'df', kind: 'df-reduce-done', task: op.task, attempt: s.df.attempt, rows } });
        break;
      }
      default:
        break; // ping/start-job never fire on workers
    }
    return;
  }

  if (ev.kind !== 'message') return;
  if ('kind' in p && p.kind === 'ping') {
    fx.push({ type: 'send', to: JT, payload: { kind: 'pong', incarnation: s.incarnation } });
    // rule 4 — self-heal chains whose timers were dropped while dead
    const run = s.mr.run;
    if (run && now > run.expectedFireAt) {
      if (run.phase === 'exec') armMrChain(s, RECORD_COST, { t: 'mr-record', task: run.task, attempt: run.attempt, nonce: 0 }, now, fx);
      else if (run.phase === 'disk') armMrChain(s, DISK_WRITE_TICKS, { t: 'mr-disk', task: run.task as MapTaskId, attempt: run.attempt, nonce: 0 }, now, fx);
      else if (run.phase === 'output') armMrChain(s, OUTPUT_TICKS, { t: 'mr-output', task: run.task as ReduceTaskId, attempt: run.attempt, nonce: 0 }, now, fx);
      else armMrChain(s, FETCH_RETRY, { t: 'mr-fetch-retry', task: run.task as ReduceTaskId, attempt: run.attempt, nonce: 0 }, now, fx);
    }
    for (const op of s.df.maps) {
      if (!op.done && now > op.expectedFireAt) {
        op.nonce += 1;
        op.expectedFireAt = now + RECORD_COST;
        fx.push({ type: 'timer', delay: RECORD_COST, payload: { t: 'df-record', task: op.task, attempt: s.df.attempt, nonce: op.nonce } });
      }
    }
    for (const op of s.df.reduces) {
      if (op.outputArmed && now > op.expectedFireAt) {
        op.nonce += 1;
        op.expectedFireAt = now + OUTPUT_TICKS;
        fx.push({ type: 'timer', delay: OUTPUT_TICKS, payload: { t: 'df-output', task: op.task, attempt: s.df.attempt, nonce: op.nonce } });
      }
    }
    return;
  }
  if ('kind' in p && p.kind === 'reset') {
    s.incarnation = p.incarnation;
    s.mr = { run: null, disk: {} }; // empty local disk — the spec's revive rule
    s.df = { attempt: 0, reducerAt: {}, maps: [], reduces: [] };
    fx.push({ type: 'send', to: JT, payload: { kind: 'pong', incarnation: s.incarnation } });
    return;
  }
  if (!('side' in (p as object))) return;
  if ((p as MrMsg | DfMsg).side === 'mr') {
    const m = p as MrMsg;
    switch (m.kind) {
      case 'assign-map': {
        s.mr.run = { task: m.task, attempt: m.attempt, phase: 'exec', recordsDone: 0, recordsTotal: MAP_RECORDS, sources: {}, fetchedFiles: {}, nonce: 0, expectedFireAt: 0 };
        armMrChain(s, RECORD_COST, { t: 'mr-record', task: m.task, attempt: m.attempt, nonce: 0 }, now, fx);
        break;
      }
      case 'assign-reduce': {
        s.mr.run = { task: m.task, attempt: m.attempt, phase: 'fetch', recordsDone: 0, recordsTotal: REDUCE_EXEC_RECORDS[m.task], sources: { ...m.sources }, fetchedFiles: {}, nonce: 0, expectedFireAt: 0 };
        for (const mt of MAP_TASKS) {
          const src = m.sources[mt];
          if (src) fx.push({ type: 'send', to: src, payload: { side: 'mr', kind: 'fetch', task: mt, reduce: m.task, attempt: m.attempt } });
        }
        armMrChain(s, FETCH_RETRY, { t: 'mr-fetch-retry', task: m.task, attempt: m.attempt, nonce: 0 }, now, fx);
        break;
      }
      case 'fetch': {
        const disk = s.mr.disk[m.task];
        if (disk) {
          const part = m.reduce === 'r0' ? disk[0] : disk[1];
          fx.push({ type: 'send', to: ev.from!, payload: { side: 'mr', kind: 'fetch-resp', task: m.task, reduce: m.reduce, attempt: m.attempt, file: part } });
        }
        break; // no disk (reset or never mapped here) → silence; the reducer retries
      }
      case 'fetch-resp': {
        const run = s.mr.run;
        if (!run || run.task !== m.reduce || run.attempt !== m.attempt || run.phase !== 'fetch' || run.fetchedFiles[m.task]) break;
        run.fetchedFiles[m.task] = m.file;
        fx.push({ type: 'send', to: JT, payload: { side: 'mr', kind: 'fetched', task: m.task, reduce: m.reduce, attempt: m.attempt } });
        if (MAP_TASKS.every((mt) => run.fetchedFiles[mt] !== undefined)) {
          run.phase = 'exec';
          armMrChain(s, RECORD_COST, { t: 'mr-record', task: run.task, attempt: run.attempt, nonce: 0 }, now, fx);
        }
        break;
      }
      case 'map-relocated': {
        const run = s.mr.run;
        if (run && (run.task === 'r0' || run.task === 'r1') && run.phase === 'fetch') run.sources[m.task] = m.worker;
        break;
      }
      default:
        break; // record-done/map-done/fetched/reduce-done never target workers
    }
    return;
  }
  const d = p as DfMsg;
  if (d.kind === 'df-start') {
    s.df = {
      attempt: d.attempt,
      reducerAt: d.reducerAt,
      maps: d.maps.map((task) => ({ task, cursor: 0, done: false, sentTo: {}, nonce: 0, expectedFireAt: 0 })),
      reduces: d.reduces.map((task) => ({ task, agg: {}, receivedFrom: {}, closedAt: {}, outputArmed: false, nonce: 0, expectedFireAt: 0 })),
    };
    for (const op of s.df.maps) {
      op.nonce += 1;
      op.expectedFireAt = now + RECORD_COST;
      fx.push({ type: 'timer', delay: RECORD_COST, payload: { t: 'df-record', task: op.task, attempt: d.attempt, nonce: op.nonce } });
    }
    return;
  }
  if (d.attempt !== s.df.attempt) return; // stale lineage from an aborted attempt
  if (d.kind === 'df-record') {
    const op = s.df.reduces.find((o) => o.task === (PARTITION_OF[d.url] === 0 ? 'r0' : 'r1'));
    if (!op) return;
    op.agg[d.url] = (op.agg[d.url] ?? 0) + 1;
    op.receivedFrom[d.from] = (op.receivedFrom[d.from] ?? 0) + 1;
    maybeArmDfOutput(s, op, now, fx);
  } else if (d.kind === 'df-stream-close') {
    for (const op of s.df.reduces) {
      if (op.closedAt[d.from] === undefined) {
        op.closedAt[d.from] = d.sent;
        maybeArmDfOutput(s, op, now, fx);
      }
    }
  }
}
```

**Wait — stream-close `sent` is per reducer WORKER, but a worker may host two reduce ops (degraded placement).** With both reducers on one worker, the mapper's single `sent` count covers records for BOTH ops. Fix inside the implementation (do it this way from the start): the mapper tracks `sentTo` **per reduce task**, not per worker — change `sentTo: Record<string, number>` keys to `ReduceTaskId` and send one `df-stream-close` per reduce task (`to: reducerAt[r]`, `sent: op.sentTo[r] ?? 0`), and give `DfMsg.df-stream-close` a `reduce: ReduceTaskId` field; the receiving worker applies the close only to the op with that task id. Update the type in `batch-shared.ts` accordingly (`{ side:'df'; kind:'df-stream-close'; from: MapTaskId; reduce: ReduceTaskId; attempt: number; sent: number }`).

```ts
// batch.ts (continued) — module wiring
export const batch: SimModule<BatchState, BatchPayload> = {
  id: 'batch-twin',
  chaos: ['kill-node'], // ChaosToolbar renders kill + revive only; the lab passes WORKERS, never JT

  init(nodeId) {
    if (nodeId === JT) {
      return {
        role: 'sched', id: nodeId, started: false,
        lastPong: Object.fromEntries(WORKERS.map((w) => [w, 0])),
        live: Object.fromEntries(WORKERS.map((w) => [w, true])),
        incarnation: Object.fromEntries(WORKERS.map((w) => [w, 0])),
        mr: {
          phase: 'idle',
          tasks: { m0: freshTaskRow(), m1: freshTaskRow(), m2: freshTaskRow(), r0: freshTaskRow(), r1: freshTaskRow() },
          diskAt: {}, fetched: { r0: [], r1: [] },
          materialized: 0, reexecuted: 0, lostAfterDone: 0, wasted: 0,
          completionTick: null, output: [],
        },
        df: {
          started: false, attempt: 0, placement: {}, execTicks: 0,
          mapsDone: [], reduceDone: [], restarts: 0, wasted: 0,
          completionTick: null, output: [], awaitingRevive: false,
        },
      } satisfies SchedState;
    }
    return {
      role: 'worker', id: nodeId, incarnation: 0,
      mr: { run: null, disk: {} },
      df: { attempt: 0, reducerAt: {}, maps: [], reduces: [] },
    } satisfies WorkerState;
  },

  reduce(state, event) {
    const s = structuredClone(state);
    const fx: Effect[] = [];
    if (s.role === 'sched') schedReduce(s, event as Ev, fx);
    else workerReduce(s, event as Ev, fx);
    return [s, fx];
  },

  metrics(): MetricSample[] {
    return []; // Task 5
  },

  inspect(state) {
    return { role: state.role } as unknown as InspectorTree; // Task 5
  },
};
```

Note the deliberate asymmetry (it IS the lesson): `declareDead` re-schedules one MR task from materialized state, but throws away the ENTIRE dataflow attempt. If a gate test fails around recovery, fix toward the spec's recovery rules (§3/§4), not toward the test.

- [ ] **Step 4: GREEN + tsc + eslint.**

Run: `npx vitest run src/modules/batch.test.ts && npx tsc -b && npx eslint src/modules/batch.ts src/modules/batch.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/modules/batch.ts src/modules/batch.test.ts src/modules/batch-shared.ts
git commit -m "feat(modules): Ch10 twin batch engine — MR barrier+disk+shuffle, pipelined dataflow, ping-based recovery"
```

---

### Task 3: Behavioral gate — MapReduce recovery matrix

**Files:** `src/modules/batch.test.ts` (append; module fixes only for real bugs)

- [x] **Step 1: Append**

```ts
// append to src/modules/batch.test.ts
test('kill a mapper mid-task: the task re-runs elsewhere; partial ticks are wasted; output stays exact', () => {
  const sim = fresh(10021);
  runJob(sim);
  until(sim, () => jt(sim).mr.tasks.m0.status === 'running');
  const victim = jt(sim).mr.tasks.m0.worker!;
  until(sim, () => jt(sim).mr.tasks.m0.execTicks > 0); // mid-task, some records done
  sim.control({ type: 'kill', node: victim });
  until(sim, () => jt(sim).live[victim] === false); // ping loop declares death
  expect(jt(sim).mr.reexecuted).toBeGreaterThanOrEqual(1);
  expect(jt(sim).mr.wasted).toBeGreaterThan(0);
  until(sim, () => jt(sim).mr.completionTick !== null);
  const counts: Record<string, number> = {};
  for (const [u, n] of jt(sim).mr.output) counts[u] = (counts[u] ?? 0) + n;
  expect(counts).toEqual(EXPECTED_COUNTS);
}, 30_000);

test('done is not safe until fetched: killing a done mapper before the shuffle re-runs its map', () => {
  const sim = fresh(10022);
  runJob(sim);
  // wait for the FIRST map-done, then kill that worker before reduces can fetch
  until(sim, () => Object.keys(jt(sim).mr.diskAt).length === 1);
  const [m, w] = Object.entries(jt(sim).mr.diskAt)[0] as [string, string];
  sim.control({ type: 'kill', node: w });
  until(sim, () => jt(sim).live[w] === false);
  expect(jt(sim).mr.lostAfterDone).toBeGreaterThanOrEqual(1);
  expect(jt(sim).mr.tasks[m as 'm0'].status).not.toBe('done'); // re-queued
  until(sim, () => jt(sim).mr.completionTick !== null);
  const counts: Record<string, number> = {};
  for (const [u, n] of jt(sim).mr.output) counts[u] = (counts[u] ?? 0) + n;
  expect(counts).toEqual(EXPECTED_COUNTS);
}, 30_000);

test('kill a reducer mid-fetch: the reduce task re-runs and re-fetches from surviving disks', () => {
  const sim = fresh(10023);
  runJob(sim);
  until(sim, () => jt(sim).mr.tasks.r0.status === 'running');
  const victim = jt(sim).mr.tasks.r0.worker!;
  sim.control({ type: 'kill', node: victim });
  until(sim, () => jt(sim).live[victim] === false);
  expect(jt(sim).mr.tasks.r0.attempt).toBeGreaterThanOrEqual(1);
  until(sim, () => jt(sim).mr.completionTick !== null);
  const counts: Record<string, number> = {};
  for (const [u, n] of jt(sim).mr.output) counts[u] = (counts[u] ?? 0) + n;
  expect(counts).toEqual(EXPECTED_COUNTS);
}, 30_000);

test('revive rejoins idle with an EMPTY local disk', () => {
  const sim = fresh(10024);
  runJob(sim);
  until(sim, () => Object.keys(jt(sim).mr.diskAt).length >= 1);
  const w = Object.values(jt(sim).mr.diskAt)[0] as string;
  sim.control({ type: 'kill', node: w });
  until(sim, () => jt(sim).live[w] === false);
  sim.control({ type: 'revive', node: w });
  until(sim, () => jt(sim).live[w] === true);
  expect(Object.keys(wk(sim, w).mr.disk)).toHaveLength(0);
  expect(wk(sim, w).mr.run).toBeNull();
  until(sim, () => jt(sim).mr.completionTick !== null && jt(sim).df.completionTick !== null);
}, 30_000);

test('one worker is enough: kill two workers and both jobs still finish, output exact', () => {
  const sim = fresh(10025);
  runJob(sim);
  until(sim, () => jt(sim).started);
  sim.control({ type: 'kill', node: 'W2' });
  sim.control({ type: 'kill', node: 'W3' });
  until(sim, () => jt(sim).mr.completionTick !== null && jt(sim).df.completionTick !== null, 60000);
  for (const side of ['mr', 'df'] as const) {
    const counts: Record<string, number> = {};
    for (const [u, n] of jt(sim)[side].output) counts[u] = (counts[u] ?? 0) + n;
    expect(counts).toEqual(EXPECTED_COUNTS);
  }
}, 30_000);
```

Add `EXPECTED_COUNTS` to the existing import from `./batch-shared`.

- [x] **Step 2: Run.** Green = Task 2 faithful. Failures = module bugs; fix minimally toward spec §3 and document. Likely suspects: lostAfterDone bookkeeping when the reduce phase hasn't started (`fetched` empty, reduces `waiting` — the `stillNeeded` predicate must treat a waiting reduce as needing every map), fetch retries against a source that was reset, single-worker self-send delivery. — Fixed 3 real bugs (incarnation@declareDead, reduce-done→scheduleMr, df-start stale-attempt guard); self-send was a red herring. See `.superpowers/sdd/task-3-report.md`.

- [x] **Step 3: Commit** — `test(modules): pin the MR recovery matrix — rerun, disk loss, reducer death, revive, one-worker completion` (commit `22dbc0a`)

---

### Task 4: Behavioral gate — dataflow restart matrix

**Files:** `src/modules/batch.test.ts` (append)

- [x] **Step 1: Append**

```ts
// append to src/modules/batch.test.ts
test('killing a streaming worker restarts the dataflow job from the input and books the wasted ticks', () => {
  const sim = fresh(10031);
  runJob(sim);
  until(sim, () => jt(sim).df.execTicks > 0); // records are flowing
  const w = jt(sim).df.placement.r0!; // reducer worker — always poisons
  sim.control({ type: 'kill', node: w });
  until(sim, () => jt(sim).df.restarts >= 1);
  expect(jt(sim).df.wasted).toBeGreaterThan(0);
  until(sim, () => jt(sim).df.completionTick !== null);
  const counts: Record<string, number> = {};
  for (const [u, n] of jt(sim).df.output) counts[u] = (counts[u] ?? 0) + n;
  expect(counts).toEqual(EXPECTED_COUNTS); // no double counting from the aborted lineage
}, 30_000);

test('killing an idle dataflow worker costs nothing', () => {
  const sim = fresh(10032);
  runJob(sim);
  // W3 holds only m0 — wait until m0 is done streaming, then kill W3
  until(sim, () => jt(sim).df.mapsDone.includes('m0'));
  const w3 = jt(sim).df.placement.m0!;
  const restartsBefore = jt(sim).df.restarts;
  sim.control({ type: 'kill', node: w3 });
  until(sim, () => jt(sim).live[w3] === false);
  expect(jt(sim).df.restarts).toBe(restartsBefore); // no poison — W3 held no live df state
  until(sim, () => jt(sim).df.completionTick !== null);
}, 30_000);

test('kill all three workers: both jobs pause; the first revive restarts/resumes them to completion', () => {
  const sim = fresh(10033);
  runJob(sim);
  until(sim, () => jt(sim).df.execTicks > 0);
  for (const w of WORKERS) sim.control({ type: 'kill', node: w });
  until(sim, () => WORKERS.every((w) => jt(sim).live[w] === false));
  expect(jt(sim).df.awaitingRevive).toBe(true);
  expect(jt(sim).df.completionTick).toBeNull();
  sim.control({ type: 'revive', node: 'W1' });
  until(sim, () => jt(sim).mr.completionTick !== null && jt(sim).df.completionTick !== null, 60000);
  for (const side of ['mr', 'df'] as const) {
    const counts: Record<string, number> = {};
    for (const [u, n] of jt(sim)[side].output) counts[u] = (counts[u] ?? 0) + n;
    expect(counts).toEqual(EXPECTED_COUNTS);
  }
}, 30_000);

test('same kill, unequal damage: a restart-triggering kill wastes more dataflow ticks than MR ticks', () => {
  const sim = fresh(10034);
  runJob(sim);
  // let both sides do real work first
  until(sim, () => jt(sim).df.execTicks > 4 * 8 && jt(sim).mr.tasks.m0.execTicks > 0);
  const w = jt(sim).df.placement.r0!;
  sim.control({ type: 'kill', node: w });
  until(sim, () => jt(sim).df.restarts >= 1);
  until(sim, () => jt(sim).mr.completionTick !== null && jt(sim).df.completionTick !== null, 60000);
  expect(jt(sim).df.wasted).toBeGreaterThan(jt(sim).mr.wasted);
}, 30_000);
```

- [x] **Step 2: Run; fix real bugs only** (suspects: stale-attempt records folding into the new attempt — the double-count guard; `awaitingRevive` handoff on the revival pong; restart placement when only one worker lives). — Green on first append; no new fixes needed. Task 3's df-start stale-attempt guard + total-blackout revive path already cover all four gates.

- [x] **Step 3: Commit** — `test(modules): pin the dataflow restart matrix — poison kill, idle kill, total blackout, damage inequality`

---

### Task 5: metrics + inspect — the panel contract

**Files:** `src/modules/batch.ts` (replace stubs; add `BatchSchedInspect`, `BatchWorkerInspect`), `src/modules/batch.test.ts` (append)

**Interfaces (StagePanel/BatchLab consume exactly these — UI reads no module internals):**

```ts
export interface BatchSideCounters {
  materialized: number;   // always 0 on df
  shuffleInFlight: number;
  reexecuted: number;     // df: 0 (restart is the df failure mode)
  restarts: number;       // mr: 0
  wasted: number;
  completionTick: number | null;
}
export interface BatchSchedInspect {
  role: 'sched';
  live: Record<string, boolean>;
  mr: {
    phase: SchedState['mr']['phase'];
    tasks: Record<TaskId, { status: TaskRow['status']; worker: NodeId | null; attempt: number }>;
    counters: BatchSideCounters;
    output: [Url, number][];
  };
  df: {
    attempt: number;
    placement: Partial<Record<TaskId, NodeId>>;
    mapsDone: MapTaskId[];
    reduceDone: ReduceTaskId[];
    awaitingRevive: boolean;
    counters: BatchSideCounters;
    output: [Url, number][];
  };
}
export interface BatchWorkerInspect {
  role: 'worker';
  id: NodeId;
  mr: { task: TaskId | null; phase: MrRun['phase'] | null; recordsDone: number; recordsTotal: number; diskFiles: MapTaskId[] };
  df: { maps: { task: MapTaskId; cursor: number; done: boolean }[]; reduces: { task: ReduceTaskId; folded: number; closed: number }[] };
}
```

`shuffleInFlight` derivations (from sched state alone): **mr** = for each running reduce task, `3 - fetched[r].length`, summed; **df** = while the attempt runs (started, not done, not awaitingRevive), `MAP_TASKS.length - mapsDone.length` (streams still open).

- [x] **Step 1: Append tests**

```ts
// append to src/modules/batch.test.ts — import { batch } is already there via './batch'
test('inspect exposes the twin-panel contract', () => {
  const sim = fresh(10041);
  runJob(sim);
  until(sim, () => jt(sim).mr.completionTick !== null && jt(sim).df.completionTick !== null);
  const si = batch.inspect(jt(sim)) as unknown as { mr: { counters: Record<string, number | null> }; df: { counters: Record<string, number | null> } };
  expect(si.mr.counters.materialized).toBe(24);
  expect(si.df.counters.materialized).toBe(0);
  expect(si.mr.counters.restarts).toBe(0);
  expect(si.df.counters.completionTick).not.toBeNull();
  const wi = batch.inspect(wk(sim, 'W1')) as unknown as { role: string; mr: { diskFiles: string[] }; df: { reduces: unknown[] } };
  expect(wi.role).toBe('worker');
  expect(Array.isArray(wi.mr.diskFiles)).toBe(true);
}, 30_000);

test('metrics: both columns, six counters each, completion ticks appear once done', () => {
  const sim = fresh(10042);
  runJob(sim);
  until(sim, () => jt(sim).mr.completionTick !== null && jt(sim).df.completionTick !== null);
  const states = new Map(BATCH_NODES.map((n) => [n, sim.getState(n)] as const));
  const names = batch.metrics(states, sim.time).map((m) => m.name);
  expect(names).toEqual(expect.arrayContaining([
    'mr/materialized', 'mr/shuffle', 'mr/reexec', 'mr/wasted', 'mr/done',
    'df/restarts', 'df/shuffle', 'df/wasted', 'df/done',
  ]));
}, 30_000);
```

- [x] **Step 2: RED → implement**

```ts
  metrics(states, _time): MetricSample[] {
    const s = [...states.values()].find((x): x is SchedState => x.role === 'sched');
    if (!s) return [];
    const mrShuffle = REDUCE_TASKS.reduce(
      (acc, r) => acc + (s.mr.tasks[r].status === 'running' ? MAP_TASKS.length - s.mr.fetched[r].length : 0), 0);
    const dfRunning = s.df.started && s.df.completionTick === null && !s.df.awaitingRevive;
    const out: MetricSample[] = [
      { name: 'mr/materialized', value: s.mr.materialized },
      { name: 'mr/shuffle', value: mrShuffle },
      { name: 'mr/reexec', value: s.mr.reexecuted },
      { name: 'mr/wasted', value: s.mr.wasted },
      { name: 'df/restarts', value: s.df.restarts },
      { name: 'df/shuffle', value: dfRunning ? MAP_TASKS.length - s.df.mapsDone.length : 0 },
      { name: 'df/wasted', value: s.df.wasted },
    ];
    if (s.mr.completionTick !== null) out.push({ name: 'mr/done', value: s.mr.completionTick });
    if (s.df.completionTick !== null) out.push({ name: 'df/done', value: s.df.completionTick });
    return out;
  },

  inspect(state) {
    if (state.role === 'sched') {
      const counters = (side: 'mr' | 'df'): BatchSideCounters => ({
        materialized: side === 'mr' ? state.mr.materialized : 0,
        shuffleInFlight: 0, // panel uses metrics for the live gauge; inspect carries the rest
        reexecuted: side === 'mr' ? state.mr.reexecuted : 0,
        restarts: side === 'df' ? state.df.restarts : 0,
        wasted: state[side].wasted,
        completionTick: state[side].completionTick,
      });
      const tasks = Object.fromEntries(
        (Object.entries(state.mr.tasks) as [TaskId, TaskRow][]).map(([t, row]) => [t, { status: row.status, worker: row.worker, attempt: row.attempt }]),
      ) as BatchSchedInspect['mr']['tasks'];
      return {
        role: 'sched', live: state.live,
        mr: { phase: state.mr.phase, tasks, counters: counters('mr'), output: state.mr.output },
        df: {
          attempt: state.df.attempt, placement: state.df.placement, mapsDone: state.df.mapsDone,
          reduceDone: state.df.reduceDone, awaitingRevive: state.df.awaitingRevive,
          counters: counters('df'), output: state.df.output,
        },
      } as unknown as InspectorTree;
    }
    const run = state.mr.run;
    return {
      role: 'worker', id: state.id,
      mr: {
        task: run?.task ?? null, phase: run?.phase ?? null,
        recordsDone: run?.recordsDone ?? 0, recordsTotal: run?.recordsTotal ?? 0,
        diskFiles: Object.keys(state.mr.disk),
      },
      df: {
        maps: state.df.maps.map((o) => ({ task: o.task, cursor: o.cursor, done: o.done })),
        reduces: state.df.reduces.map((o) => ({
          task: o.task,
          folded: Object.values(o.agg).reduce((a, b) => a + (b as number), 0),
          closed: Object.keys(o.closedAt).length,
        })),
      },
    } as unknown as InspectorTree;
  },
```

Also add `lostAfterDone` to `BatchSideCounters` (mr-only, 0 on df) — challenge 2's verifier and the StagePanel disk row both read it. Wire it in `counters()` accordingly.

- [x] **Step 3: GREEN + tsc + eslint. Commit** — `feat(modules): batch inspect/metrics — twin-panel contract` (commit `b8f4e60`; `metrics(states)` drops unused time param per module convention)

---

### Task 6: Property suite

**Files:** `src/modules/batch.property.test.ts`

Spec §7 invariants: (a) completion under any script that ends with everyone revived; (b) exact output on completion, both sides, always; (c) single-kill damage inequality, conditional on a df restart; (d) determinism.

- [x] **Step 1: Write**

```ts
// src/modules/batch.property.test.ts
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { Simulation } from '../engine';
import { batch, type BatchState, type SchedState } from './batch';
import { BATCH_NODES, EXPECTED_COUNTS, JT, WORKERS, type BatchPayload } from './batch-shared';

type Cmd = { at: number; kill: string } | { at: number; revive: string };

const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
  fc.record({ at: fc.integer({ min: 5, max: 600 }), kill: fc.constantFrom(...WORKERS) }),
  fc.record({ at: fc.integer({ min: 5, max: 600 }), revive: fc.constantFrom(...WORKERS) }),
);
const script = fc.array(cmdArb, { minLength: 0, maxLength: 6 });

const jt = (sim: Simulation<BatchState, BatchPayload>) => sim.getState(JT) as SchedState;
const done = (sim: Simulation<BatchState, BatchPayload>) =>
  jt(sim).mr.completionTick !== null && jt(sim).df.completionTick !== null;

function run(cmds: Cmd[], seed: number) {
  const sim = new Simulation<BatchState, BatchPayload>({ module: batch, config: { nodeIds: BATCH_NODES }, seed });
  sim.runSteps(BATCH_NODES.length);
  sim.external(JT, { cmd: 'run-job' });
  const dead = new Set<string>();
  const ordered = [...cmds].sort((a, b) => a.at - b.at);
  for (const c of ordered) {
    for (let i = 0; i < 20000 && sim.time < c.at && sim.pending > 0; i++) sim.runSteps(1);
    if ('kill' in c && !dead.has(c.kill)) { sim.control({ type: 'kill', node: c.kill }); dead.add(c.kill); }
    else if ('revive' in c && dead.has(c.revive)) { sim.control({ type: 'revive', node: c.revive }); dead.delete(c.revive); }
  }
  for (const w of [...dead]) sim.control({ type: 'revive', node: w });
  for (let i = 0; i < 200000 && !done(sim) && sim.pending > 0; i++) sim.runSteps(1);
  return sim;
}

const countsOf = (rows: [string, number][]) => {
  const out: Record<string, number> = {};
  for (const [u, n] of rows) out[u] = (out[u] ?? 0) + n;
  return out;
};

test('(a)+(b) any kill/revive script that ends revived → both sides complete with the exact output', () => {
  fc.assert(
    fc.property(script, fc.integer({ min: 1, max: 400 }), (cmds, s) => {
      const sim = run(cmds, 10100 + s);
      expect(done(sim)).toBe(true);
      expect(countsOf(jt(sim).mr.output)).toEqual(EXPECTED_COUNTS);
      expect(countsOf(jt(sim).df.output)).toEqual(EXPECTED_COUNTS);
    }),
    { numRuns: 12 },
  );
}, 30_000);

test('(c) a single kill that triggers a dataflow restart while both jobs run → mr wastes no more than df', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 30, max: 250 }), // kill time — inside the working window
      fc.constantFrom(...WORKERS),
      fc.integer({ min: 1, max: 400 }),
      (at, w, s) => {
        const sim = run([{ at, kill: w }], 10200 + s);
        const st = jt(sim);
        // the claim only holds when the kill actually poisoned the pipeline mid-run
        if (st.df.restarts >= 1 && st.mr.completionTick !== null && st.df.completionTick !== null) {
          expect(st.mr.wasted).toBeLessThanOrEqual(st.df.wasted);
        }
      },
    ),
    { numRuns: 15 },
  );
}, 30_000);

test('(d) determinism: same script + seed → identical states', () => {
  fc.assert(
    fc.property(script, (cmds) => {
      const a = run(cmds, 10300);
      const b = run(cmds, 10300);
      for (const n of BATCH_NODES) {
        expect(JSON.stringify(a.getState(n))).toBe(JSON.stringify(b.getState(n)));
      }
    }),
    { numRuns: 8 },
  );
}, 30_000);
```

- [x] **Step 2: Run** — a counterexample is a REAL recovery bug: shrink, report, fix minimally, document. Note runtime; if the suite exceeds ~60s, halve `numRuns` and say so in the commit body. Property (c)'s guard is spec-faithful: a shrugged-off kill makes no claim (MR can still lose an un-fetched map output to the same kill). — Elevated numRuns (4000+ scripts) surfaced SIX distinct recovery bugs under INVISIBLE kills (kill+revive faster than DEAD_AFTER); all fixed via a JT reconciliation heartbeat + df stall watchdog (DF_STALL). 6 shrunk counterexamples pinned as deterministic regressions. Kept plan numRuns (12/15/8; suite <8s). See `.superpowers/sdd/task-6-report.md`.

- [x] **Step 3: Commit** — `test(modules): batch property suite — completion, exact output, damage inequality, determinism` (commit `6085593`)

---

### Task 7: Pinned lesson test

**Files:** `src/modules/batch-lesson.test.ts` — deterministic challenge-matrix choreography. Inline its own `fresh`/`jt`/`until`/`runJob` helpers (do NOT import from batch.test.ts).

- [x] **Step 1: Write** — two scenarios, each its own sim, both asserted clause by clause (this is the challenge-verifier contract):

**Scenario A — rerun + damage (challenges 1 and 3), seed 10042:**
1. `runJob`; `until jt.mr.tasks.m0.status === 'running' && jt.df.execTicks > 0` (both jobs mid-flight). By construction the victim is W1: MR's lowest-idle rule assigns `m0 → W1`, and df placement pins `r0 → W1` — so killing W1 hits a running MR map AND live dataflow reducer state in one stroke.
2. `sim.control({ type: 'kill', node: 'W1' })`; `until` JT declares it dead (`jt.live.W1 === false`).
3. Assert: `mr.reexecuted ≥ 1` (challenge 1's engine half) and `df.restarts ≥ 1`.
4. Revive W1; `until` both `completionTick !== null`.
5. Assert both outputs equal `EXPECTED_COUNTS`, `df.wasted > mr.wasted` (challenge 3's engine half), `mr.wasted > 0`.

**Scenario B — lostAfterDone (challenge 2), seed 10043:**
1. `runJob`; `until Object.keys(jt.mr.diskAt).length === 1` (first map done, shuffle not started).
2. Kill that disk's worker; `until` declared dead.
3. Assert `mr.lostAfterDone ≥ 1` and that map task re-queued (`status !== 'done'`).
4. Revive; `until` MR completes; assert exact output and `mr.wasted ≥ MAP_EXEC_TICKS` (the full first attempt was discarded).

Use `≥/>` assertions, not magic totals — deterministic seeds keep the path stable, the comparisons keep the test honest. 30_000 timeouts.

- [x] **Step 2: Run; fix real bugs. Commit** — `test(modules): pin the Ch10 lesson — rerun, done-isnt-safe, unequal damage` (commit `56747ed`; green on first write, no bugs)

---

### Task 8: StagePanel — one side's lanes, chips, disk row, dots, output

**Files:** `src/ui/labs/batch/StagePanel.tsx` (+ `.test.tsx`)

**Interface (BatchLab supplies everything; StagePanel is purely presentational):**

```ts
export interface ShuffleDot { id: string; from: string; to: string; frac: number } // frac 0..1 along the arc
export function StagePanel({ side, title, sched, workers, deadNodes, dots }: {
  side: Side;
  title: string;                       // "MapReduce" | "Dataflow"
  sched: BatchSchedInspect;
  workers: BatchWorkerInspect[];       // W1..W3 order
  deadNodes: string[];
  dots: ShuffleDot[];
}): ReactNode;
```

Layout (theme tokens, monospace, `overflow-x-auto` wrapper):
- Root `<section data-side={side}>` with the title and a progress strip: MR → `phase` + counters line (`materialized · re-exec · lost-after-done · wasted · done@tick`); DF → `attempt #n · restarts · wasted · done@tick`, plus `data-waiting="true"` badge when `awaitingRevive`.
- Three stage lanes (`data-lane="map|shuffle|reduce"`): map lane shows task chips `m0..m2` (`data-task`, `data-status` from `sched.mr.tasks` on the mr side; from `mapsDone`/placement on df — placed=running, in `mapsDone`=done), reduce lane shows `r0/r1` the same way (df: `reduceDone`).
- Worker chips row: one chip per worker (`data-worker`, `data-dead` when in `deadNodes`, dimmed `opacity-40`) with its current badge — mr: `task·phase·recordsDone/recordsTotal`; df: its ops with cursors/folded counts.
- **MR only:** local-disk row (`data-disk-row`): per worker, its `diskFiles` as small boxes (`data-disk-file`, text `m0│m1│m2`). The df side renders NO disk row — that absence is the visual argument.
- Shuffle SVG (`data-shuffle-svg`): fixed 3-column geometry (worker x-positions), each dot a `<circle data-dot>` positioned by linear interpolation `from → to` at `frac`.
- Output table (`data-output`): rows `data-output-row` from `sched[side].output`, or a `text-dim` "no output yet" placeholder.

- [ ] **Step 1: Tests** — jsdom, fixtures: a sched inspect mid-reduce (r0 running, m1 lost — `data-status` assertions), workers with disk files, one dead worker, two dots, an output fixture. Assert: `data-side`, chips + statuses, disk row present on mr and ABSENT on df (`container.querySelector('[data-disk-row]')` null), dead dimming, dot count, output rows.
- [ ] **Step 2: Implement** per the interface. **Step 3: GREEN + eslint + tsc. Commit** — `feat(ui): StagePanel — stage lanes, worker chips, MR disk row, shuffle dots, output table`

---

### Task 9: BatchLab — assembly + challenges

**Files:** `src/ui/labs/batch/BatchLab.tsx` (+ `.test.tsx`)

Mechanics (RaftLab is the template — driver-in-effect keyed `[epoch]`, `useSimStore`, forward-only scrub):
- Driver: seed `10000 + epoch`, `config: { nodeIds: BATCH_NODES }`, drain exactly `BATCH_NODES.length` inits at mount (JT's ping loop never settles — no unbounded drain).
- `run job` button (`data-action="run-job"`, `btnPrimary`): `driver.external(JT, { cmd: 'run-job' })`, then `setJobFired(true)` — disabled once fired this epoch (spec: dataflow restarts do NOT re-enable it; only `reset (new seed)` does, via epoch bump).
- Two `StagePanel`s: MR top, dataflow bottom. `sched` = JT's inspect from `view.nodes`; `workers` = W1..W3 inspects; `dots` derived from `view.inFlight`: keep messages whose payload has `side === s && (kind === 'fetch-resp' || kind === 'df-record')`, `frac = (view.time - sentAt) / max(1, deliverAt - sentAt)` clamped to [0,1], `id = \`${from}-${target}-${deliverAt}\``.
- `ChaosToolbar caps={batch.chaos} nodeIds={WORKERS}` (NEVER `BATCH_NODES` — JT is not killable; this is the immortal-master cut). `onAction`: forward to `driver.control(a)`, and on `kill` capture the challenge flags by reading `driver.sim.getState(JT)` BEFORE the control enters the queue:
  - victim runs an MR task now → `setKilledRunningMr(true)`
  - `setUserKilled(true)` always
  - both jobs mid-flight (`mr.phase` is map/reduce with `completionTick === null`, and `df` started with `completionTick === null`) → `setKilledWhileBoth(true)`
- `MetricsPanel history={view.metricsHistory}`; `TimelineScrubber` with the forward-only guard; `reset (new seed)` button bumping epoch (clears flags, re-enables run job).
- Challenges (verifiers read `driver.sim.getState(JT)` only):
  1. `ddia:ch10:rerun` — "Kill a mapper mid-task": win when `killedRunningMr && jt.mr.completionTick !== null && jt.mr.reexecuted >= 1`. Hint: run job → step into the map phase → kill a worker whose chip shows a running task → play out.
  2. `ddia:ch10:lostdisk` — "Done isn't safe until fetched": win when `userKilled && jt.mr.completionTick !== null && jt.mr.lostAfterDone >= 1`. Hint: watch the disk row — kill a worker right AFTER its map chip turns done but BEFORE the shuffle dots leave it.
  3. `ddia:ch10:damage` — "Same kill, unequal damage": win when `killedWhileBoth && jt.mr.completionTick !== null && jt.df.completionTick !== null && jt.df.wasted > jt.mr.wasted`. Hint: one kill while both panels are busy, then let both finish and compare the wasted counters.
- Smoke tests (jsdom): renders two panels (`[data-side="mr"]` and `[data-side="df"]`) + 3 challenges; `run job` disables after click and JT's `started` flips after stepping; kill button via ChaosToolbar reaches the driver (dead chip appears after stepping past the declaration); challenge panels present by title.

- [ ] **Steps: TDD → GREEN + eslint + tsc + full suite (`npx vitest run`). Commit** — `feat(ui): BatchLab — twin panels, run-job epoch discipline, 3 recovery challenges`

---

### Task 10: Debrief, wiring, docs

**Files:** `content/ch10/debrief.mdx`, `src/ui/labs/batch/Debrief.tsx`, `src/ui/shell/catalog.ts` + `catalog.test.ts`, `src/ui/App.tsx`, `README.md`, `docs/DESIGN_PLAN.en.md`.

- [ ] **Step 1: Debrief.** `Debrief.tsx` mirrors `raft/Debrief.tsx` (`BatchDebrief`, journal key `ddia:ch10:journal`). MDX covers, in order: the headline (materialization buys cheap recovery; pipelining buys speed — and couples stages); done-isn't-safe-until-fetched (the disk row you watched die); the skew you saw (r0's 16 vs r1's 8 — hot keys make stragglers; combiners and the map-side pre-aggregation fix, prose only); joins as the deferred half of batch (sort-merge / broadcast hash / partitioned hash, one paragraph each); what the restart really costs and the real fixes — Spark's RDD partition-granular recompute, Flink's checkpoint barriers; the named cuts (speculative execution, killable master, multi-job workflows, HDFS replication mechanics, Hadoop's early shuffle fetch — real reducers fetch per completed map, only `reduce()` waits); real systems (Hadoop/Spark/Flink). Terms list: job, task, split, shuffle, partition, materialization, lineage, straggler, combiner.
- [ ] **Step 2: Catalog.** `ch10.labs` → `[{ id: '10.1', label: 'MapReduce vs Dataflow', status: 'active' }, { id: '10.d', label: 'Debrief & Journal', status: 'active' }]`. Append to `catalog.test.ts`: a `ch10 ships the twin batch lab + debrief, all active` test (mirror the ch11 test's shape).
- [ ] **Step 3: App.** Import `BatchLab`/`BatchDebrief`; PAGES entries after `'9.d'`:
  - `'10.1'`: eyebrow `Chapter 10 — Batch Processing`, title `MapReduce vs Dataflow`, thesis: *"The same URL-count job runs twice: a MapReduce engine that materializes every map output behind a hard stage barrier, and a dataflow engine that streams records straight to reducers. Healthy, the pipeline wins. Kill a worker mid-job and watch one side re-run a single task while the other starts over from the input."*
  - `'10.d'`: eyebrow `Chapter 10 — Debrief`, title `What you just broke`, thesis: *"Materialization buys cheap recovery; pipelining buys speed — and couples stages. What the barrier paid for, what the pipeline lost, and how Spark and Flink split the difference."*
- [ ] **Step 4: README.** Ch10 block after the Ch9 block (one bullet for 10.1 naming the three challenges, one for 10.d); bump the counter line to **"Nine chapters live — sixteen interactive labs."**
- [ ] **Step 5: DESIGN_PLAN.** Append a progress note to the Phase 5 paragraph: *(in progress: ch11 brokers shipped earlier; ch10 shipped 2026-07-17 — 10.1 MapReduce-vs-dataflow twin lab + 10.d debrief; the §4 row-10 win condition [kill a worker mid-job] is challenge 1, and the barrier/pipelining recovery contrast is engine-verified by the property suite.)*
- [ ] **Step 6: Gate + commit.** `npx vitest run && npx tsc -b && npm run build`.

```bash
git add content/ch10/debrief.mdx src/ui/labs/batch/Debrief.tsx src/ui/shell/catalog.ts src/ui/shell/catalog.test.ts src/ui/App.tsx README.md docs/DESIGN_PLAN.en.md
git commit -m "feat(ui): ship Ch10 batch lab — debrief, catalog 10.1/10.d active, roadmap"
```

---

### Task 11: Ship gate + DoD

- [ ] Full gate green (`npx vitest run && npx tsc -b && npm run build`); browser DoD walk (vite preview + playwright): all three challenges winnable per their hints (run job → step/play mix → kill via ChaosToolbar → play out → win banner), both panels animate dots, MR disk row visibly dies with its worker, debrief renders, journal persists, 0 console errors. Fix-forward; never weaken pinned tests.

## Post-plan (main thread)

Push `master` → Pages CI green → live spot-check → ledger/memory update → Ch12 or backfill (ch1/ch2/ch4 mini-widgets) per DESIGN_PLAN Phase 5.

## Self-review notes (2026-07-17)

- Spec coverage: §1 scope → Tasks 1–10; §2 job/topology → Tasks 1–2; §3 MR recovery → Tasks 2–3; §4 df restart → Tasks 2, 4; §5 challenges → Tasks 7, 9; §6 metrics/inspect → Task 5; §7 file plan + invariants → Tasks 6–7; §8 risks → rules 4–6 in Task 2, MetricsPanel fallback noted in Task 5/9 (if the chart is unreadable with 9 series, drop `mr/shuffle`+`df/shuffle` from metrics() and keep them in inspect — spec §8 sanctions this).
- Known deviation from spec wording: topology adds the `JT` scheduler NODE (spec: "abstract, immortal module state"). Per-node reducers have no global state; a never-killable 4th node IS the abstract immortal scheduler, and the lab enforces immortality by passing only `WORKERS` to ChaosToolbar. Record in the PR/commit body as a deviation with this rationale.
- Type consistency check: `df-stream-close` carries `reduce` (per the Task 2 fix note); `BatchSideCounters` includes `lostAfterDone`; StagePanel consumes `BatchSchedInspect`/`BatchWorkerInspect` exactly as Task 5 exports them.




