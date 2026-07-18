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
  type BatchPayload, type BatchTimer, type DfMsg, type MapTaskId,
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
  /** One job per epoch, latched at injection — see the external-branch comment below. */
  jobQueued: boolean;
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
  /** Records streamed so far, by destination REDUCE TASK — feeds stream-close counts. */
  sentTo: Partial<Record<ReduceTaskId, number>>;
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
  s.incarnation[w] += 1;
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

// batch.ts (continued) — scheduler reduce
function schedReduce(s: SchedState, ev: Ev, fx: Effect[]): void {
  const p = ev.payload;
  if (ev.kind === 'init') {
    fx.push({ type: 'timer', delay: PING_EVERY, payload: { t: 'ping' } });
    return;
  }
  if (ev.kind === 'external') {
    // External run-job enters via the 1-tick timer hop (Ch9 lesson,
    // src/modules/raft.ts:291-298): sim.external() schedules at the frozen
    // sim.time, so side effects performed directly in this branch would land
    // on the SAME tick as whatever produced that external call, not a
    // strictly later one. The hop fixes that by deferring all real work to
    // the 'start-job' timer (batch-shared.ts), which fires one tick later.
    //
    // `jobQueued` is the one-job-per-epoch guard, and it latches HERE, at
    // injection — not at the timer fire — so a second run-job arriving
    // before or after the hop fires is ignored either way; no state besides
    // the guard changes at injection, matching the Ch9 pattern exactly.
    //
    // `started` only flips true when the timer fires, immediately before the
    // MR/df kick-off runs in the same reduce call. That ordering closes the
    // observation gap the earlier synchronous version was dodging: any
    // observer polling `started` (e.g. `until(() => jt.started)`) can only
    // see it go true once df.attempt has already reached its started value,
    // so the second-run-job test's `df.attempt` capture is never one tick
    // stale.
    if ('cmd' in p && p.cmd === 'run-job' && !s.jobQueued) {
      s.jobQueued = true;
      fx.push({ type: 'timer', delay: 1, payload: { t: 'start-job' } });
    }
    return;
  }
  if (ev.kind === 'timer' && 't' in (p as object)) {
    const t = p as BatchTimer;
    if (t.t === 'start-job') {
      // jobQueued (latched at injection, never reset) guarantees this hop
      // fires at most once per epoch, so no re-entrancy check is needed here.
      s.started = true;
      s.mr.phase = 'map';
      for (const m of MAP_TASKS) s.mr.tasks[m].status = 'runnable';
      scheduleMr(s, fx);
      s.df.started = true;
      startDfAttempt(s, fx);
      return;
    }
    if (t.t === 'ping') {
      for (const w of WORKERS) {
        if (s.live[w] && ev.time - s.lastPong[w] > DEAD_AFTER) declareDead(s, w, ev.time, fx);
        fx.push({ type: 'send', to: w, payload: { kind: 'ping' } });
      }
      fx.push({ type: 'timer', delay: PING_EVERY, payload: { t: 'ping' } });
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
        } else {
          // a reducer freed its worker — a still-runnable reduce (e.g. r1 held
          // back at the barrier because the one live worker was busy with r0)
          // must now be assigned. Cheap no-op when nothing is runnable.
          scheduleMr(s, fx);
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
        const r: ReduceTaskId = PARTITION_OF[url] === 0 ? 'r0' : 'r1';
        const dest = s.df.reducerAt[r];
        op.sentTo[r] = (op.sentTo[r] ?? 0) + 1;
        fx.push({ type: 'send', to: dest, payload: { side: 'df', kind: 'df-record', url, from: op.task, attempt: s.df.attempt } });
        fx.push({ type: 'send', to: JT, payload: { side: 'df', kind: 'df-progress', attempt: s.df.attempt } });
        if (op.cursor < SPLITS[SPLIT_OF[op.task]].length) {
          op.nonce += 1;
          op.expectedFireAt = now + RECORD_COST;
          fx.push({ type: 'timer', delay: RECORD_COST, payload: { t: 'df-record', task: op.task, attempt: s.df.attempt, nonce: op.nonce } });
        } else {
          op.done = true;
          for (const rt of REDUCE_TASKS) {
            const rw = s.df.reducerAt[rt];
            fx.push({ type: 'send', to: rw, payload: { side: 'df', kind: 'df-stream-close', from: op.task, reduce: rt, attempt: s.df.attempt, sent: op.sentTo[rt] ?? 0 } });
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
    // Attempt is monotonic (rule: mismatched attempts are ignored on receipt).
    // Two workers can die in one JT ping-pass, so a restart's df-start (attempt
    // N+1) and the prior attempt's df-start (attempt N) can both be in flight to
    // the same worker; if the stale N lands last, an unguarded overwrite would
    // strand the worker on a lineage JT already abandoned. Only ever move forward.
    if (d.attempt <= s.df.attempt) return;
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
    const op = s.df.reduces.find((o) => o.task === d.reduce);
    if (op && op.closedAt[d.from] === undefined) {
      op.closedAt[d.from] = d.sent;
      maybeArmDfOutput(s, op, now, fx);
    }
  }
}

// batch.ts (continued) — module wiring
export const batch: SimModule<BatchState, BatchPayload> = {
  id: 'batch-twin',
  chaos: ['kill-node'], // ChaosToolbar renders kill + revive only; the lab passes WORKERS, never JT

  init(nodeId) {
    if (nodeId === JT) {
      return {
        role: 'sched', id: nodeId, started: false, jobQueued: false,
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
