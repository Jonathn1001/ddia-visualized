// src/modules/txn.ts
// Ch7 Isolation Anomaly Lab — one transaction engine, four isolation semantics.
// The node id IS the isolation level; the reducer interprets schedule steps
// (injected as external events) under that level. Pure, zero effects.
import type { InspectorTree, MetricSample, ModuleConfig, SimModule } from '../engine/module';
import {
  CREDOS,
  type Level,
  type Op,
  type ScheduleStep,
  type TxnId,
  type TxnPayload,
  type WriteValue,
} from './txn-shared';

export interface Version {
  value: number;
  /** Writer; null for the preset's seed versions. */
  txn: TxnId | null;
  /** null while uncommitted; stamped with the commit event's virtual time. */
  committedAt: number | null;
}

export interface ReadRecord {
  key: string;
  value: number;
  /** committedAt of the version read (null = read an uncommitted version). */
  versionCommittedAt: number | null;
  /** Writer of the version read; null for seed versions. */
  from: TxnId | null;
}

export type TxnStatus = 'idle' | 'active' | 'waiting' | 'committed' | 'aborted';

export interface TxnInfo {
  status: TxnStatus;
  beganAt: number | null;
  endedAt: number | null;
  /** SI only: versions committed at or before this time are visible. */
  snapshotAt: number | null;
  reads: ReadRecord[];
  writes: string[];
  abortReason: string | null;
}

export interface Anomaly {
  type: 'dirty-read' | 'lost-update' | 'write-skew';
  detail: string;
  at: number;
}

export interface TxnState {
  level: Level;
  /** Per-key append-only version chains, oldest → newest. */
  store: Record<string, Version[]>;
  txns: Record<TxnId, TxnInfo>;
  /** SER only: ops parked while another txn holds the engine. */
  queue: ScheduleStep[];
  /** SER only: the one admitted txn. */
  activeSer: TxnId | null;
  anomalies: Anomaly[];
  commits: number;
  aborts: number;
  queuedOps: number;
  skippedOps: number;
  /**
   * Monotonic per-node logical clock, ticked on begin/commit only.
   * The harness's virtual `time` is the same instant for every step of a
   * schedule (this module emits no timer/message effects, so the sim clock
   * never advances on its own) — SI's begin/commit ordering needs a signal
   * that actually varies, so `snapshotAt`/`committedAt` are stamped from
   * this instead of the (degenerate) `time` parameter.
   */
  clock: number;
}

const freshTxn = (): TxnInfo => ({
  status: 'idle',
  beganAt: null,
  endedAt: null,
  snapshotAt: null,
  reads: [],
  writes: [],
  abortReason: null,
});

export function txnInit(level: Level, config: ModuleConfig): TxnState {
  const initial = (config.params?.initial ?? {}) as Record<string, number>;
  const store: Record<string, Version[]> = {};
  for (const [k, v] of Object.entries(initial)) store[k] = [{ value: v, txn: null, committedAt: 0 }];
  return {
    level,
    store,
    txns: { T1: freshTxn(), T2: freshTxn() },
    queue: [],
    activeSer: null,
    anomalies: [],
    commits: 0,
    aborts: 0,
    queuedOps: 0,
    skippedOps: 0,
    clock: 0,
  };
}

/**
 * The level's read rule, walking the chain newest → oldest.
 * Own uncommitted writes are always visible (read-your-writes) at every level.
 */
function pickVersion(s: TxnState, reader: TxnId, key: string): Version | undefined {
  const chain = s.store[key] ?? [];
  for (let i = chain.length - 1; i >= 0; i--) {
    const v = chain[i];
    if (v.txn === reader && v.committedAt === null) return v;
    if (s.level === 'RU') return v; // latest version, committed or not
    if (v.committedAt === null) continue; // foreign uncommitted — invisible at RC/SI/SER
    if (s.level === 'SI') {
      const snap = s.txns[reader].snapshotAt;
      if (snap !== null && v.committedAt > snap) continue; // too new for this snapshot
    }
    return v;
  }
  return undefined;
}

function doRead(s: TxnState, txnId: TxnId, key: string, time: number): void {
  const t = s.txns[txnId];
  const v = pickVersion(s, txnId, key);
  t.reads.push({
    key,
    value: v?.value ?? 0,
    versionCommittedAt: v?.committedAt ?? null,
    from: v?.txn ?? null,
  });
  if (v && v.committedAt === null && v.txn !== txnId) {
    s.anomalies.push({
      type: 'dirty-read',
      detail: `${txnId} read ${key}=${v.value} — uncommitted data from ${v.txn}`,
      at: time,
    });
  }
}

function doWrite(s: TxnState, txnId: TxnId, key: string, value: WriteValue, time: number): void {
  const t = s.txns[txnId];
  let resolved: number;
  if (typeof value === 'number') {
    resolved = value;
  } else {
    const prior = [...t.reads].reverse().find((r) => r.key === key);
    if (prior) {
      resolved = prior.value + value.inc;
    } else {
      // blind increment: read at write time and record the dependency,
      // so the lost-update detector still sees the read-modify-write shape
      doRead(s, txnId, key, time);
      resolved = t.reads[t.reads.length - 1].value + value.inc;
    }
  }
  (s.store[key] ??= []).push({ value: resolved, txn: txnId, committedAt: null });
  if (!t.writes.includes(key)) t.writes.push(key);
}

