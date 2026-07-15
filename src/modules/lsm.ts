import type { NodeId } from '../engine/events';
import type { Effect, ModuleConfig, ModuleEvent } from '../engine/module';
import {
  BYTES_PER_ENTRY, DEFAULT_DISK_CAP, LSM, MEMTABLE_CAP,
  bloomHashes, isOp, isTimer, type Counters, type StoragePayload,
} from './storage-shared';

export interface Entry {
  key: string;
  val: string | null; // null = tombstone
}
export interface WalRec {
  seq: number;
  key: string;
  val: string | null;
}
export interface SSTable {
  level: 0 | 1;
  entries: Entry[]; // immutable sorted run
  bloom: number[]; // set bit indices
  min: string;
  max: string;
}

export interface LsmState extends Counters {
  engine: 'lsm';
  self: NodeId;
  memtable: Entry[]; // sorted by key
  wal: WalRec[];
  walAckSeq: number;
  sstables: SSTable[];
  phase: 'idle' | 'flushing' | 'compacting' | 'recovering';
  lastReadCost: number;
  bloomSkips: number;
  diskCap: number;
  diskFull: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- config is unused until a later task adds config-driven params
export function lsmInit(_config: ModuleConfig): LsmState {
  return {
    engine: 'lsm',
    self: LSM,
    memtable: [],
    wal: [],
    walAckSeq: 0,
    sstables: [],
    phase: 'idle',
    diskReads: 0,
    diskWrites: 0,
    bytesWritten: 0,
    userBytes: 0,
    lastReadCost: 0,
    bloomSkips: 0,
    diskCap: DEFAULT_DISK_CAP,
    diskFull: false,
  };
}

/** Upsert into a key-sorted entry array, returning a new array. */
function upsert(entries: Entry[], e: Entry): Entry[] {
  const out = entries.filter((x) => x.key !== e.key);
  out.push(e);
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

function applyWrite(s: LsmState, key: string, val: string | null): LsmState {
  const seq = s.walAckSeq + 1;
  return {
    ...s,
    wal: [...s.wal, { seq, key, val }],
    walAckSeq: seq,
    memtable: upsert(s.memtable, { key, val }),
    diskWrites: s.diskWrites + 1,
    bytesWritten: s.bytesWritten + BYTES_PER_ENTRY,
    userBytes: s.userBytes + BYTES_PER_ENTRY,
  };
}

/** Bit array (set bit indices, sorted) built from every entry's bloom hashes. */
export function buildBloom(entries: Entry[]): number[] {
  const bits = new Set<number>();
  for (const e of entries) for (const b of bloomHashes(e.key)) bits.add(b);
  return [...bits].sort((a, b) => a - b);
}

/** Sound (no false negatives): true if the key's bits are all set, false only if truly absent. */
export function bloomMightContain(bloom: number[], key: string): boolean {
  return bloomHashes(key).every((b) => bloom.includes(b));
}

/** After a write, if the memtable is full and we're idle, request a flush (2-phase, via timer). */
function maybeFlush(s: LsmState): [LsmState, Effect[]] {
  if (s.phase === 'idle' && s.memtable.length > MEMTABLE_CAP) {
    return [{ ...s, phase: 'flushing' }, [{ type: 'timer', delay: 10, payload: { timer: 'flush-phase2' } }]];
  }
  return [s, []];
}

/** Commits the pending memtable into a new L0 SSTable and returns the engine to idle. */
function flushPhase2(s: LsmState): LsmState {
  if (s.memtable.length === 0) return { ...s, phase: 'idle' };
  const entries = s.memtable;
  const table: SSTable = {
    level: 0,
    entries,
    bloom: buildBloom(entries),
    min: entries[0].key,
    max: entries[entries.length - 1].key,
  };
  return {
    ...s,
    sstables: [...s.sstables, table],
    memtable: [],
    wal: [], // flushed prefix is now durable in the SSTable
    bytesWritten: s.bytesWritten + entries.length * BYTES_PER_ENTRY,
    diskWrites: s.diskWrites + 1,
    phase: 'idle',
  };
}

/** Point read: memtable first, then SSTables newest→oldest. Counts read cost. */
export function lsmGet(s: LsmState, key: string): { state: LsmState; value: string | undefined } {
  const inMem = s.memtable.find((e) => e.key === key);
  if (inMem) {
    return { state: { ...s, lastReadCost: 1, diskReads: s.diskReads + 1 }, value: inMem.val ?? undefined };
  }
  let cost = 0;
  let skips = 0;
  for (let i = s.sstables.length - 1; i >= 0; i--) {
    const t = s.sstables[i];
    if (!bloomMightContain(t.bloom, key)) {
      skips++;
      continue; // bloom provably rejects: no false negatives, so this table cannot hold the key
    }
    cost++;
    const hit = t.entries.find((e) => e.key === key);
    if (hit) {
      return {
        state: { ...s, lastReadCost: cost, diskReads: s.diskReads + cost, bloomSkips: s.bloomSkips + skips },
        value: hit.val ?? undefined,
      };
    }
  }
  return {
    state: { ...s, lastReadCost: cost, diskReads: s.diskReads + cost, bloomSkips: s.bloomSkips + skips },
    value: undefined,
  };
}

export function lsmReduce(state: LsmState, event: ModuleEvent<StoragePayload>): [LsmState, Effect[]] {
  const p = event.payload;
  if (isTimer(p)) {
    if (p.timer === 'flush-phase2') return [flushPhase2(state), []];
    return [state, []];
  }
  if (isOp(p)) {
    if (p.op === 'get') return [lsmGet(state, p.key).state, []]; // read updates counters
    const written = p.op === 'put' ? applyWrite(state, p.key, p.val) : applyWrite(state, p.key, null);
    return maybeFlush(written);
  }
  return [state, []];
}

export interface LsmInspect {
  engine: 'lsm';
  memtable: Entry[];
  sstables: SSTable[];
  walLen: number;
  phase: LsmState['phase'];
  diskReads: number;
  diskWrites: number;
  bytesWritten: number;
  userBytes: number;
  lastReadCost: number;
  bloomSkips: number;
  diskFull: boolean;
}

export function lsmInspect(s: LsmState): LsmInspect {
  return {
    engine: 'lsm',
    memtable: s.memtable,
    sstables: s.sstables,
    walLen: s.wal.length,
    phase: s.phase,
    diskReads: s.diskReads,
    diskWrites: s.diskWrites,
    bytesWritten: s.bytesWritten,
    userBytes: s.userBytes,
    lastReadCost: s.lastReadCost,
    bloomSkips: s.bloomSkips,
    diskFull: s.diskFull,
  };
}
