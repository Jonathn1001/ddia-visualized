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
   * Monotonic per-node logical clock, ticked on begin/commit only — the
   * module's SOLE logical-time signal. The harness's virtual `time` is the
   * same instant for every step of a schedule (this module emits no
   * timer/message effects, so the sim clock never advances on its own) and
   * is never read here. Every timestamp in this state is stamped from this
   * clock: `snapshotAt`/`committedAt`, the `beganAt`/`endedAt` txn windows,
   * and every `Anomaly.at`.
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

function doRead(s: TxnState, txnId: TxnId, key: string): void {
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
      at: s.clock,
    });
  }
}

function doWrite(s: TxnState, txnId: TxnId, key: string, value: WriteValue): void {
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
      doRead(s, txnId, key);
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

function doEnsure(s: TxnState, txnId: TxnId, keys: string[], atLeast: number): void {
  const t = s.txns[txnId];
  let sum = 0;
  for (const key of keys) {
    doRead(s, txnId, key);
    sum += t.reads[t.reads.length - 1].value;
  }
  if (sum < atLeast) {
    doAbort(s, txnId, `ensure failed: ${keys.join('+')}=${sum} < ${atLeast}`);
  }
}

function doAbort(s: TxnState, txnId: TxnId, reason: string): void {
  const t = s.txns[txnId];
  dropUncommitted(s, txnId);
  t.status = 'aborted';
  t.endedAt = s.clock;
  t.abortReason = reason;
  s.aborts += 1;
}

/**
 * Lost update: this txn committed a write to a key it last read at a stale
 * version — some other txn committed a newer version in between, and that
 * update is now clobbered. Level-blind: it observes the actual history.
 * Called after doCommit ticked and stamped the clock, so own versions carry
 * committedAt === s.clock; a foreign commit that happened in between carries
 * a strictly smaller stamp — `> readStamp && < s.clock` is exactly "committed
 * after my read, before my commit".
 */
function detectLostUpdate(s: TxnState, txnId: TxnId): void {
  const t = s.txns[txnId];
  for (const key of t.writes) {
    // The base is the last FOREIGN read — reads after an own write return the
    // own version (read-your-writes, from === txnId), which is no external
    // dependency at all. Foreign reads necessarily precede the first own write.
    const lastRead = [...t.reads].reverse().find((r) => r.key === key && r.from !== txnId);
    if (!lastRead) continue; // blind write — not a read-modify-write clobber
    const readStamp = lastRead.versionCommittedAt ?? -1;
    const clobbered = (s.store[key] ?? []).some(
      (v) => v.txn !== txnId && v.committedAt !== null && v.committedAt > readStamp && v.committedAt < s.clock,
    );
    if (clobbered) {
      s.anomalies.push({
        type: 'lost-update',
        detail: `${txnId} overwrote ${key} from a stale read — a concurrent committed update vanished`,
        at: s.clock,
      });
    }
  }
}

/**
 * Write skew: both txns committed, their active windows overlapped, they wrote
 * DISJOINT key sets but each read a key the other wrote. The doctors shape.
 */
function detectWriteSkew(s: TxnState, me: TxnId): void {
  const otherId: TxnId = me === 'T1' ? 'T2' : 'T1';
  const a = s.txns[me];
  const b = s.txns[otherId];
  if (b.status !== 'committed') return;
  if (a.writes.length === 0 || b.writes.length === 0) return;
  if (a.writes.some((k) => b.writes.includes(k))) return; // overlapping writes → not skew
  if (a.beganAt === null || b.beganAt === null || a.endedAt === null || b.endedAt === null) return;
  if (!(a.beganAt < b.endedAt && b.beganAt < a.endedAt)) return; // windows must overlap
  const aReadB = a.reads.some((r) => b.writes.includes(r.key));
  const bReadA = b.reads.some((r) => a.writes.includes(r.key));
  if (aReadB && bReadA) {
    s.anomalies.push({
      type: 'write-skew',
      detail: `${me} and ${otherId} read each other's keys, wrote disjoint ones, both committed`,
      at: s.clock,
    });
  }
}

function doCommit(s: TxnState, txnId: TxnId): void {
  const t = s.txns[txnId];
  if (s.level === 'SI') {
    const snap = t.snapshotAt ?? 0;
    for (const key of t.writes) {
      const conflict = (s.store[key] ?? []).some(
        (v) => v.txn !== txnId && v.committedAt !== null && v.committedAt > snap,
      );
      if (conflict) {
        doAbort(s, txnId, `write-write conflict on ${key} — first committer wins`);
        return;
      }
    }
  }
  s.clock += 1;
  for (const key of Object.keys(s.store)) {
    for (const v of s.store[key]) if (v.txn === txnId && v.committedAt === null) v.committedAt = s.clock;
  }
  t.status = 'committed';
  t.endedAt = s.clock;
  s.commits += 1;
  detectLostUpdate(s, txnId);
  detectWriteSkew(s, txnId);
}

function apply(s: TxnState, txnId: TxnId, op: Op): void {
  const t = s.txns[txnId];
  switch (op.op) {
    case 'begin':
      s.clock += 1;
      t.status = 'active';
      t.beganAt = s.clock;
      if (s.level === 'SI') t.snapshotAt = s.clock;
      if (s.level === 'SER') s.activeSer = txnId;
      break;
    case 'read':
      doRead(s, txnId, op.key);
      break;
    case 'write':
      doWrite(s, txnId, op.key, op.value);
      break;
    case 'ensure':
      doEnsure(s, txnId, op.keys, op.atLeast);
      break;
    case 'commit':
      doCommit(s, txnId);
      break;
    case 'abort':
      doAbort(s, txnId, 'rolled back by the schedule');
      break;
  }
  if (s.level === 'SER' && s.activeSer === txnId && (t.status === 'committed' || t.status === 'aborted')) {
    s.activeSer = null;
  }
}

/** SER: replay parked steps once the engine frees up. Runs after every applied step. */
function drainQueue(s: TxnState): void {
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
    apply(s, head.txn, head.op);
  }
}

function runStep(s: TxnState, step: ScheduleStep): void {
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
    apply(s, step.txn, step.op);
    drainQueue(s);
    return;
  }
  apply(s, step.txn, step.op);
}

export function applyStep(prev: TxnState, step: ScheduleStep): TxnState {
  const s = structuredClone(prev);
  runStep(s, step);
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
    return [applyStep(state, p.schedule), []];
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