function dropUncommitted(s: TxnState, txnId: TxnId): void {
  for (const key of Object.keys(s.store)) {
    s.store[key] = s.store[key].filter((v) => !(v.txn === txnId && v.committedAt === null));
  }
}

function doEnsure(s: TxnState, txnId: TxnId, keys: string[], atLeast: number, time: number): void {
  const t = s.txns[txnId];
  let sum = 0;
  for (const key of keys) {
    doRead(s, txnId, key, time);
    sum += t.reads[t.reads.length - 1].value;
  }
  if (sum < atLeast) {
    doAbort(s, txnId, time, `ensure failed: ${keys.join('+')}=${sum} < ${atLeast}`);
  }
}

function doAbort(s: TxnState, txnId: TxnId, time: number, reason: string): void {
  const t = s.txns[txnId];
  dropUncommitted(s, txnId);
  t.status = 'aborted';
  t.endedAt = time;
  t.abortReason = reason;
  s.aborts += 1;
}

function doCommit(s: TxnState, txnId: TxnId, time: number): void {
  const t = s.txns[txnId];
  if (s.level === 'SI') {
    const snap = t.snapshotAt ?? 0;
    for (const key of t.writes) {
      const conflict = (s.store[key] ?? []).some(
        (v) => v.txn !== txnId && v.committedAt !== null && v.committedAt > snap,
      );
      if (conflict) {
        doAbort(s, txnId, time, `write-write conflict on ${key} — first committer wins`);
        return;
      }
    }
  }
  s.clock += 1;
  for (const key of Object.keys(s.store)) {
    for (const v of s.store[key]) if (v.txn === txnId && v.committedAt === null) v.committedAt = s.clock;
  }
  t.status = 'committed';
  t.endedAt = time;
  s.commits += 1;
}

function apply(s: TxnState, txnId: TxnId, op: Op, time: number): void {
  const t = s.txns[txnId];
  switch (op.op) {
    case 'begin':
      s.clock += 1;
      t.status = 'active';
      t.beganAt = time;
      if (s.level === 'SI') t.snapshotAt = s.clock;
      if (s.level === 'SER') s.activeSer = txnId;
      break;
    case 'read':
      doRead(s, txnId, op.key, time);
      break;
    case 'write':
      doWrite(s, txnId, op.key, op.value, time);
      break;
    case 'ensure':
      doEnsure(s, txnId, op.keys, op.atLeast, time);
      break;
    case 'commit':
      doCommit(s, txnId, time);
      break;
    case 'abort':
      doAbort(s, txnId, time, 'rolled back by the schedule');
      break;
  }
  if (s.level === 'SER' && s.activeSer === txnId && (t.status === 'committed' || t.status === 'aborted')) {
    s.activeSer = null;
  }
}

/** SER: replay parked steps once the engine frees up. Runs after every applied step. */
function drainQueue(s: TxnState, time: number): void {
  while (s.queue.length > 0) {
    const head = s.queue[0];
    const ht = s.txns[head.txn];
    if (ht.status === 'committed' || ht.status === 'aborted') {
      s.queue.shift();
      s.skippedOps += 1;
      continue;
    }
    if (s.activeSer !== null && s.activeSer !== head.txn) return; // still blocked
    s.queue.shift();
    apply(s, head.txn, head.op, time);
  }
}

function runStep(s: TxnState, step: ScheduleStep, time: number): void {
  const t = s.txns[step.txn];
  // finished txns swallow their remaining ops — the schedule always runs to the end
  if (t.status === 'committed' || t.status === 'aborted') {
    s.skippedOps += 1;
    return;
  }
  if (s.level === 'SER') {
    const admissible = s.activeSer === step.txn || (s.activeSer === null && step.op.op === 'begin');
    if (!admissible) {
      s.queue.push(step);
      s.queuedOps += 1;
      if (t.status === 'idle') t.status = 'waiting';
      return;
    }
    apply(s, step.txn, step.op, time);
    drainQueue(s, time);
    return;
  }
  apply(s, step.txn, step.op, time);
}

export function applyStep(prev: TxnState, step: ScheduleStep, time: number): TxnState {
  const s = structuredClone(prev);
  runStep(s, step, time);
  return s;
}

export const txn: SimModule<TxnState, TxnPayload> = {
  id: 'txn-isolation',
  chaos: [],

  init(nodeId, config) {
    return txnInit(nodeId as Level, config);
  },

  reduce(state, event) {
    if (event.kind !== 'external') return [state, []];
    const p = event.payload as TxnPayload | null;
    if (!p || typeof p !== 'object' || !('schedule' in p)) return [state, []];
    return [applyStep(state, p.schedule, event.time), []];
  },

  metrics(states): MetricSample[] {
    const out: MetricSample[] = [];
    for (const s of states.values()) {
      const l = s.level.toLowerCase();
      out.push({ name: `${l}/commits`, value: s.commits });
      out.push({ name: `${l}/aborts`, value: s.aborts });
      out.push({ name: `${l}/anomalies`, value: s.anomalies.length });
    }
    return out;
  },

  inspect(state) {
    // minimal until Task 7
    return { level: state.level, credo: CREDOS[state.level] } as unknown as InspectorTree;
  },
};
