// src/modules/lease.ts
// Ch8 Unreliable Network Playground — a lease lock service, two check-then-act
// workers, and a store that may or may not check fencing tokens. One module,
// four roles, dispatched by node id. Pure; all unreliability comes from the
// engine's network (latency/drop/dup/partition) plus two module-interpreted
// faults: gc-pause and clock-skew.
import type { NodeId } from '../engine/events';
import type { Effect, InspectorTree, MetricSample, SimModule } from '../engine/module';
import {
  HISTORY_CAP,
  LEASE_TTL,
  LOCK,
  STORE,
  WORK_TICKS,
  WRITE_EVERY,
  type LeaseMsg,
  type LeasePayload,
  type LeaseTimer,
  type WriteOutcome,
} from './lease-shared';

export interface LockState {
  role: 'lock';
  holder: NodeId | null;
  token: number; // last token granted; monotonic
  expiresAt: number | null; // on the Lock's TRUE clock
  queue: NodeId[];
  granted: number;
}

export interface WorkerState {
  role: 'worker';
  id: NodeId;
  state: 'idle' | 'waiting' | 'holding';
  token: number | null;
  grantAt: number | null;
  ttl: number | null;
  /** Local clock rate: 1 = honest, <1 = slow (believes leases last longer). */
  rate: number;
  pausedUntil: number | null;
  working: boolean; // inside the check→work window right now
  writesSent: number;
  seq: number;
}

export interface HistoryRow {
  token: number;
  writer: string;
  outcome: WriteOutcome;
  at: number;
}

export interface StoreState {
  role: 'store';
  value: string | null;
  lastToken: number;
  fencing: boolean;
  history: HistoryRow[];
  writesOk: number;
  staleAccepts: number;
  rejects: number;
}

export type LeaseState = LockState | WorkerState | StoreState;

type Ev = { kind: 'init' | 'message' | 'timer' | 'external'; self: NodeId; from?: NodeId; time: number; payload: LeasePayload };

// ---------- Lock ----------

function grantTo(s: LockState, to: NodeId, now: number, fx: Effect[]): void {
  s.token += 1;
  s.holder = to;
  s.expiresAt = now + LEASE_TTL;
  s.granted += 1;
  fx.push({ type: 'send', to, payload: { kind: 'grant', token: s.token, ttl: LEASE_TTL } });
  fx.push({ type: 'timer', delay: LEASE_TTL, payload: { t: 'expiry', token: s.token } });
}

function lockReduce(prev: LockState, ev: Ev): [LockState, Effect[]] {
  const s = structuredClone(prev);
  const fx: Effect[] = [];
  const p = ev.payload;
  if (ev.kind === 'message' && 'kind' in p && p.kind === 'acquire' && ev.from) {
    if (s.holder === null) {
      grantTo(s, ev.from, ev.time, fx);
    } else if (s.holder === ev.from) {
      // an acquire from the CURRENT holder means it no longer believes in its
      // lease — release and re-serve. The old expiry timer stays armed; its
      // token guard makes it a no-op.
      s.holder = null;
      s.expiresAt = null;
      s.queue.push(ev.from); // fair: behind anyone already waiting
      const next = s.queue.shift();
      if (next) grantTo(s, next, ev.time, fx);
    } else if (!s.queue.includes(ev.from)) {
      s.queue.push(ev.from);
    }
  } else if (ev.kind === 'timer' && 't' in p && p.t === 'expiry') {
    // only the CURRENT lease's timer may release; re-grants outdate old timers.
    // No 'expired' push to the old holder: a real lock service can't reliably
    // notify a client of its own revocation (that's the whole premise of fig
    // 8-3/8-4 — the client can only find out from its own clock, or from a
    // fencing-token rejection at the store). A previous implementation sent an
    // active push here; it always outran even the worst-case store write from
    // the new holder (network latency [1,10] << grant-latency + WRITE_EVERY +
    // WORK_TICKS + write-latency), which made a pure clock-skew stale write
    // structurally impossible for any rate. See lease.test.ts's clock-skew tests.
    if (s.holder !== null && s.token === p.token) {
      s.holder = null;
      s.expiresAt = null;
      const next = s.queue.shift();
      if (next) grantTo(s, next, ev.time, fx);
    }
  }
  return [s, fx];
}

// ---------- Worker ----------

const dropLease = (s: WorkerState): void => {
  s.state = 'idle';
  s.token = null;
  s.grantAt = null;
  s.ttl = null;
  s.working = false;
};

/** The worker's own clock: elapsed local time since grant, scaled by its rate. */
const localElapsed = (s: WorkerState, now: number): number => (now - (s.grantAt ?? now)) * s.rate;

