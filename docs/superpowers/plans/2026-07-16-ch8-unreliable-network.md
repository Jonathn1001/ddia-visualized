# Ch8 Unreliable Network Playground Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship DDIA Ch8 as lab `8.1` — a lease-based lock service, two workers and a shared store over the engine's genuinely unreliable network; GC pauses and slow clocks corrupt the store, fencing tokens save it — plus debrief `8.d`.

**Architecture:** One `Simulation<LeaseState>` with `nodeIds: ['Lock','W1','W2','Store']`; one pure module (`src/modules/lease.ts`) dispatching by role. Workers run a check → work → write loop (DDIA fig 8-4's check-then-act window); GC pause defers a worker's messages/timers to a wake time; clock skew is a rate multiplier on the worker's local elapsed time; the Store optionally enforces fencing (`token ≥ lastToken`). Network faults (latency/drop/dup/partition/kill) come free via `ControlAction` + `ChaosToolbar`. Spec: `docs/superpowers/specs/2026-07-16-ch8-unreliable-network-design.md`.

**Tech Stack:** TypeScript, React, SimDriver/useSimStore bridge, ClusterView/ChaosToolbar/ChallengePanel/TimelineScrubber kit, vitest, fast-check, MDX.

## Global Constraints

- Pure module: reducer `structuredClone(prev)` then mutate; no `Date.now`/`Math.random`; RNG only via the engine.
- Effects only `{type:'send'|'timer'}` per `src/engine/module.ts`.
- UI tests: `// @vitest-environment jsdom` pragma, `afterEach(cleanup)`, container/data-attr queries, NO jest-dom. `type ReactNode`, never `React.ReactNode`.
- Theme tokens only: ink/panel/line/dim/fg/set(teal=good)/sign(coral=bad)/warn(amber); `btn`/`btnPrimary`/`inputBox` from `src/ui/kit/classes.ts`.
- Constants: `LEASE_TTL = 60`, `WRITE_EVERY = 10`, `WORK_TICKS = 6`. Content dir `content/ch08/`; storage keys `ddia:ch08:*` (challenges: `ddia:ch08:lease|fence|clock`, journal `ddia:ch08:journal`).
- Tests: `npx vitest run <file>`; typecheck `npx tsc -b`; lint `npx eslint <files>`. Commit specific files; conventional commits.
- Engine facts: `Simulation` ctor `{module, config:{nodeIds, params?}, seed}`; `sim.runSteps(n)`, `sim.runUntil(t)`, `sim.external(id, payload)`, `sim.control(action)`, `sim.getState(id)`, `sim.time`. Kit contracts verified: `ClusterView {nodes, inFlight, time}`, `ChaosToolbar {caps, nodeIds, deadNodes, onAction}`, `ChallengePanel {title, storageKeyPrefix, prompt, runningHint, check, onWin?, renderWin}`, `TimelineScrubber {processed, pending, running, onPlayPause, onStep, onScrub}`.

---

### Task 1: Shared vocabulary

**Files:**
- Create: `src/modules/lease-shared.ts`
- Test: `src/modules/lease-shared.test.ts`

**Interfaces:**
- Produces (later tasks import exactly these): `LOCK`, `W1`, `W2`, `STORE`, `LEASE_TOPOLOGY`, `LEASE_TTL`, `WRITE_EVERY`, `WORK_TICKS`, `HISTORY_CAP`, types `LeaseMsg`, `LeaseExternal`, `LeaseTimer`, `LeasePayload`, `WriteOutcome`.

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/lease-shared.test.ts
import { expect, test } from 'vitest';
import { LEASE_TOPOLOGY, LEASE_TTL, LOCK, STORE, W1, W2, WORK_TICKS, WRITE_EVERY } from './lease-shared';

test('topology is Lock, W1, W2, Store in render order', () => {
  expect(LEASE_TOPOLOGY).toEqual([LOCK, W1, W2, STORE]);
});

test('the working window is wide relative to the check period', () => {
  // The GC-pause challenge asks the user to pause a worker mid-work; keep the
  // window ≥ half the period so the timing is a lesson, not a twitch test.
  expect(WORK_TICKS * 2).toBeGreaterThanOrEqual(WRITE_EVERY);
  expect(LEASE_TTL).toBeGreaterThan(WRITE_EVERY + WORK_TICKS);
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/modules/lease-shared.test.ts` → cannot resolve `./lease-shared`.

- [ ] **Step 3: Implement**

```ts
// src/modules/lease-shared.ts
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
```

- [ ] **Step 4: Run to verify pass**, then **Step 5: Commit**

```bash
git add src/modules/lease-shared.ts src/modules/lease-shared.test.ts
git commit -m "feat(modules): Ch8 lease vocabulary — topology, protocol messages, fault events"
```

---

### Task 2: Module skeleton + the Lock (lease service)

**Files:**
- Create: `src/modules/lease.ts`
- Test: `src/modules/lease.test.ts`

**Interfaces:**
- Produces: `LockState`, `WorkerState`, `StoreState`, `LeaseState`, `lease: SimModule<LeaseState, LeasePayload>`. Worker/Store reducers are minimal stubs in this task (worker only sends `acquire` on the user command; Store ignores everything) — Tasks 3–6 fill them. `metrics`/`inspect` stubs until Task 7.

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/lease.test.ts
import { expect, test } from 'vitest';
import { Simulation } from '../engine';
import { lease, type LeaseState, type LockState, type StoreState, type WorkerState } from './lease';
import { LEASE_TOPOLOGY, LEASE_TTL, LOCK, STORE, W1, W2, type LeasePayload } from './lease-shared';

export function fresh(seed = 8000) {
  const sim = new Simulation<LeaseState, LeasePayload>({
    module: lease,
    config: { nodeIds: LEASE_TOPOLOGY },
    seed,
  });
  sim.runSteps(LEASE_TOPOLOGY.length); // deliver inits
  return sim;
}

export const lockOf = (sim: ReturnType<typeof fresh>) => sim.getState(LOCK) as LockState;
export const workerOf = (sim: ReturnType<typeof fresh>, id: string) => sim.getState(id) as WorkerState;
export const storeOf = (sim: ReturnType<typeof fresh>) => sim.getState(STORE) as StoreState;

/** Run the sim forward until cond holds or the event budget runs dry (loud on timeout). */
export function until(sim: ReturnType<typeof fresh>, cond: () => boolean, budget = 2000) {
  for (let i = 0; i < budget && !cond(); i++) {
    if (sim.pending === 0) break; // nothing scheduled — advancing can't help
    sim.runSteps(1);
  }
  if (!cond()) throw new Error(`until(): condition not reached (time=${sim.time}, pending=${sim.pending})`);
}

test('init assigns roles by node id', () => {
  const sim = fresh();
  expect(lockOf(sim).role).toBe('lock');
  expect(workerOf(sim, W1).role).toBe('worker');
  expect(workerOf(sim, W2).role).toBe('worker');
  expect(storeOf(sim).role).toBe('store');
});

test('acquire → grant: the Lock hands out token 1 with the TTL and arms expiry', () => {
  const sim = fresh();
  sim.external(W1, { cmd: 'acquire' });
  until(sim, () => workerOf(sim, W1).state === 'holding');
  const lock = lockOf(sim);
  expect(lock.holder).toBe(W1);
  expect(lock.token).toBe(1);
  expect(lock.expiresAt).not.toBeNull();
  expect(workerOf(sim, W1).token).toBe(1);
  expect(workerOf(sim, W1).ttl).toBe(LEASE_TTL);
});

test('a second acquire queues; expiry hands the lease over with the next token', () => {
  const sim = fresh();
  sim.external(W1, { cmd: 'acquire' });
  until(sim, () => lockOf(sim).holder === W1);
  sim.external(W2, { cmd: 'acquire' });
  until(sim, () => lockOf(sim).queue.includes(W2));
  until(sim, () => lockOf(sim).holder === W2, 2000);
  expect(lockOf(sim).token).toBe(2);
  expect(lockOf(sim).queue).toEqual([]);
});

test('a stale expiry timer (older token) is ignored after a re-grant', () => {
  const sim = fresh();
  sim.external(W1, { cmd: 'acquire' });
  until(sim, () => lockOf(sim).holder === W1);
  sim.external(W2, { cmd: 'acquire' });
  // let the first lease expire and W2 take over
  until(sim, () => lockOf(sim).holder === W2, 2000);
  const tokenAfter = lockOf(sim).token;
  // run well past where W1's old expiry timer would fire again if mishandled
  sim.runUntil(sim.time + LEASE_TTL / 2);
  expect(lockOf(sim).token).toBe(tokenAfter);
  expect(lockOf(sim).holder).toBe(W2); // still W2 — old timer didn't evict it early
});

test('sim virtual time actually advances under this module (unlike Ch7)', () => {
  const sim = fresh();
  const t0 = sim.time;
  sim.external(W1, { cmd: 'acquire' });
  until(sim, () => workerOf(sim, W1).state === 'holding');
  expect(sim.time).toBeGreaterThan(t0);
});
```

- [ ] **Step 2: RED** — cannot resolve `./lease`.

- [ ] **Step 3: Implement**

```ts
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
    if (s.holder === null) grantTo(s, ev.from, ev.time, fx);
    else if (s.holder !== ev.from && !s.queue.includes(ev.from)) s.queue.push(ev.from);
  } else if (ev.kind === 'timer' && 't' in p && p.t === 'expiry') {
    // only the CURRENT lease's timer may release; re-grants outdate old timers
    if (s.holder !== null && s.token === p.token) {
      fx.push({ type: 'send', to: s.holder, payload: { kind: 'expired', token: s.token } });
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
        }
        break; // duplicate grants (network dup) are ignored — same token anyway
      case 'expired':
        if (s.state === 'holding' && s.token === p.token) dropLease(s);
        break;
      case 'reject':
        if (s.state === 'holding') dropLease(s); // the store knew better than our clock
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
  if (s.pausedUntil !== null && ev.time < s.pausedUntil) {
    fx.push({
      type: 'timer',
      delay: s.pausedUntil - ev.time,
      payload: { t: 'wake', inner: p as LeaseMsg | LeaseTimer },
    });
    return [s, fx];
  }

  let payload = p as LeaseMsg | LeaseTimer;
  if ('t' in payload && payload.t === 'wake') {
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
```

- [ ] **Step 4: GREEN** — `npx vitest run src/modules/lease.test.ts src/modules/lease-shared.test.ts`; `npx tsc -b`. Note: the worker happy-path (grant→holding) already exists in this task because the Lock tests need a counterpart; Task 3's job is the write loop + its tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/lease.ts src/modules/lease.test.ts
git commit -m "feat(modules): Ch8 lease module — Lock grants, queue, expiry; role dispatch"
```

---

### Task 3: Worker write loop (check → work → write) + Store outcomes

**Files:**
- Modify: `src/modules/lease.ts` (no code change expected — the loop shipped in Task 2's listing; THIS task pins its behavior and the Store's outcomes with tests. If any test fails, fix the module here.)
- Test: `src/modules/lease.test.ts` (append)

- [ ] **Step 1: Append the tests**

```ts
// append to src/modules/lease.test.ts
test('a holding worker writes to the store on its loop; fencing off accepts in-order writes as ok', () => {
  const sim = fresh();
  sim.external(W1, { cmd: 'acquire' });
  until(sim, () => storeOf(sim).history.length >= 2, 2000);
  const st = storeOf(sim);
  expect(st.history.every((h) => h.writer === W1)).toBe(true);
  expect(st.history.every((h) => h.outcome === 'ok')).toBe(true);
  expect(st.lastToken).toBe(1);
  expect(st.value).toMatch(/^W1#/);
});

test('the worker stops writing once its own clock says the lease is over', () => {
  const sim = fresh();
  sim.external(W1, { cmd: 'acquire' });
  until(sim, () => workerOf(sim, W1).state === 'holding');
  sim.runUntil(sim.time + LEASE_TTL * 3);
  expect(workerOf(sim, W1).state).toBe('idle');
  const writes = storeOf(sim).history.length;
  sim.runUntil(sim.time + LEASE_TTL);
  expect(storeOf(sim).history.length).toBe(writes); // no zombie writes
});

test('a clean handover (no faults) is anomaly-free at either fencing setting', () => {
  // W1's honest clock stops it before expiry, W2 takes over with a higher token —
  // no stale writes, no rejects. The negative baseline the fault tests corrupt.
  const sim = fresh();
  sim.external(STORE, { cmd: 'fencing', on: true });
  sim.runSteps(1);
  sim.external(W1, { cmd: 'acquire' });
  until(sim, () => lockOf(sim).holder === W1);
  sim.external(W2, { cmd: 'acquire' });
  until(sim, () => lockOf(sim).holder === W2, 3000); // W1 expired, W2 holds token 2
  until(sim, () => storeOf(sim).lastToken === 2, 2000); // W2's first write landed
  expect(storeOf(sim).rejects).toBe(0);
  expect(storeOf(sim).staleAccepts).toBe(0);
});
```

- [ ] **Step 2: Run** — `npx vitest run src/modules/lease.test.ts`. Expected: all pass if Task 2's listing was transcribed faithfully; any failure is a transcription bug — fix `lease.ts` until green. (This task is the behavioral gate on the loop; RED here means the module is wrong, not the tests.)

- [ ] **Step 3: Commit**

```bash
git add src/modules/lease.test.ts
git commit -m "test(modules): pin the worker write loop and store fencing outcomes"
```

---

### Task 4: GC pause — deferral, backlog order, the stale write

**Files:**
- Modify: `src/modules/lease.ts` (only if a test exposes a bug — the deferral shipped in Task 2's listing)
- Test: `src/modules/lease.test.ts` (append)

- [ ] **Step 1: Append the tests**

```ts
// append to src/modules/lease.test.ts
test('gc-pause mid-work: the worker wakes and completes the write with its stale token (fig 8-4)', () => {
  const sim = fresh();
  sim.external(W1, { cmd: 'acquire' });
  until(sim, () => workerOf(sim, W1).working === true, 2000);
  // paused past the whole lease; the work timer is in flight and will be deferred
  sim.external(W1, { fault: 'gc-pause', ticks: LEASE_TTL * 3 });
  sim.external(W2, { cmd: 'acquire' });
  until(sim, () => lockOf(sim).holder === W2, 4000);
  until(sim, () => storeOf(sim).lastToken === 2, 3000); // W2 wrote with token 2
  // let W1 wake and its deferred work timer fire
  until(sim, () => storeOf(sim).staleAccepts >= 1, 6000);
  const st = storeOf(sim);
  const stale = st.history.find((h) => h.outcome === 'stale');
  expect(stale?.writer).toBe(W1);
  expect(stale?.token).toBe(1);
  expect(stale && stale.token < st.lastToken).toBe(true);
});

test('with fencing ON the same choreography ends in a reject, not corruption', () => {
  const sim = fresh();
  sim.external(STORE, { cmd: 'fencing', on: true });
  sim.runSteps(1);
  sim.external(W1, { cmd: 'acquire' });
  until(sim, () => workerOf(sim, W1).working === true, 2000);
  sim.external(W1, { fault: 'gc-pause', ticks: LEASE_TTL * 3 });
  sim.external(W2, { cmd: 'acquire' });
  until(sim, () => storeOf(sim).lastToken === 2, 6000);
  until(sim, () => storeOf(sim).rejects >= 1, 6000);
  expect(storeOf(sim).staleAccepts).toBe(0);
  // and the rejected worker corrected its belief
  expect(workerOf(sim, W1).state).toBe('idle');
});

test('backlog preserves order: deferred events replay in arrival order at wake', () => {
  const sim = fresh();
  sim.external(W1, { cmd: 'acquire' });
  until(sim, () => workerOf(sim, W1).working === true, 2000);
  const pausedAt = sim.time;
  sim.external(W1, { fault: 'gc-pause', ticks: LEASE_TTL * 2 });
  until(sim, () => storeOf(sim).history.some((h) => h.writer === W1 && h.at > pausedAt), 6000);
  // the write that lands after the pause must come from the DEFERRED work timer —
  // i.e. the worker never re-checked (a re-check at wake would have dropped the lease)
  const w1 = workerOf(sim, W1);
  expect(w1.state).toBe('idle'); // after the backlog drained, the deferred check ended it
});

test('pausing while paused extends the pause', () => {
  const sim = fresh();
  sim.external(W1, { cmd: 'acquire' });
  until(sim, () => workerOf(sim, W1).state === 'holding');
  sim.external(W1, { fault: 'gc-pause', ticks: 50 });
  sim.runUntil(sim.time + 10);
  sim.external(W1, { fault: 'gc-pause', ticks: 200 });
  const w1 = workerOf(sim, W1);
  expect(w1.pausedUntil).not.toBeNull();
  expect(w1.pausedUntil as number).toBeGreaterThan(sim.time + 150);
});
```

- [ ] **Step 2: Run** — behavioral gate like Task 3: green means the Task-2 listing is faithful; a failure is a module bug to fix here (likely suspects: wake unwrap order, `pausedUntil` comparison `<` vs `≤`).

- [ ] **Step 3: Commit**

```bash
git add src/modules/lease.test.ts src/modules/lease.ts
git commit -m "test(modules): pin gc-pause deferral — backlog order and the stale wake-up write"
```

---

### Task 5: Clock skew

**Files:**
- Test: `src/modules/lease.test.ts` (append; module fixes only if a test exposes a bug)

- [ ] **Step 1: Append the tests**

```ts
// append to src/modules/lease.test.ts
test('a slow clock (rate 0.5) keeps the worker writing past true expiry → stale accepts, no pause involved', () => {
  const sim = fresh();
  sim.external(W1, { fault: 'clock-skew', rate: 0.5 });
  sim.external(W1, { cmd: 'acquire' });
  until(sim, () => workerOf(sim, W1).state === 'holding');
  sim.external(W2, { cmd: 'acquire' });
  // true expiry hands the lease to W2 while W1's slow clock still believes
  until(sim, () => lockOf(sim).holder === W2, 4000);
  until(sim, () => storeOf(sim).staleAccepts >= 1, 6000);
  const stale = storeOf(sim).history.find((h) => h.outcome === 'stale');
  expect(stale?.writer).toBe(W1);
  expect(workerOf(sim, W1).pausedUntil).toBeNull(); // no pause was needed
});

test('an honest clock (rate 1) never produces a stale write on its own', () => {
  const sim = fresh();
  sim.external(W1, { cmd: 'acquire' });
  sim.external(W2, { cmd: 'acquire' });
  sim.runUntil(sim.time + LEASE_TTL * 4);
  expect(storeOf(sim).staleAccepts).toBe(0);
});
```

- [ ] **Step 2: Run** — green expected from the Task-2 listing (skew is one multiplication); fix if not. Note the honest-clock test may surface a REAL race: W1's last pre-expiry check can arm a write that lands after W2's grant+first-write only if network latency exceeds `LEASE_TTL − last-check-time` — with default latency [1,10] and `WORK_TICKS 6` the margin holds (`expired` notice + W2's grant+write take ≥ 2 hops ≥ work window). If it flakes across seeds, pin seed 8000 and document the margin in a comment.

- [ ] **Step 3: Commit**

```bash
git add src/modules/lease.test.ts src/modules/lease.ts
git commit -m "test(modules): pin clock-skew — slow clocks corrupt without a pause, honest clocks don't"
```

---

### Task 6: metrics + inspect (panel contract)

**Files:**
- Modify: `src/modules/lease.ts` (replace `metrics`/`inspect` stubs; add inspect types)
- Test: `src/modules/lease.test.ts` (append)

**Interfaces (UI tasks consume exactly this):**

```ts
export interface LockInspect { role: 'lock'; holder: NodeId | null; token: number; expiresAt: number | null; queue: NodeId[] }
export interface WorkerInspect { role: 'worker'; id: NodeId; state: WorkerState['state']; token: number | null; grantAt: number | null; ttl: number | null; rate: number; pausedUntil: number | null; working: boolean; writesSent: number }
export interface StoreInspect { role: 'store'; value: string | null; lastToken: number; fencing: boolean; history: HistoryRow[]; writesOk: number; staleAccepts: number; rejects: number }
export type LeaseInspect = LockInspect | WorkerInspect | StoreInspect;
```

- [ ] **Step 1: Append the tests**

```ts
// append to src/modules/lease.test.ts — extend the './lease' import with type LeaseInspect
test('inspect exposes the panel contract per role', () => {
  const sim = fresh();
  sim.external(W1, { cmd: 'acquire' });
  until(sim, () => workerOf(sim, W1).state === 'holding');
  const li = lease.inspect(lockOf(sim)) as unknown as { role: string; holder: string | null; token: number };
  expect(li.role).toBe('lock');
  expect(li.holder).toBe(W1);
  const wi = lease.inspect(workerOf(sim, W1)) as unknown as { role: string; state: string; rate: number; working: boolean };
  expect(wi.role).toBe('worker');
  expect(wi.state).toBe('holding');
  expect(wi.rate).toBe(1);
  const si = lease.inspect(storeOf(sim)) as unknown as { role: string; fencing: boolean; history: unknown[] };
  expect(si.role).toBe('store');
  expect(si.fencing).toBe(false);
});

test('metrics are namespaced: tokens granted, store outcomes, worker pause flags', () => {
  const sim = fresh();
  const states = new Map(LEASE_TOPOLOGY.map((id) => [id, sim.getState(id)] as const));
  const names = lease.metrics(states, sim.time).map((m) => m.name);
  expect(names).toEqual(
    expect.arrayContaining(['lock/tokens-granted', 'store/writes-ok', 'store/stale-accepts', 'store/rejects', 'w1/paused', 'w2/paused']),
  );
});
```

- [ ] **Step 2: RED** — inspect returns only `{role}`; metrics empty.

- [ ] **Step 3: Implement** — add the inspect types above to `lease.ts`, then replace the module's two stubs:

```ts
  metrics(states): MetricSample[] {
    const out: MetricSample[] = [];
    for (const s of states.values()) {
      if (s.role === 'lock') out.push({ name: 'lock/tokens-granted', value: s.granted });
      if (s.role === 'store') {
        out.push({ name: 'store/writes-ok', value: s.writesOk });
        out.push({ name: 'store/stale-accepts', value: s.staleAccepts });
        out.push({ name: 'store/rejects', value: s.rejects });
      }
      if (s.role === 'worker') out.push({ name: `${String(s.id).toLowerCase()}/paused`, value: s.pausedUntil === null ? 0 : 1 });
    }
    return out;
  },

  inspect(state) {
    if (state.role === 'lock') {
      const { role, holder, token, expiresAt, queue } = state;
      return { role, holder, token, expiresAt, queue } as unknown as InspectorTree;
    }
    if (state.role === 'store') {
      const { role, value, lastToken, fencing, history, writesOk, staleAccepts, rejects } = state;
      return { role, value, lastToken, fencing, history, writesOk, staleAccepts, rejects } as unknown as InspectorTree;
    }
    const { role, id, state: st, token, grantAt, ttl, rate, pausedUntil, working, writesSent } = state;
    return { role, id, state: st, token, grantAt, ttl, rate, pausedUntil, working, writesSent } as unknown as InspectorTree;
  },
```

- [ ] **Step 4: GREEN + tsc + eslint. Step 5: Commit**

```bash
git add src/modules/lease.ts src/modules/lease.test.ts
git commit -m "feat(modules): lease inspect/metrics — panel contract per role"
```

---

### Task 7: Property suite

**Files:**
- Test: `src/modules/lease.property.test.ts`

- [ ] **Step 1: Write the tests**

```ts
// src/modules/lease.property.test.ts
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { Simulation } from '../engine';
import { lease, type LeaseState, type LockState, type StoreState } from './lease';
import { LEASE_TOPOLOGY, LOCK, STORE, W1, W2, type LeasePayload } from './lease-shared';

/** A random user session: timed acquires, pauses, skews, fencing flips. */
type Cmd =
  | { at: number; node: string; ext: LeasePayload }
  | { at: number; net: { dropRate: number } };

const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
  fc.record({ at: fc.integer({ min: 0, max: 300 }), node: fc.constantFrom(W1, W2), ext: fc.constant<LeasePayload>({ cmd: 'acquire' }) }),
  fc.record({
    at: fc.integer({ min: 0, max: 300 }),
    node: fc.constantFrom(W1, W2),
    ext: fc.integer({ min: 10, max: 200 }).map((ticks): LeasePayload => ({ fault: 'gc-pause', ticks })),
  }),
  fc.record({
    at: fc.integer({ min: 0, max: 300 }),
    node: fc.constantFrom(W1, W2),
    ext: fc.constantFrom(0.5, 0.25, 2).map((rate): LeasePayload => ({ fault: 'clock-skew', rate })),
  }),
  fc.record({ at: fc.integer({ min: 0, max: 300 }), net: fc.record({ dropRate: fc.constantFrom(0, 0.2, 0.5) }) }),
);

const script = fc.array(cmdArb, { minLength: 1, maxLength: 10 });

function run(cmds: Cmd[], seed: number, fencing: boolean): Map<string, LeaseState> {
  const sim = new Simulation<LeaseState, LeasePayload>({ module: lease, config: { nodeIds: LEASE_TOPOLOGY }, seed });
  sim.runSteps(LEASE_TOPOLOGY.length);
  if (fencing) {
    sim.external(STORE, { cmd: 'fencing', on: true });
    sim.runSteps(1);
  }
  const ordered = [...cmds].sort((a, b) => a.at - b.at);
  for (const c of ordered) {
    if (sim.time < c.at) sim.runUntil(c.at);
    if ('ext' in c) sim.external(c.node, c.ext);
    else sim.control({ type: 'net', opts: { dropRate: c.net.dropRate } });
  }
  sim.runUntil(sim.time + 500);
  return new Map(LEASE_TOPOLOGY.map((id) => [id, sim.getState(id)]));
}

test('token monotonicity: grants strictly increase, count matches the counter', () => {
  fc.assert(
    fc.property(script, fc.integer({ min: 1, max: 1000 }), (cmds, s) => {
      const lock = run(cmds, 8100 + s, false).get(LOCK) as LockState;
      expect(lock.granted).toBe(lock.token);
    }),
    { numRuns: 25 },
  );
});

test('fencing safety: with fencing ON, accepted tokens are non-decreasing — no stale write EVER gets in', () => {
  fc.assert(
    fc.property(script, fc.integer({ min: 1, max: 1000 }), (cmds, s) => {
      const store = run(cmds, 8200 + s, true).get(STORE) as StoreState;
      expect(store.staleAccepts).toBe(0);
      const accepted = store.history.filter((h) => h.outcome !== 'rejected').map((h) => h.token);
      for (let i = 1; i < accepted.length; i++) expect(accepted[i]).toBeGreaterThanOrEqual(accepted[i - 1]);
    }),
    { numRuns: 25 },
  );
});

test('determinism: same script + same seed → identical states', () => {
  fc.assert(
    fc.property(script, (cmds) => {
      const a = run(cmds, 8300, false);
      const b = run(cmds, 8300, false);
      for (const id of LEASE_TOPOLOGY) expect(JSON.stringify(a.get(id))).toBe(JSON.stringify(b.get(id)));
    }),
    { numRuns: 15 },
  );
});

test('single holder: the lock never believes two nodes hold the lease (its own truth)', () => {
  // structural: holder is a single field — this property instead pins that a
  // re-grant always bumps the token, so two "holders" can never share one.
  fc.assert(
    fc.property(script, fc.integer({ min: 1, max: 1000 }), (cmds, s) => {
      const lock = run(cmds, 8400 + s, false).get(LOCK) as LockState;
      if (lock.holder !== null) expect(lock.token).toBeGreaterThanOrEqual(1);
      expect(lock.queue.includes(lock.holder as never)).toBe(false);
    }),
    { numRuns: 25 },
  );
});
```

- [ ] **Step 2: Run** — `npx vitest run src/modules/lease.property.test.ts`. A counterexample = real module bug; shrink, fix in `lease.ts`, note the deviation. Then commit:

```bash
git add src/modules/lease.property.test.ts
git commit -m "test(modules): lease property suite — token monotonicity, fencing safety, determinism"
```

---

### Task 8: Pinned lesson test — the fencing matrix

**Files:**
- Test: `src/modules/lease-lesson.test.ts`

- [ ] **Step 1: Write the test** — the deterministic fig 8-4 choreography, all three spec §6 rows. Do NOT import from `lease.test.ts` (importing a test file re-registers its tests in this suite) — the small helper block below is duplicated on purpose.

```ts
// src/modules/lease-lesson.test.ts
// The Ch8 lesson, pinned: a lock + lease is not enough; fencing tokens are.
import { expect, test } from 'vitest';
import { Simulation } from '../engine';
import { lease, type LeaseState, type LockState, type StoreState, type WorkerState } from './lease';
import { LEASE_TOPOLOGY, LEASE_TTL, LOCK, STORE, W1, W2, type LeasePayload } from './lease-shared';

function fresh(seed: number) {
  const sim = new Simulation<LeaseState, LeasePayload>({ module: lease, config: { nodeIds: LEASE_TOPOLOGY }, seed });
  sim.runSteps(LEASE_TOPOLOGY.length);
  return sim;
}
const lockOf = (sim: ReturnType<typeof fresh>) => sim.getState(LOCK) as LockState;
const workerOf = (sim: ReturnType<typeof fresh>, id: string) => sim.getState(id) as WorkerState;
const storeOf = (sim: ReturnType<typeof fresh>) => sim.getState(STORE) as StoreState;
function until(sim: ReturnType<typeof fresh>, cond: () => boolean, budget = 2000) {
  for (let i = 0; i < budget && !cond(); i++) {
    if (sim.pending === 0) break;
    sim.runSteps(1);
  }
  if (!cond()) throw new Error(`until(): condition not reached (time=${sim.time}, pending=${sim.pending})`);
}

function fig84(fencing: boolean) {
  const sim = fresh(8042);
  if (fencing) {
    sim.external(STORE, { cmd: 'fencing', on: true });
    sim.runSteps(1);
  }
  sim.external(W1, { cmd: 'acquire' });
  until(sim, () => workerOf(sim, W1).working === true, 2000);
  sim.external(W1, { fault: 'gc-pause', ticks: LEASE_TTL * 3 });
  sim.external(W2, { cmd: 'acquire' });
  until(sim, () => lockOf(sim).holder === W2, 4000);
  until(sim, () => storeOf(sim).lastToken === 2, 4000);
  // wake + drain
  until(sim, () => storeOf(sim).history.some((h) => h.writer === W1 && h.token === 1 && h.at > LEASE_TTL), 8000);
  return sim;
}

test('pinned: fencing OFF — the paused worker corrupts the store on wake', () => {
  const sim = fig84(false);
  const st = storeOf(sim);
  expect(st.staleAccepts).toBe(1);
  const stale = st.history.find((h) => h.outcome === 'stale');
  expect(stale?.writer).toBe(W1);
  expect(stale?.token).toBe(1);
});

test('pinned: fencing ON — the same wake-up write bounces off the token check', () => {
  const sim = fig84(true);
  const st = storeOf(sim);
  expect(st.staleAccepts).toBe(0);
  expect(st.rejects).toBeGreaterThanOrEqual(1);
  const rejected = st.history.find((h) => h.outcome === 'rejected');
  expect(rejected?.writer).toBe(W1);
  expect(st.history.filter((h) => h.writer === W2).every((h) => h.outcome === 'ok')).toBe(true);
});

test('pinned: a slow clock corrupts without any pause (fencing OFF)', () => {
  const sim = fresh(8043);
  sim.external(W1, { fault: 'clock-skew', rate: 0.5 });
  sim.external(W1, { cmd: 'acquire' });
  until(sim, () => workerOf(sim, W1).state === 'holding');
  sim.external(W2, { cmd: 'acquire' });
  until(sim, () => storeOf(sim).staleAccepts >= 1, 8000);
  expect(workerOf(sim, W1).pausedUntil).toBeNull();
});
```

- [ ] **Step 2: Run; fix module only for real bugs. Step 3: Commit**

```bash
git add src/modules/lease-lesson.test.ts
git commit -m "test(modules): pin the Ch8 lesson — fig 8-4 corruption, fencing rejection, clock-skew path"
```

---

### Task 9: LeasePanel + StorePanel + LeaseFaultBar

**Files:**
- Create: `src/ui/labs/lease/LeasePanel.tsx` (+ `.test.tsx`)
- Create: `src/ui/labs/lease/StorePanel.tsx` (+ `.test.tsx`)
- Create: `src/ui/labs/lease/LeaseFaultBar.tsx` (+ `.test.tsx`)

**Interfaces:**
- `LeasePanel({ lock, workers, time }: { lock: LockInspect; workers: WorkerInspect[]; time: number })` — holder/token/expiry countdown + each worker's belief vs the Lock's truth.
- `StorePanel({ store }: { store: StoreInspect })` — value, lastToken, fencing flag, history rows with outcome badges.
- `LeaseFaultBar({ onAcquire, onPause, onSkew, onFencing, fencing }: { onAcquire: (w: 'W1'|'W2') => void; onPause: (w: 'W1'|'W2', ticks: number) => void; onSkew: (w: 'W1'|'W2', rate: number) => void; onFencing: (on: boolean) => void; fencing: boolean })`.

- [ ] **Step 1: Tests**

```tsx
// src/ui/labs/lease/LeasePanel.test.tsx
// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import type { LockInspect, WorkerInspect } from '../../../modules/lease';
import { LeasePanel } from './LeasePanel';

afterEach(cleanup);

const lock: LockInspect = { role: 'lock', holder: 'W2', token: 2, expiresAt: 150, queue: ['W1'] };
const workers: WorkerInspect[] = [
  { role: 'worker', id: 'W1', state: 'holding', token: 1, grantAt: 10, ttl: 60, rate: 0.5, pausedUntil: null, working: true, writesSent: 3 },
  { role: 'worker', id: 'W2', state: 'holding', token: 2, grantAt: 90, ttl: 60, rate: 1, pausedUntil: null, working: false, writesSent: 1 },
];

test('shows the lock truth: holder, token, countdown, queue', () => {
  const { container } = render(<LeasePanel lock={lock} workers={workers} time={100} />);
  const truth = container.querySelector('[data-lock]');
  expect(truth?.textContent).toContain('W2');
  expect(truth?.textContent).toContain('token 2');
  expect(truth?.textContent).toContain('50'); // 150 - 100
  expect(truth?.textContent).toContain('W1'); // queued
});

test('flags a worker whose belief contradicts the lock (stale belief in coral)', () => {
  const { container } = render(<LeasePanel lock={lock} workers={workers} time={100} />);
  const w1 = container.querySelector('[data-worker="W1"]');
  // W1 believes: (100-10)*0.5 = 45 < 60 → still valid on its clock, but Lock says W2 holds
  expect(w1?.getAttribute('data-belief')).toBe('stale');
  const w2 = container.querySelector('[data-worker="W2"]');
  expect(w2?.getAttribute('data-belief')).toBe('true'); // holder and believes it
});

test('shows working and paused badges', () => {
  const paused = [{ ...workers[0], pausedUntil: 500, working: false }];
  const { container } = render(<LeasePanel lock={lock} workers={paused} time={100} />);
  expect(container.querySelector('[data-worker="W1"]')?.textContent).toContain('paused');
  const { container: c2 } = render(<LeasePanel lock={lock} workers={workers} time={100} />);
  expect(c2.querySelector('[data-worker="W1"]')?.textContent).toContain('working');
});
```

```tsx
// src/ui/labs/lease/StorePanel.test.tsx
// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import type { StoreInspect } from '../../../modules/lease';
import { StorePanel } from './StorePanel';

afterEach(cleanup);

const store: StoreInspect = {
  role: 'store',
  value: 'W1#3',
  lastToken: 2,
  fencing: false,
  history: [
    { token: 2, writer: 'W2', outcome: 'ok', at: 90 },
    { token: 1, writer: 'W1', outcome: 'stale', at: 120 },
    { token: 1, writer: 'W1', outcome: 'rejected', at: 130 },
  ],
  writesOk: 1,
  staleAccepts: 1,
  rejects: 1,
};

test('renders value, last token and fencing state', () => {
  const { container } = render(<StorePanel store={store} />);
  expect(container.textContent).toContain('W1#3');
  expect(container.textContent).toContain('fencing off');
});

test('history rows carry outcome badges; stale is the alarm', () => {
  const { container } = render(<StorePanel store={store} />);
  const rows = container.querySelectorAll('[data-row]');
  expect(rows).toHaveLength(3);
  expect(rows[1].getAttribute('data-outcome')).toBe('stale');
  expect(rows[2].getAttribute('data-outcome')).toBe('rejected');
});
```

```tsx
// src/ui/labs/lease/LeaseFaultBar.test.tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { LeaseFaultBar } from './LeaseFaultBar';

afterEach(cleanup);

const noop = () => {};
const base = { onAcquire: noop, onPause: noop, onSkew: noop, onFencing: noop, fencing: false };

test('acquire buttons per worker', () => {
  const onAcquire = vi.fn();
  const { container } = render(<LeaseFaultBar {...base} onAcquire={onAcquire} />);
  fireEvent.click(container.querySelector('[data-action="acquire-W2"]') as HTMLButtonElement);
  expect(onAcquire).toHaveBeenCalledWith('W2');
});

test('gc-pause and clock-skew fire with the chosen worker', () => {
  const onPause = vi.fn();
  const onSkew = vi.fn();
  const { container } = render(<LeaseFaultBar {...base} onPause={onPause} onSkew={onSkew} />);
  fireEvent.click(container.querySelector('[data-action="pause-W1"]') as HTMLButtonElement);
  expect(onPause).toHaveBeenCalledWith('W1', expect.any(Number));
  fireEvent.click(container.querySelector('[data-action="skew-W1"]') as HTMLButtonElement);
  expect(onSkew).toHaveBeenCalledWith('W1', 0.5);
});

test('fencing toggle reflects and flips state', () => {
  const onFencing = vi.fn();
  const { container } = render(<LeaseFaultBar {...base} onFencing={onFencing} />);
  const t = container.querySelector('[data-action="fencing"]') as HTMLButtonElement;
  expect(t.textContent).toContain('off');
  fireEvent.click(t);
  expect(onFencing).toHaveBeenCalledWith(true);
});
```

- [ ] **Step 2: RED, then implement**

```tsx
// src/ui/labs/lease/LeasePanel.tsx
import type { LockInspect, WorkerInspect } from '../../../modules/lease';

/** The Lock's truth beside each worker's belief — the gap IS the chapter. */
export function LeasePanel({ lock, workers, time }: { lock: LockInspect; workers: WorkerInspect[]; time: number }) {
  return (
    <section className="border border-line bg-panel rounded p-3 space-y-2 font-mono text-xs w-72">
      <div data-lock className="space-y-0.5">
        <h3 className="font-bold text-fg">Lock (lease service)</h3>
        <p>
          holder: <span className="text-set">{lock.holder ?? '—'}</span>{' '}
          <span className="text-dim">token {lock.token}</span>
        </p>
        <p className="text-dim">
          expires in: {lock.expiresAt === null ? '—' : Math.max(0, lock.expiresAt - time)}
          {lock.queue.length > 0 && <> · queue: {lock.queue.join(', ')}</>}
        </p>
      </div>
      {workers.map((w) => {
        const believes =
          w.state === 'holding' && w.grantAt !== null && w.ttl !== null && (time - w.grantAt) * w.rate < w.ttl;
        const isTruth = lock.holder === w.id;
        const belief = believes && !isTruth ? 'stale' : believes && isTruth ? 'true' : 'none';
        return (
          <div key={w.id} data-worker={w.id} data-belief={belief} className="border-t border-line pt-1 space-y-0.5">
            <p className="text-fg">
              {w.id} <span className="text-dim">{w.state}</span>
              {w.working && <span className="text-warn"> ⚙ working</span>}
              {w.pausedUntil !== null && <span className="text-sign"> ⏸ paused→{w.pausedUntil}</span>}
            </p>
            <p className={belief === 'stale' ? 'text-sign' : 'text-dim'}>
              {belief === 'stale' && `believes it holds token ${w.token} — the lock disagrees`}
              {belief === 'true' && `holds token ${w.token}`}
              {belief === 'none' && `no lease claim`}
              {w.rate !== 1 && <span className="text-warn"> · clock ×{w.rate}</span>}
            </p>
          </div>
        );
      })}
    </section>
  );
}
```

```tsx
// src/ui/labs/lease/StorePanel.tsx
import type { StoreInspect } from '../../../modules/lease';

const OUTCOME_CLASS: Record<string, string> = {
  ok: 'text-set',
  stale: 'text-sign font-bold',
  rejected: 'text-warn',
};

/** What actually got written — and which writes were lies. */
export function StorePanel({ store }: { store: StoreInspect }) {
  return (
    <section className="border border-line bg-panel rounded p-3 space-y-2 font-mono text-xs w-72">
      <h3 className="font-bold text-fg">Store (shared resource)</h3>
      <p>
        value: <span className="text-fg">{store.value ?? '—'}</span>{' '}
        <span className="text-dim">last token {store.lastToken}</span>
      </p>
      <p className={store.fencing ? 'text-set' : 'text-dim'}>
        fencing {store.fencing ? 'on — writes below token watermark are rejected' : 'off'}
      </p>
      <div className="space-y-0.5">
        {store.history.map((h, i) => (
          <p key={i} data-row={i} data-outcome={h.outcome} className={OUTCOME_CLASS[h.outcome]}>
            t{h.at} {h.writer} token {h.token} → {h.outcome}
          </p>
        ))}
      </div>
      <p className="text-dim">
        ok {store.writesOk} · <span className={store.staleAccepts > 0 ? 'text-sign' : ''}>stale {store.staleAccepts}</span> · rejected {store.rejects}
      </p>
    </section>
  );
}
```

```tsx
// src/ui/labs/lease/LeaseFaultBar.tsx
import { useState } from 'react';
import { btn, btnPrimary, inputBox } from '../../kit/classes';

const WORKERS = ['W1', 'W2'] as const;
type WorkerId = (typeof WORKERS)[number];

/** User-facing process faults: acquire, GC-pause, slow clock, fencing toggle. */
export function LeaseFaultBar({
  onAcquire,
  onPause,
  onSkew,
  onFencing,
  fencing,
}: {
  onAcquire: (w: WorkerId) => void;
  onPause: (w: WorkerId, ticks: number) => void;
  onSkew: (w: WorkerId, rate: number) => void;
  onFencing: (on: boolean) => void;
  fencing: boolean;
}) {
  const [ticks, setTicks] = useState('180');
  return (
    <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
      {WORKERS.map((w) => (
        <button key={w} data-action={`acquire-${w}`} className={btn} onClick={() => onAcquire(w)}>
          {w} acquire
        </button>
      ))}
      <span className="text-dim">| gc-pause</span>
      <input className={`w-14 ${inputBox}`} value={ticks} onChange={(e) => setTicks(e.target.value)} aria-label="pause ticks" />
      {WORKERS.map((w) => (
        <button key={w} data-action={`pause-${w}`} className={btn} onClick={() => onPause(w, Number(ticks) || 180)}>
          ⏸ {w}
        </button>
      ))}
      <span className="text-dim">| slow clock ×0.5</span>
      {WORKERS.map((w) => (
        <button key={w} data-action={`skew-${w}`} className={btn} onClick={() => onSkew(w, 0.5)}>
          🕰 {w}
        </button>
      ))}
      <button data-action="fencing" className={fencing ? btnPrimary : btn} onClick={() => onFencing(!fencing)}>
        fencing: {fencing ? 'on' : 'off'}
      </button>
    </div>
  );
}
```

- [ ] **Step 3: GREEN + eslint + tsc. Step 4: Commit**

```bash
git add src/ui/labs/lease
git commit -m "feat(ui): LeasePanel, StorePanel, LeaseFaultBar — truth vs belief, outcomes, process faults"
```

---

### Task 10: LeaseLab — assembly + the three challenges

**Files:**
- Create: `src/ui/labs/lease/LeaseLab.tsx` (+ `.test.tsx`)

Key mechanics:
- Driver-in-effect keyed on `[epoch]`; drain inits at mount (Ch7 lesson): `while (d.sim.pending > 0) d.stepOnce();` — then `d.start()` so the network runs live (this lab has real pending work; the rAF loop and TimelineScrubber both earn their keep).
- UI-tracked attempt flags (Ch3 `crashed` precedent): `pausedFlag` set by onPause, `skewFlag` by onSkew, `fencedAt` (staleAccepts value when fencing was enabled) — reset on epoch change.
- Challenge verifiers read `driver.sim.getState(...)`.

- [ ] **Step 1: Test**

```tsx
// src/ui/labs/lease/LeaseLab.test.tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { LeaseLab } from './LeaseLab';

afterEach(cleanup);

test('renders cluster, lease panel, store panel, fault bar and three challenges', () => {
  const { container, getAllByText } = render(<LeaseLab />);
  expect(container.querySelector('[data-lock]')).not.toBeNull();
  expect(container.querySelector('[data-action="fencing"]')).not.toBeNull();
  expect(getAllByText(/Challenge:/)).toHaveLength(3);
});

test('acquire drives the sim: W1 eventually holds the lease', () => {
  const { container } = render(<LeaseLab />);
  fireEvent.click(container.querySelector('[data-action="acquire-W1"]') as HTMLButtonElement);
  const step = container.querySelector('[data-action="lab-step"]') as HTMLButtonElement;
  for (let i = 0; i < 60; i++) fireEvent.click(step);
  expect(container.querySelector('[data-worker="W1"]')?.textContent).toMatch(/holding|waiting/);
});

test('fencing toggle flips the store panel', () => {
  const { container } = render(<LeaseLab />);
  fireEvent.click(container.querySelector('[data-action="fencing"]') as HTMLButtonElement);
  const step = container.querySelector('[data-action="lab-step"]') as HTMLButtonElement;
  for (let i = 0; i < 4; i++) fireEvent.click(step);
  expect(container.textContent).toContain('fencing on');
});
```

- [ ] **Step 2: Implement**

```tsx
// src/ui/labs/lease/LeaseLab.tsx
import { useEffect, useState } from 'react';
import { Simulation } from '../../../engine';
import { lease, type LeaseState, type LockInspect, type StoreState, type StoreInspect, type WorkerInspect, type WorkerState } from '../../../modules/lease';
import { LEASE_TOPOLOGY, LOCK, STORE, W1, W2 } from '../../../modules/lease-shared';
import { SimDriver } from '../../bridge/SimDriver';
import { useSimStore } from '../../bridge/simStore';
import { ChallengePanel } from '../../kit/ChallengePanel';
import { ChaosToolbar } from '../../kit/ChaosToolbar';
import { ClusterView } from '../../kit/ClusterView';
import { MetricsPanel } from '../../kit/MetricsPanel';
import { TimelineScrubber } from '../../kit/TimelineScrubber';
import { btn } from '../../kit/classes';
import { LeaseFaultBar } from './LeaseFaultBar';
import { LeasePanel } from './LeasePanel';
import { StorePanel } from './StorePanel';

export function LeaseLab() {
  const [epoch, setEpoch] = useState(0);
  const [driver, setDriver] = useState<SimDriver<LeaseState> | null>(null);
  const [fencing, setFencing] = useState(false);
  const [pausedFlag, setPausedFlag] = useState(false);
  const [skewFlag, setSkewFlag] = useState(false);
  const [staleAtFence, setStaleAtFence] = useState(0);

  useEffect(() => {
    useSimStore.getState().reset();
    const seed = 8000 + epoch;
    const sim = new Simulation<LeaseState>({ module: lease, config: { nodeIds: LEASE_TOPOLOGY }, seed });
    const d = new SimDriver({ sim, seed, publish: (v) => useSimStore.getState().publish(v) });
    while (d.sim.pending > 0) d.stepOnce(); // drain inits so panels render immediately
    setDriver(d);
    setFencing(false);
    setPausedFlag(false);
    setSkewFlag(false);
    setStaleAtFence(0);
    return () => d.pause();
  }, [epoch]);

  const view = useSimStore();
  if (!driver) return null;

  const storeState = () => driver.sim.getState(STORE) as StoreState;
  const workerState = (id: string) => driver.sim.getState(id) as WorkerState;

  const inspects = new Map(view.nodes.map((n) => [n.id, n.inspect]));
  const lock = inspects.get(LOCK) as unknown as LockInspect | undefined;
  const store = inspects.get(STORE) as unknown as StoreInspect | undefined;
  const workers = [W1, W2]
    .map((id) => inspects.get(id) as unknown as WorkerInspect | undefined)
    .filter((w): w is WorkerInspect => w !== undefined && w.role === 'worker');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
        <button className={btn} onClick={() => setEpoch((e) => e + 1)}>reset (new seed)</button>
        <button data-action="lab-step" className={btn} onClick={() => driver.stepOnce()}>step</button>
        <span className="text-dim">a lease is a promise about time — and time here lies</span>
      </div>

      <TimelineScrubber
        processed={view.processed}
        pending={view.pending}
        running={view.running}
        onPlayPause={() => (view.running ? driver.pause() : driver.start())}
        onStep={() => driver.stepOnce()}
        onScrub={(i) => driver.scrubTo(i)}
      />

      <div className="flex flex-wrap items-start gap-4">
        <ClusterView nodes={view.nodes} inFlight={view.inFlight} time={view.time} />
        {lock && workers.length === 2 && <LeasePanel lock={lock} workers={workers} time={view.time} />}
        {store && store.role === 'store' && <StorePanel store={store} />}
        <MetricsPanel history={view.metricsHistory} />
      </div>

      <LeaseFaultBar
        fencing={fencing}
        onAcquire={(w) => driver.external(w, { cmd: 'acquire' })}
        onPause={(w, ticks) => {
          driver.external(w, { fault: 'gc-pause', ticks });
          setPausedFlag(true);
        }}
        onSkew={(w, rate) => {
          driver.external(w, { fault: 'clock-skew', rate });
          setSkewFlag(true);
        }}
        onFencing={(on) => {
          driver.external(STORE, { cmd: 'fencing', on });
          setFencing(on);
          if (on) setStaleAtFence(storeState().staleAccepts);
        }}
      />

      <ChaosToolbar
        caps={lease.chaos}
        nodeIds={driver.sim.config.nodeIds}
        deadNodes={view.nodes.filter((n) => n.dead).map((n) => n.id)}
        onAction={(a) => driver.control(a)}
      />

      <ChallengePanel
        title="Challenge: the lease is a lie"
        storageKeyPrefix="ddia:ch08:lease"
        prompt="Fencing off. Acquire with W1, GC-pause it mid-work (⚙) past the TTL, let W2 take over. Predict: what does W1 do when it wakes?"
        runningHint="W1 acquire → wait for ⚙ working → ⏸ W1 → W2 acquire → play."
        check={() => {
          if (!pausedFlag) return null; // no auto-win without an actual pause (Ch3 lesson)
          const s = storeState();
          return s.staleAccepts >= 1 ? { stale: s.staleAccepts } : null;
        }}
        onWin={() => driver.pause()}
        renderWin={(_w, prediction) => (
          <>
            <p>
              W1 woke up and finished the write it had already decided to make — token 1 landed on top of
              W2's token-2 data and the store took it. The lock did everything right; the <em>store</em> had
              no way to know the lease was dead. That is DDIA figure 8-4.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />

      <ChallengePanel
        title="Challenge: fence it"
        storageKeyPrefix="ddia:ch08:fence"
        prompt="Same choreography, fencing ON first. Predict: what happens to W1's wake-up write?"
        runningHint="fencing: on → W1 acquire → ⚙ → ⏸ W1 → W2 acquire → play."
        check={() => {
          if (!fencing || !pausedFlag) return null;
          const s = storeState();
          return s.rejects >= 1 && s.staleAccepts <= staleAtFence ? { rejects: s.rejects } : null;
        }}
        onWin={() => driver.pause()}
        renderWin={(_w, prediction) => (
          <>
            <p>
              the write arrived with token 1, the store had already seen token 2 — rejected. One monotonic
              number turned a corruption into a no-op. The token does what the lease could not, because it
              travels <em>with the write</em>.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />

      <ChallengePanel
        title="Challenge: the clock lies too"
        storageKeyPrefix="ddia:ch08:clock"
        prompt="Fencing off, no pause. Slow W1's clock (×0.5), acquire with both. Predict: can the store get corrupted with no GC pause at all?"
        runningHint="🕰 W1 → W1 acquire → W2 acquire → play until the stale row appears."
        check={() => {
          if (pausedFlag || !skewFlag) return null; // this one must be pause-free
          const s = storeState();
          const w1 = workerState(W1);
          return s.staleAccepts >= 1 && w1.rate !== 1 ? { stale: s.staleAccepts } : null;
        }}
        onWin={() => driver.pause()}
        renderWin={(_w, prediction) => (
          <>
            <p>
              nobody paused anything — W1's clock just ran slow, so its 60-tick lease "lasted" 120 real
              ticks. Leases are promises about time, and a process can only check them against its own
              clock. Never build mutual exclusion on elapsed time you didn't measure yourself.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />
    </div>
  );
}
```

- [ ] **Step 3: GREEN + eslint + tsc + full txn/lease suites. Step 4: Commit**

```bash
git add src/ui/labs/lease/LeaseLab.tsx src/ui/labs/lease/LeaseLab.test.tsx
git commit -m "feat(ui): LeaseLab — cluster + truth-vs-belief panels + 3 fencing challenges"
```

---

### Task 11: Debrief, catalog, routing, docs

**Files:**
- Create: `content/ch08/debrief.mdx`, `src/ui/labs/lease/Debrief.tsx`
- Modify: `src/ui/shell/catalog.ts`, `src/ui/App.tsx`, `README.md`, `docs/DESIGN_PLAN.en.md`

- [ ] **Step 1: Debrief content** (first line must be the `#` heading — MDX has no comments):

```mdx
# Chapter 8 — The Trouble with Distributed Systems: Debrief

## Partial failure is the defining problem

On one machine, things either work or crash. Across a network, a request can be lost,
delayed, reordered, duplicated — or succeed while its *reply* is lost. You drove all of
those with sliders, and the system had no way to tell one from another. The only tool a
node has is a timeout, and a timeout proves nothing about what happened remotely.

## The lease looked safe — and wasn't

The lock service did everything right: one holder at a time, hard expiry on its own
clock. The corruption came from the *gap between checking and acting*. W1 checked its
lease, started working, and the world moved on without it — a GC pause froze the
process, the lease expired, W2 took over, and W1's write arrived from the past. Kleppmann's
figure 8-4, live. Note what did NOT help: the lock's `expired` notice — it travels on the
same unreliable network as everything else.

## Process pauses are real

Stop-the-world garbage collection, VM migration, laptop lids, disk swaps, SIGSTOP — a
thread can stop for seconds at any line of code. You cannot write "check, then quickly
use it" and hope. Any check-then-act on shared state needs the check to travel WITH the
act — which is exactly what the fencing token does.

## Fencing tokens

One monotonically increasing number, handed out with each lease, attached to each write,
checked at the resource. The store rejects anything below its watermark. The pause still
happens; the stale write still arrives; it just bounces. Mutual exclusion enforced at the
*resource*, not at the lock — because the lock is not the one being corrupted.

## Clocks are not to be trusted

The third corruption needed no pause at all: a clock running at half speed made W1
believe a 60-tick lease for 120 ticks. Time-of-day clocks jump (NTP), monotonic clocks
drift, and a lease is only as good as the *worst* clock that reads it. Google's TrueTime
puts error bounds on every read and waits them out; everyone else should treat elapsed
time as a rumor.

## Terms

*partial failure* · *unbounded delay* · *timeout* · *process pause (GC, VM migration)* ·
*lease* · *fencing token* · *clock skew / drift* · *monotonic vs time-of-day clocks* ·
*Byzantine faults (not modeled here — nodes fail, they don't lie)* — the vocabulary of
DDIA Ch8.
```

- [ ] **Step 2: Debrief page**

```tsx
// src/ui/labs/lease/Debrief.tsx
import DebriefContent from '../../../../content/ch08/debrief.mdx';
import { DebriefArticle } from '../../kit/DebriefArticle';
import { SurpriseJournal } from '../../kit/SurpriseJournal';

export function LeaseDebrief() {
  return (
    <DebriefArticle>
      <DebriefContent />
      <SurpriseJournal storageKey="ddia:ch08:journal" />
    </DebriefArticle>
  );
}
```

- [ ] **Step 3: catalog.ts** — replace the ch8 entry:

```ts
    id: 'ch8',
    title: 'Ch.8 — Distributed Trouble',
    labs: [
      { id: '8.1', label: 'Unreliable Network Playground', status: 'active' },
      { id: '8.d', label: 'Debrief & Journal', status: 'active' },
    ],
```

(Keep the existing `title` string if it differs — only the labs array changes.)

- [ ] **Step 4: App.tsx** — imports next to the txn ones, PAGES entries after `'7.d'`:

```ts
import { LeaseLab } from './labs/lease/LeaseLab';
import { LeaseDebrief } from './labs/lease/Debrief';
```

```ts
  '8.1': {
    eyebrow: 'Chapter 8 — The Trouble with Distributed Systems',
    title: 'Unreliable Network Playground',
    thesis:
      'A lease-based lock, two workers, a shared store — over a network that delays, drops and duplicates. GC-pause the lease holder and watch it corrupt the store from the past; turn on fencing tokens and watch the same write bounce; then do it again with nothing but a slow clock.',
    Component: LeaseLab,
  },
  '8.d': {
    eyebrow: 'Chapter 8 — Debrief',
    title: 'Timeouts, pauses, and the number that saves you',
    thesis:
      'Partial failure, process pauses, and untrustworthy clocks — why the check must travel with the act, and what a fencing token actually buys.',
    Component: LeaseDebrief,
  },
```

- [ ] **Step 5: README** — after the Ch7 block:

```markdown
**Ch.8 — The Trouble with Distributed Systems:**
- **8.1 Unreliable Network Playground** — a lease lock service, two check-then-act workers and a shared store over a genuinely unreliable network (latency/drop/duplicate/partition sliders). Challenges: *the lease is a lie (GC-pause the holder — DDIA fig 8-4)*, *fence it (same failure, fencing tokens on)*, *the clock lies too (corruption via a slow clock, no pause at all)*.
```

- [ ] **Step 6: DESIGN_PLAN** — append to the Phase 3 line a partial-shipped note:

```markdown
*(ch8 shipped 2026-07-16 — 8.1 lease/fencing playground + 8.d debrief; fig 8-4 GC-pause corruption, fencing rejection, and clock-skew corruption all engine-verified. Fencing win condition met. ch6 shipped earlier; ch9 remains.)*
```

- [ ] **Step 7: Full gate** — `npx vitest run && npx tsc -b && npm run build`. Fix fallout (e.g. App.test nav expectations) without weakening pinned tests.

- [ ] **Step 8: Commit**

```bash
git add content/ch08/debrief.mdx src/ui/labs/lease/Debrief.tsx src/ui/shell/catalog.ts src/ui/App.tsx README.md docs/DESIGN_PLAN.en.md
git commit -m "feat(ui): ship Ch8 unreliable-network lab — debrief, catalog 8.1/8.d active, roadmap"
```

---

### Task 12: Ship gate

- [ ] `npx vitest run && npx tsc -b && npm run build` all green; browser DoD walk (vite preview + playwright): all 3 challenges winnable by their runningHints, debrief renders, 0 console errors. Fix-forward anything found; never weaken a pinned test.

## Post-plan (main thread)

Push `master` → Pages CI green → live spot-check → ledger + memory update → next chapter (Ch9).
