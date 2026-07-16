// Ch8 Unreliable Network Playground — vocabulary for the lease/fencing scenario.
import type { NodeId } from '../engine/events';

export const LOCK: NodeId = 'Lock';
export const W1: NodeId = 'W1';
export const W2: NodeId = 'W2';
export const STORE: NodeId = 'Store';
export const LEASE_TOPOLOGY: NodeId[] = [LOCK, W1, W2, STORE];

/** Lease duration on the Lock's (true) clock, in virtual ticks. */
export const LEASE_TTL = 60;
/** Worker check-loop period: every WRITE_EVERY ticks it re-checks its lease. */
export const WRITE_EVERY = 10;
/** The "expensive work" between checking the lease and using it — fig 8-4's window. */
export const WORK_TICKS = 6;
/** Store keeps this many recent history rows for the panel. */
export const HISTORY_CAP = 20;

export type LeaseMsg =
  | { kind: 'acquire' }
  | { kind: 'grant'; token: number; ttl: number }
  | { kind: 'expired'; token: number }
  | { kind: 'write'; token: number; value: string }
  | { kind: 'reject'; token: number };

export type LeaseExternal =
  | { cmd: 'acquire' } // to a worker: user asks it to request the lease
  | { cmd: 'fencing'; on: boolean } // to the Store
  | { fault: 'gc-pause'; ticks: number } // to a worker
  | { fault: 'clock-skew'; rate: number }; // to a worker; rate < 1 = slow clock

export type LeaseTimer =
  | { t: 'expiry'; token: number } // Lock: lease ran out on the true clock
  | { t: 'check' } // worker: periodic lease re-check
  | { t: 'work'; token: number } // worker: work done → send the write, no re-check
  | { t: 'wake'; inner: LeaseMsg | LeaseTimer }; // worker: deferred backlog from a GC pause

export type LeasePayload = LeaseMsg | LeaseExternal | LeaseTimer;

export type WriteOutcome = 'ok' | 'stale' | 'rejected';