function workerHandle(s: WorkerState, p: LeaseMsg | LeaseTimer, now: number, fx: Effect[]): void {
  if ('kind' in p) {
    switch (p.kind) {
      case 'grant':
        if (s.state === 'waiting') {
          s.state = 'holding';
          s.token = p.token;
          s.grantAt = now;
          s.ttl = p.ttl;
          s.working = false;
          fx.push({ type: 'timer', delay: WRITE_EVERY, payload: { t: 'check' } });
        } else if (s.state === 'holding' && p.token > (s.token ?? 0)) {
          // the lock service re-served (e.g. it saw a duplicated acquire) —
          // believe it: adopt the fresh lease in place. No new check timer:
          // the live chain keeps running and reads the new fields.
          s.token = p.token;
          s.grantAt = now;
          s.ttl = p.ttl;
          s.working = false;
        }
        break; // grants with token ≤ current (duplicated/delayed) are ignored
      case 'expired':
        // the Lock no longer sends this (see lockReduce's expiry-timer branch) —
        // handler kept in case a future revision reintroduces a best-effort push.
        if (s.state === 'holding' && s.token === p.token) dropLease(s);
        break;
      case 'reject':
        // token guard like every other lease-ending path: a delayed/duplicated
        // reject for a superseded write must not evict a fresh valid lease
        if (s.state === 'holding' && s.token === p.token) dropLease(s); // the store knew better than our clock
        break;
      case 'acquire':
      case 'write':
        break; // not addressed to workers
    }
    return;
  }
  switch (p.t) {
    case 'check':
      if (s.state !== 'holding' || s.ttl === null) break;
      if (localElapsed(s, now) < s.ttl) {
        // lease looks valid on OUR clock → start the expensive work, then write
        // WITHOUT re-checking. This gap is DDIA fig 8-4.
        s.working = true;
        fx.push({ type: 'timer', delay: WORK_TICKS, payload: { t: 'work', token: s.token as number } });
        fx.push({ type: 'timer', delay: WRITE_EVERY, payload: { t: 'check' } });
      } else {
        dropLease(s); // our own clock says it's over
      }
      break;
    case 'work':
      if (s.state === 'holding' && s.token === p.token) {
        s.seq += 1;
        s.writesSent += 1;
        s.working = false;
        fx.push({ type: 'send', to: STORE, payload: { kind: 'write', token: p.token, value: `${s.id}#${s.seq}` } });
      }
      break;
    case 'expiry':
    case 'wake':
      break; // expiry is Lock-only; wake is unwrapped by workerReduce
  }
}

function workerReduce(prev: WorkerState, ev: Ev): [WorkerState, Effect[]] {
  const s = structuredClone(prev);
  const fx: Effect[] = [];
  const p = ev.payload;

  // user commands & faults act on the process from OUTSIDE — a paused process
  // can still be configured (and pausing while paused extends the pause)
  if (ev.kind === 'external') {
    if ('cmd' in p && p.cmd === 'acquire' && s.state === 'idle') {
      s.state = 'waiting';
      fx.push({ type: 'send', to: LOCK, payload: { kind: 'acquire' } });
    } else if ('fault' in p && p.fault === 'gc-pause') {
      s.pausedUntil = ev.time + p.ticks;
    } else if ('fault' in p && p.fault === 'clock-skew') {
      s.rate = p.rate;
    }
    return [s, fx];
  }

  // GC pause: the process sees nothing until it wakes — every message/timer is
  // re-emitted as a wake timer carrying the original payload, in arrival order.
  // A wake that itself lands mid-pause (a second pause extended past the first
  // wake) is unwrapped BEFORE re-deferral so the payload never nests.
  if (s.pausedUntil !== null && ev.time < s.pausedUntil) {
    fx.push({
      type: 'timer',
      delay: s.pausedUntil - ev.time,
      payload: { t: 'wake', inner: 't' in p && p.t === 'wake' ? p.inner : (p as LeaseMsg | LeaseTimer) },
    });
    return [s, fx];
  }

  let payload = p as LeaseMsg | LeaseTimer;
  while ('t' in payload && payload.t === 'wake') {
    s.pausedUntil = null; // the backlog is draining — the pause is over
    payload = payload.inner;
  }
  workerHandle(s, payload, ev.time, fx);
  return [s, fx];
}

// ---------- Store ----------

function storeReduce(prev: StoreState, ev: Ev): [StoreState, Effect[]] {
  const s = structuredClone(prev);
  const fx: Effect[] = [];
  const p = ev.payload;
  if (ev.kind === 'external' && 'cmd' in p && p.cmd === 'fencing') {
    s.fencing = p.on;
    return [s, fx];
  }
  if (ev.kind === 'message' && 'kind' in p && p.kind === 'write' && ev.from) {
    let outcome: WriteOutcome;
    if (s.fencing && p.token < s.lastToken) {
      outcome = 'rejected';
      s.rejects += 1;
      fx.push({ type: 'send', to: ev.from, payload: { kind: 'reject', token: p.token } });
    } else {
      outcome = p.token < s.lastToken ? 'stale' : 'ok';
      if (outcome === 'stale') s.staleAccepts += 1;
      else s.writesOk += 1;
      s.value = p.value;
      s.lastToken = Math.max(s.lastToken, p.token);
    }
    s.history.push({ token: p.token, writer: ev.from, outcome, at: ev.time });
    if (s.history.length > HISTORY_CAP) s.history.shift();
  }
  return [s, fx];
}

// ---------- Module ----------

export const lease: SimModule<LeaseState, LeasePayload> = {
  id: 'lease-fencing',
  chaos: ['kill-node', 'partition', 'delay', 'drop', 'duplicate', 'clock-skew'],

  init(nodeId) {
    if (nodeId === LOCK) {
      return { role: 'lock', holder: null, token: 0, expiresAt: null, queue: [], granted: 0 } satisfies LockState;
    }
    if (nodeId === STORE) {
      return {
        role: 'store',
        value: null,
        lastToken: 0,
        fencing: false,
        history: [],
        writesOk: 0,
        staleAccepts: 0,
        rejects: 0,
      } satisfies StoreState;
    }
    return {
      role: 'worker',
      id: nodeId,
      state: 'idle',
      token: null,
      grantAt: null,
      ttl: null,
      rate: 1,
      pausedUntil: null,
      working: false,
      writesSent: 0,
      seq: 0,
    } satisfies WorkerState;
  },

  reduce(state, event) {
    const ev = event as Ev;
    if (ev.kind === 'init') return [state, []];
    if (state.role === 'lock') return lockReduce(state, ev);
    if (state.role === 'store') return storeReduce(state, ev);
    return workerReduce(state, ev);
  },

  metrics(): MetricSample[] {
    return []; // Task 7
  },

  inspect(state) {
    return { role: state.role } as unknown as InspectorTree; // Task 7
  },
};
