import type { NodeId } from '../engine/events';
import { fnv1a } from '../engine/hash';

/** Ch3 storage lab: two engines, side-by-side, same workload. */
export const LSM: NodeId = 'LSM';
export const BTREE: NodeId = 'Btree';
export const STORAGE_TOPOLOGY: NodeId[] = [LSM, BTREE];

/** Bounded so flush/compaction/split are frequent and watchable (not realistic sizes). */
export const MEMTABLE_CAP = 4; // memtable entries before an LSM flush
export const L0_TRIGGER = 3; // L0 runs before an LSM compaction
export const BTREE_ORDER = 3; // max keys per B-tree page before a split
export const BYTES_PER_ENTRY = 16; // illustrative user bytes per key/value
export const DEFAULT_DISK_CAP = 512; // bytes on disk before disk-full bites
export const BLOOM_BITS = 64; // bits per SSTable bloom filter

/** User-issued operations (arrive as external events, mirrored to both engines). */
export type StorageOp =
  | { op: 'put'; key: string; val: string }
  | { op: 'get'; key: string }
  | { op: 'delete'; key: string };

/** Storage-domain faults (external events the engine interprets — not ControlActions). */
export type StorageFault =
  | { fault: 'crash-mid-write' }
  | { fault: 'torn-write' }
  | { fault: 'disk-full' }
  | { fault: 'recover' }; // clear disk-full pressure / finish recovery

/** Internal deferred work each engine schedules on itself via timer effects. */
export type StorageTimer =
  | { timer: 'flush-phase2' }
  | { timer: 'compact' }
  | { timer: 'split-commit' };

export type StoragePayload = StorageOp | StorageFault | StorageTimer | null;

export function isOp(p: StoragePayload): p is StorageOp {
  return !!p && 'op' in p;
}
export function isFault(p: StoragePayload): p is StorageFault {
  return !!p && 'fault' in p;
}
export function isTimer(p: StoragePayload): p is StorageTimer {
  return !!p && 'timer' in p;
}

export interface Counters {
  diskReads: number;
  diskWrites: number;
  bytesWritten: number;
  userBytes: number;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** LSM's headline cost: total bytes written (incl. compaction rewrites) vs user bytes. */
export function writeAmp(c: Counters): number {
  return c.userBytes > 0 ? round2(c.bytesWritten / c.userBytes) : 0;
}

/** murmur fmix32 avalanche — same finalizer the ring uses, for well-spread bloom bits. */
function mix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Two independent bit indices for a key — pure, deterministic. */
export function bloomHashes(key: string): [number, number] {
  const h = mix32(fnv1a(key));
  const g = mix32(h ^ 0x9e3779b9);
  return [h % BLOOM_BITS, g % BLOOM_BITS];
}
