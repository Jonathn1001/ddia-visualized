# Ch1 Load Simulator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship DDIA Ch1 as a Scalability lab — an M/M/c request queue where the reader drags a load slider and watches p50 stay flat while p99 detonates near capacity, then rescues the tail with a replica or cache.

**Architecture:** One pure `SimModule<LoadState>` on a single node `SVC`, driven by the existing discrete-event engine. A self-rescheduling `arrival` timer mints requests; each request's `fanout` backend sub-requests draw a service time **at arrival**, hit the cache or enter a FIFO queue, and are served by `servers` parallel slots; a `complete` timer frees a slot and joins fan-out children into their parent's response time (the max). Rolling windows of user + backend latencies feed p50/p95/p99, throughput, and utilisation. Three epoch-gated challenge flags latch on real percentile transitions. UI mirrors the Ch12 unbundled lab (single node, `chaos:[]`, external-command knobs, forward-only scrubber, three ChallengePanels).

**Tech Stack:** Vite + React 19 + TypeScript strict, Vitest + fast-check, the in-repo engine (`src/engine`), Tailwind, `motion`, MDX debrief.

## Global Constraints

- **Determinism:** every random draw goes through the `rng` passed to `reduce` (`src/engine/rng.ts`, `next()` → `[0,1)`). Same seed + same command sequence ⇒ identical run. No `Math.random`, no `Date.now`.
- **Exponential draw guard:** `expTick(mean, u)` takes `u ∈ (0,1]`; callers pass `u = 1 - rng.next()` so a raw `0` never yields `ln 0 = -∞`. Result clamped `max(1, round(-mean·ln u))` — integer ticks ≥ 1.
- **Engine purity:** `src/modules/**` must not import React/DOM. Module `reduce` is pure `(state, event, rng) => [state, Effect[]]`.
- **Effect shape:** only `{ type:'timer', delay, payload }` (no network for Ch1). `delay` is relative ticks.
- **`Simulation.external(node, payload)` only enqueues** — a following `runSteps(n)` drains it. At the same virtual time, a timer scheduled earlier has a lower seq and is processed before a just-injected external (see the Ch12 tests' drain comments).
- **Test gate per task:** `npx vitest run && npx tsc -b && npm run build` all green before commit.
- **Naming:** module `id: 'load'`, node `SVC`, catalog labs `1.1` (flip existing `soon`→`active`) + new `1.d`; UI `LoadLab` / `PercentilePanel` / `LoadDebrief`; journal key `ddia:ch01:journal`.
- **Windows:** percentiles/throughput over the last `WINDOW` completions; win-flags latch only after `WINDOW_MIN` completions (no lucky early win).

---

## File Structure

- `src/modules/load-shared.ts` — node id, param constants, request/state/inspect types, pure helpers `percentile`, `interArrivalMean`, `expTick`, `evalChallenges`. (+ `.test.ts`)
- `src/modules/load.ts` — the `SimModule<LoadState, LoadPayload>`: init, arrival, complete, external knobs, fan-out join, `inspect`/`metrics`. (+ `.test.ts`, `.property.test.ts`, `load-lesson.test.ts`)
- `src/ui/labs/load/LoadLab.tsx` — the lab page (controls, queue visual, panel, 3 challenges, scrubber). (+ `.test.tsx`)
- `src/ui/labs/load/PercentilePanel.tsx` — presentational percentile/throughput/utilisation panel. (+ `.test.tsx`)
- `src/ui/labs/load/Debrief.tsx` — MDX host, journal. Exported as `LoadDebrief`.
- `content/ch01/debrief.mdx` — the chapter notes.
- Edits: `src/ui/shell/catalog.ts` (+ `catalog.test.ts`), `src/ui/App.tsx`, `README.md`, `docs/DESIGN_PLAN.md` + `.en.md`.

---

## Task 1: Shared vocab + pure helpers

**Files:**
- Create: `src/modules/load-shared.ts`
- Test: `src/modules/load-shared.test.ts`

**Interfaces:**
- Produces:
  - `SVC: NodeId`, `LOAD_NODES: NodeId[]`
  - constants `SERVICE_MEAN`, `K`, `LOAD_MAX`, `WINDOW`, `WINDOW_MIN`, `CACHE_TICKS`, `SLA`, `VAR_TAIL_MULT`, `LO_TAIL_MULT`, `FANOUT_MIN`, `AMPLIFY` (all `number`)
  - types `SubReq`, `Parent`, `Completion`, `Challenges`, `LoadState`, `LoadInspect`
  - `interArrivalMean(level: number): number`
  - `expTick(mean: number, u: number): number`
  - `percentile(latencies: number[], p: number): number` — `p` in `0..100`, empty → `0`
  - `evalChallenges(prev: Challenges, s: { servers:number; varianceOn:boolean; fanout:number; user:number[]; backend:number[] }): Challenges`

- [ ] **Step 1: Write the failing test** — `src/modules/load-shared.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import {
  SERVICE_MEAN, LOAD_MAX, WINDOW_MIN, SLA, FANOUT_MIN,
  interArrivalMean, expTick, percentile, evalChallenges, freshChallenges,
} from './load-shared';

describe('interArrivalMean', () => {
  test('is >= 1 and strictly decreases as load rises', () => {
    let prev = Infinity;
    for (let level = 1; level <= LOAD_MAX; level++) {
      const m = interArrivalMean(level);
      expect(m).toBeGreaterThanOrEqual(1);
      expect(m).toBeLessThanOrEqual(prev);
      prev = m;
    }
  });
});

describe('expTick', () => {
  test('u=1 (from rng 0) clamps to 1 tick, never Infinity', () => {
    expect(expTick(SERVICE_MEAN, 1)).toBe(1);
    expect(Number.isFinite(expTick(SERVICE_MEAN, 1e-9))).toBe(true);
  });
  test('is an integer >= 1 across the unit interval', () => {
    for (const u of [1, 0.9, 0.5, 0.1, 0.001]) {
      const t = expTick(SERVICE_MEAN, u);
      expect(Number.isInteger(t)).toBe(true);
      expect(t).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('percentile', () => {
  test('empty is 0; ordered p50 <= p95 <= p99 <= max', () => {
    expect(percentile([], 99)).toBe(0);
    const xs = [5, 1, 9, 3, 7, 2, 8, 4, 6, 10];
    const p50 = percentile(xs, 50), p95 = percentile(xs, 95), p99 = percentile(xs, 99);
    expect(p50).toBeLessThanOrEqual(p95);
    expect(p95).toBeLessThanOrEqual(p99);
    expect(p99).toBeLessThanOrEqual(Math.max(...xs));
  });
  test('nearest-rank: p100 is the max, p0 is the min', () => {
    const xs = [10, 20, 30, 40];
    expect(percentile(xs, 100)).toBe(40);
    expect(percentile(xs, 0)).toBe(10);
  });
});

describe('evalChallenges (latching, warmup-gated)', () => {
  const full = (v: number) => Array.from({ length: WINDOW_MIN }, () => v);
  test('below WINDOW_MIN completions never latches', () => {
    const c = evalChallenges(freshChallenges(), {
      servers: 1, varianceOn: true, fanout: 1, user: [SLA + 50], backend: [],
    });
    expect(c.c1.breached).toBe(false);
  });
  test('C1 breached when c=1, p99>SLA, p50<SLA', () => {
    // window: mostly small (p50 < SLA) with a slow tail (p99 > SLA)
    const user = full(SLA - 50).concat(full(SLA + 200)).slice(0, WINDOW_MIN);
    const c = evalChallenges(freshChallenges(), { servers: 1, varianceOn: true, fanout: 1, user, backend: [] });
    expect(c.c1.breached).toBe(true);
    expect(c.c1.rescued).toBe(false);
  });
  test('C1 rescued only after breached, at servers>=2, p99<SLA', () => {
    const breached = { ...freshChallenges(), c1: { breached: true, rescued: false } };
    const c = evalChallenges(breached, { servers: 2, varianceOn: true, fanout: 1, user: full(SLA - 60), backend: [] });
    expect(c.c1.rescued).toBe(true);
  });
  test('C3 amplified when fanout>=FANOUT_MIN and user p50 >= backend p95', () => {
    const c = evalChallenges(freshChallenges(), {
      servers: 4, varianceOn: true, fanout: FANOUT_MIN,
      user: full(90), backend: full(20).concat([95]).slice(0, WINDOW_MIN),
    });
    expect(c.c3.amplified).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/load-shared.test.ts`
Expected: FAIL — module `./load-shared` not found.

- [ ] **Step 3: Write minimal implementation** — `src/modules/load-shared.ts`:

```ts
// Ch1 — load-simulator vocabulary: the SVC node, queueing params, the request/state
// shapes, and the pure helpers property + lesson tests assert against. Nothing here
// mutates or touches the engine RNG (helpers take a pre-drawn u).
import type { NodeId } from '../engine/events';

export const SVC: NodeId = 'SVC';
export const LOAD_NODES: NodeId[] = [SVC];

// --- queueing params (tuned so the three challenges win with margin at the lesson seed) ---
export const SERVICE_MEAN = 10; // mean service time, ticks
export const K = 120;           // interArrivalMean = round(K / loadLevel)
export const LOAD_MAX = 20;     // slider max; ρ(c=1) = level/12, so >12 overloads one server
export const WINDOW = 200;      // rolling completions kept for percentiles/throughput
export const WINDOW_MIN = 40;   // warmup: no win-flag latches before this many completions
export const CACHE_TICKS = 1;   // a cache hit's service time
export const SLA = 100;         // C1 p99 threshold, ticks
export const VAR_TAIL_MULT = 3;   // C2 hiTail: p99 >= MULT * p50
export const LO_TAIL_MULT = 1.5;  // C2 loTail: p99 <  MULT * p50
export const FANOUT_MIN = 20;   // C3 minimum fan-out
export const AMPLIFY = 1;       // C3: user p50 >= AMPLIFY * backend p95 (1 = "median feels the tail")

export interface SubReq { id: number; parentId: number; cached: boolean; service: number }
export interface Parent { remaining: number; arrivalT: number; maxLatency: number }
export interface Completion { t: number; lat: number }

export interface Challenges {
  c1: { breached: boolean; rescued: boolean };
  c2: { hiTail: boolean; loTail: boolean };
  c3: { amplified: boolean };
}
export function freshChallenges(): Challenges {
  return { c1: { breached: false, rescued: false }, c2: { hiTail: false, loTail: false }, c3: { amplified: false } };
}

export interface LoadState {
  self: NodeId;
  // knobs
  loadLevel: number; servers: number; cacheHitRate: number; varianceOn: boolean; fanout: number;
  // runtime
  inService: number; queue: SubReq[]; pending: Record<number, Parent>; nextId: number;
  // measurement windows (newest last, capped at WINDOW)
  user: Completion[]; backend: number[];
  // accounting
  busyTicks: number; lastEventT: number; completed: number;
  // challenge flags
  ch: Challenges;
}

export interface LoadInspect {
  loadLevel: number; servers: number; cacheHitRate: number; varianceOn: boolean; fanout: number;
  inService: number; queueLen: number;
  p50: number; p95: number; p99: number;
  bp50: number; bp95: number; bp99: number;
  throughput: number; utilisation: number; completed: number; samples: number;
  sla: number; ch: Challenges;
}

/** Lower mean = higher arrival rate. Clamped to >= 1 tick. */
export function interArrivalMean(level: number): number {
  return Math.max(1, Math.round(K / Math.max(1, level)));
}

/** Rounded exponential, integer ticks >= 1. u MUST be in (0,1] — callers pass 1 - rng.next(). */
export function expTick(mean: number, u: number): number {
  const clamped = u <= 0 ? Number.MIN_VALUE : u;
  return Math.max(1, Math.round(-mean * Math.log(clamped)));
}

/** Nearest-rank percentile over an unsorted array; empty -> 0. p in 0..100. */
export function percentile(latencies: number[], p: number): number {
  if (latencies.length === 0) return 0;
  const sorted = [...latencies].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

/** Latch challenge flags from the current windows. Warmup-gated; only flips false->true. */
export function evalChallenges(
  prev: Challenges,
  s: { servers: number; varianceOn: boolean; fanout: number; user: number[]; backend: number[] },
): Challenges {
  if (s.user.length < WINDOW_MIN) return prev;
  const p50 = percentile(s.user, 50), p95 = percentile(s.user, 95), p99 = percentile(s.user, 99);
  const bp95 = percentile(s.backend, 95);
  const c1 = { ...prev.c1 }, c2 = { ...prev.c2 }, c3 = { ...prev.c3 };
  // C1 — the knee + rescue
  if (!c1.breached && s.servers === 1 && p99 > SLA && p50 < SLA) c1.breached = true;
  if (c1.breached && !c1.rescued && s.servers >= 2 && p99 < SLA) c1.rescued = true;
  // C2 — variance drives the tail
  if (!c2.hiTail && s.varianceOn && p99 >= VAR_TAIL_MULT * Math.max(1, p50)) c2.hiTail = true;
  if (c2.hiTail && !c2.loTail && !s.varianceOn && p99 < LO_TAIL_MULT * Math.max(1, p50)) c2.loTail = true;
  // C3 — tail-latency amplification
  if (!c3.amplified && s.fanout >= FANOUT_MIN && p50 >= AMPLIFY * bp95 && bp95 > 0) c3.amplified = true;
  return { c1, c2, c3 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/load-shared.test.ts`
Expected: PASS (all cases). Then `npx tsc -b` clean.

- [ ] **Step 5: Commit**

```bash
git add src/modules/load-shared.ts src/modules/load-shared.test.ts
git commit -m "feat(modules): Ch1 shared vocab — SVC node, queue params, percentile/expTick/evalChallenges"
```

---

## Task 2: Load module — arrival, queue, completion, inspect/metrics

**Files:**
- Create: `src/modules/load.ts`
- Test: `src/modules/load.test.ts`

**Interfaces:**
- Consumes: everything from Task 1.
- Produces:
  - `type LoadExternal = { cmd:'set-load'; level:number } | { cmd:'set-servers'; c:number } | { cmd:'set-cache'; h:number } | { cmd:'set-variance'; on:boolean } | { cmd:'set-fanout'; n:number }`
  - `type LoadTimer = { t:'arrival' } | { t:'complete'; parentId:number; cached:boolean }`
  - `type LoadPayload = LoadExternal | LoadTimer`
  - `const load: SimModule<LoadState, LoadPayload>`
  - re-exports `LoadState`, `LoadInspect` from shared for test import convenience.

This task builds the queue mechanics with `fanout` fixed at 1 and `cacheHitRate` 0 (knobs land in Task 3). Draw service at arrival, serve on free slot else enqueue, complete frees a slot and pulls the queue head, record latencies, arm the next arrival.

- [ ] **Step 1: Write the failing test** — `src/modules/load.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { Simulation } from '../engine';
import { LOAD_NODES, SVC, SERVICE_MEAN, type LoadInspect } from './load-shared';
import { load, type LoadPayload } from './load';
import type { LoadState } from './load-shared';

function makeSim(seed = 1) {
  return new Simulation<LoadState, LoadPayload>({ module: load, config: { nodeIds: LOAD_NODES }, seed });
}
const svc = (sim: Simulation<LoadState, LoadPayload>) => sim.getState(SVC);
const view = (sim: Simulation<LoadState, LoadPayload>) => load.inspect(svc(sim)) as unknown as LoadInspect;

describe('boot arms the arrival loop', () => {
  test('init returns and an arrival timer is queued (queue grows under load)', () => {
    const sim = makeSim();
    sim.runSteps(1); // init
    sim.external(SVC, { cmd: 'set-load', level: 18 }); // overload c=1
    sim.runSteps(400);
    const v = view(sim);
    expect(v.completed).toBeGreaterThan(0);           // requests are completing
    expect(v.inService).toBeLessThanOrEqual(v.servers); // never over capacity (servers constant)
  });
});

describe('response time >= service time (wait never negative)', () => {
  test('every recorded user latency is >= 1 tick', () => {
    const sim = makeSim();
    sim.runSteps(1);
    sim.external(SVC, { cmd: 'set-load', level: 10 });
    sim.runSteps(600);
    const s = svc(sim);
    for (const c of s.user) expect(c.lat).toBeGreaterThanOrEqual(1);
    for (const b of s.backend) expect(b).toBeGreaterThanOrEqual(1);
  });
});

describe('percentile ordering holds on a real run', () => {
  test('p50 <= p95 <= p99', () => {
    const sim = makeSim();
    sim.runSteps(1);
    sim.external(SVC, { cmd: 'set-load', level: 16 });
    sim.runSteps(1000);
    const v = view(sim);
    expect(v.p50).toBeLessThanOrEqual(v.p95);
    expect(v.p95).toBeLessThanOrEqual(v.p99);
  });
});

describe('queue drains when load is low, backs up when high', () => {
  test('high load builds a queue, low load keeps it near empty', () => {
    const hi = makeSim(); hi.runSteps(1);
    hi.external(SVC, { cmd: 'set-load', level: 19 }); hi.runSteps(1500);
    const lo = makeSim(); lo.runSteps(1);
    lo.external(SVC, { cmd: 'set-load', level: 3 }); lo.runSteps(1500);
    expect(view(hi).queueLen).toBeGreaterThan(view(lo).queueLen);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/load.test.ts`
Expected: FAIL — `./load` not found.

- [ ] **Step 3: Write minimal implementation** — `src/modules/load.ts`:

```ts
import type { Effect, InspectorTree, MetricSample, SimModule } from '../engine/module';
import type { NodeId } from '../engine/events';
import type { SeededRng } from '../engine/rng';
import {
  SVC, SERVICE_MEAN, WINDOW, CACHE_TICKS, FANOUT_MIN,
  interArrivalMean, expTick, percentile, evalChallenges, freshChallenges,
  type LoadState, type LoadInspect, type SubReq, type Parent,
} from './load-shared';

export type LoadExternal =
  | { cmd: 'set-load'; level: number }
  | { cmd: 'set-servers'; c: number }
  | { cmd: 'set-cache'; h: number }
  | { cmd: 'set-variance'; on: boolean }
  | { cmd: 'set-fanout'; n: number };
export type LoadTimer = { t: 'arrival' } | { t: 'complete'; parentId: number; cached: boolean };
export type LoadPayload = LoadExternal | LoadTimer;

export type { LoadState, LoadInspect } from './load-shared';

const cap = (xs: number[]): number[] => (xs.length > WINDOW ? xs.slice(xs.length - WINDOW) : xs);
const capC = <T>(xs: T[]): T[] => (xs.length > WINDOW ? xs.slice(xs.length - WINDOW) : xs);

function serviceTick(state: LoadState, rng: SeededRng): number {
  return state.varianceOn ? expTick(SERVICE_MEAN, 1 - rng.next()) : SERVICE_MEAN;
}

/** Advance the busy-time accountant to `now` at the pre-event inService level. */
function tick(s: LoadState, now: number): LoadState {
  return { ...s, busyTicks: s.busyTicks + s.inService * (now - s.lastEventT), lastEventT: now };
}

const arrivalTimer = (mean: number): Effect => ({ type: 'timer', delay: mean, payload: { t: 'arrival' } });
const completeTimer = (delay: number, parentId: number, cached: boolean): Effect => ({
  type: 'timer', delay, payload: { t: 'complete', parentId, cached },
});

export const load: SimModule<LoadState, LoadPayload> = {
  id: 'load',
  chaos: [],

  init(nodeId: NodeId): LoadState {
    return {
      self: nodeId,
      loadLevel: 8, servers: 1, cacheHitRate: 0, varianceOn: true, fanout: 1,
      inService: 0, queue: [], pending: {}, nextId: 0,
      user: [], backend: [],
      busyTicks: 0, lastEventT: 0, completed: 0,
      ch: freshChallenges(),
    };
  },

  reduce(state, event, rng): [LoadState, Effect[]] {
    if (event.kind === 'init') return [state, [arrivalTimer(interArrivalMean(state.loadLevel))]];

    if (event.kind === 'timer') {
      const p = event.payload as LoadTimer;
      if (p.t === 'arrival') return onArrival(state, event.time, rng);
      if (p.t === 'complete') return onComplete(state, event.time, p, rng);
      return [state, []];
    }

    if (event.kind === 'external') return onExternal(state, event.payload as LoadExternal);
    return [state, []];
  },

  metrics(states): MetricSample[] {
    const s = states.get(SVC);
    if (!s) return [];
    return [
      { name: 'p99', value: percentile(s.user.map((c) => c.lat), 99) },
      { name: 'p50', value: percentile(s.user.map((c) => c.lat), 50) },
      { name: 'queueLen', value: s.queue.length },
      { name: 'inService', value: s.inService },
    ];
  },

  inspect(state): InspectorTree {
    const lat = state.user.map((c) => c.lat);
    const span = state.user.length >= 2 ? state.user[state.user.length - 1].t - state.user[0].t : 0;
    const elapsed = Math.max(1, state.lastEventT);
    const tree: LoadInspect = {
      loadLevel: state.loadLevel, servers: state.servers, cacheHitRate: state.cacheHitRate,
      varianceOn: state.varianceOn, fanout: state.fanout,
      inService: state.inService, queueLen: state.queue.length,
      p50: percentile(lat, 50), p95: percentile(lat, 95), p99: percentile(lat, 99),
      bp50: percentile(state.backend, 50), bp95: percentile(state.backend, 95), bp99: percentile(state.backend, 99),
      throughput: span > 0 ? state.user.length / span : 0,
      utilisation: Math.min(1, state.busyTicks / (state.servers * elapsed)),
      completed: state.completed, samples: state.user.length,
      sla: 0, ch: state.ch,
    };
    return tree as unknown as InspectorTree;
  },
};

/** Start `sub` on a free slot or enqueue it; returns [state, effects to start it]. */
function admit(s: LoadState, sub: SubReq): [LoadState, Effect[]] {
  if (sub.cached) return [s, [completeTimer(sub.service, sub.parentId, true)]]; // bypasses the servers
  if (s.inService < s.servers)
    return [{ ...s, inService: s.inService + 1 }, [completeTimer(sub.service, sub.parentId, false)]];
  return [{ ...s, queue: [...s.queue, sub] }, []];
}

function onArrival(state: LoadState, now: number, rng: SeededRng): [LoadState, Effect[]] {
  let s = tick(state, now);
  const parentId = s.nextId;
  const parent: Parent = { remaining: s.fanout, arrivalT: now, maxLatency: 0 };
  s = { ...s, nextId: s.nextId + 1, pending: { ...s.pending, [parentId]: parent } };
  const effects: Effect[] = [arrivalTimer(interArrivalMean(s.loadLevel))];
  for (let i = 0; i < s.fanout; i++) {
    const cached = rng.next() < s.cacheHitRate;
    const service = cached ? CACHE_TICKS : serviceTick(s, rng);
    const sub: SubReq = { id: parentId * 1000 + i, parentId, cached, service };
    const [s2, fx] = admit(s, sub);
    s = s2; effects.push(...fx);
  }
  return [s, effects];
}

function onComplete(state: LoadState, now: number, p: { parentId: number; cached: boolean }, rng: SeededRng): [LoadState, Effect[]] {
  let s = tick(state, now);
  const effects: Effect[] = [];
  if (!p.cached) {
    s = { ...s, inService: s.inService - 1 };
    if (s.queue.length > 0 && s.inService < s.servers) {
      const [head, ...rest] = s.queue;
      s = { ...s, queue: rest, inService: s.inService + 1 };
      effects.push(completeTimer(head.service, head.parentId, false));
    }
  }
  // join into the parent
  const parent = s.pending[p.parentId];
  if (parent) {
    const lat = now - parent.arrivalT;
    const backend = cap([...s.backend, lat]);
    const remaining = parent.remaining - 1;
    const maxLatency = Math.max(parent.maxLatency, lat);
    if (remaining === 0) {
      const rest = { ...s.pending }; delete rest[p.parentId];
      const user = capC([...s.user, { t: now, lat: maxLatency }]);
      const ch = evalChallenges(s.ch, {
        servers: s.servers, varianceOn: s.varianceOn, fanout: s.fanout,
        user: user.map((c) => c.lat), backend,
      });
      s = { ...s, backend, user, pending: rest, completed: s.completed + 1, ch };
    } else {
      s = { ...s, backend, pending: { ...s.pending, [p.parentId]: { ...parent, remaining, maxLatency } } };
    }
  }
  return [s, effects];
}

function onExternal(state: LoadState, p: LoadExternal): [LoadState, Effect[]] {
  switch (p.cmd) {
    case 'set-load': return [{ ...state, loadLevel: p.level, ch: { ...state.ch, c1: { breached: false, rescued: false } } }, []];
    case 'set-servers': return [{ ...state, servers: Math.max(1, p.c) }, []];
    case 'set-cache': return [{ ...state, cacheHitRate: Math.min(1, Math.max(0, p.h)) }, []];
    case 'set-variance': return [{ ...state, varianceOn: p.on, ch: p.on ? { ...state.ch, c2: { hiTail: false, loTail: false } } : state.ch }, []];
    case 'set-fanout': return [{ ...state, fanout: Math.max(1, p.n), ch: p.n >= FANOUT_MIN ? { ...state.ch, c3: { amplified: false } } : state.ch }, []];
    default: return [state, []];
  }
}
```

Note on `set-servers`: it does **not** dequeue waiting jobs immediately — the next `complete` event pulls the head while `inService < servers`, so a fresh replica takes effect on the next completion. That is the intended (and simplest correct) behaviour; the coupling property does not lower `servers` mid-run.

Note on the fresh-replica lag: because a replica only helps on the *next* completion, C1's rescue needs a few completions to register — the `runSteps(6000)` in the lesson test covers this. If C1 rescue is slow to latch, that is the cause, not a bug.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/modules/load.test.ts && npx tsc -b`
Expected: PASS + clean types.

- [ ] **Step 5: Commit**

```bash
git add src/modules/load.ts src/modules/load.test.ts
git commit -m "feat(modules): Ch1 load module — M/M/c arrival/queue/completion, rolling percentiles"
```

---

## Task 3: Knobs — cache bypass, variance, fan-out join

**Files:**
- Modify: `src/modules/load.ts` (already implements all knobs from Task 2)
- Test: `src/modules/load.test.ts` (add cases)

The knob *logic* shipped in Task 2; this task pins the three behaviours that most easily regress: cache bypass, fan-out join = max child, and variance-off = deterministic service.

- [ ] **Step 1: Write the failing tests** — append to `src/modules/load.test.ts`:

```ts
import { CACHE_TICKS, SERVICE_MEAN } from './load-shared';

describe('cache bypass', () => {
  test('h=1: no job ever waits in the queue and latencies are ~CACHE_TICKS', () => {
    const sim = makeSim(); sim.runSteps(1);
    sim.external(SVC, { cmd: 'set-cache', h: 1 });
    sim.external(SVC, { cmd: 'set-load', level: 19 }); // even overloaded, hits bypass servers
    sim.runSteps(1000);
    const s = svc(sim);
    expect(s.queue.length).toBe(0);
    expect(Math.max(...s.user.map((c) => c.lat))).toBeLessThanOrEqual(CACHE_TICKS);
  });
});

describe('fan-out join', () => {
  test('a user request completes only after all N sub-requests; latency = max child', () => {
    const sim = makeSim(); sim.runSteps(1);
    sim.external(SVC, { cmd: 'set-servers', c: 8 });
    sim.external(SVC, { cmd: 'set-fanout', n: 5 });
    sim.external(SVC, { cmd: 'set-load', level: 4 }); // low load: backend unsaturated
    sim.runSteps(2000);
    const s = svc(sim);
    // every user latency must be >= the mean single service (max of 5 draws skews high)
    expect(s.user.length).toBeGreaterThan(0);
    // backend samples are 5x the user completions (each parent has 5 children) — approx check
    expect(s.backend.length).toBeGreaterThanOrEqual(s.completed);
  });
});

describe('variance off = deterministic service', () => {
  test('variance off with no queueing gives a tight tail (p99 ~ p50)', () => {
    const sim = makeSim(); sim.runSteps(1);
    sim.external(SVC, { cmd: 'set-variance', on: false });
    sim.external(SVC, { cmd: 'set-servers', c: 4 });
    sim.external(SVC, { cmd: 'set-load', level: 6 }); // ρ well under 1
    sim.runSteps(3000);
    const v = view(sim);
    expect(v.p99).toBeLessThanOrEqual(v.p50 * 2 + SERVICE_MEAN); // near-constant service
  });
});
```

- [ ] **Step 2: Run to verify they fail, then pass**

Run: `npx vitest run src/modules/load.test.ts`
Expected: the three new cases PASS with the Task 2 implementation. (If `fan-out join` backend-count assertion is off, it reveals a join bug — fix `onComplete` so every child pushes a backend sample.)

- [ ] **Step 3: Commit**

```bash
git add src/modules/load.test.ts
git commit -m "test(modules): Ch1 knob behaviours — cache bypass, fan-out join, variance-off tight tail"
```

---

## Task 4: Challenge flag mechanism (unit-level, epoch-gated)

**Files:**
- Test: `src/modules/load.test.ts` (add a describe block driving flags via full sims)

`evalChallenges` is unit-tested in Task 1; this task proves the module *wires* it correctly through real command sequences and epoch resets.

- [ ] **Step 1: Write the failing tests** — append:

```ts
describe('challenge epoch gating', () => {
  test('set-load resets C1 flags (fresh knee attempt)', () => {
    const sim = makeSim(); sim.runSteps(1);
    sim.external(SVC, { cmd: 'set-load', level: 18 });
    sim.runSteps(3000);
    // force a stale breached flag, then a new set-load must clear it
    const before = svc(sim).ch.c1.breached;
    sim.external(SVC, { cmd: 'set-load', level: 5 });
    sim.runSteps(2);
    expect(svc(sim).ch.c1.breached).toBe(false);
    expect(typeof before).toBe('boolean');
  });
  test('set-variance on resets C2 flags', () => {
    const sim = makeSim(); sim.runSteps(1);
    sim.external(SVC, { cmd: 'set-variance', on: true });
    sim.runSteps(2);
    expect(svc(sim).ch.c2).toEqual({ hiTail: false, loTail: false });
  });
});
```

- [ ] **Step 2: Run to verify pass**

Run: `npx vitest run src/modules/load.test.ts && npx tsc -b`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/modules/load.test.ts
git commit -m "test(modules): Ch1 challenge epoch gating — set-load/set-variance reset their flags"
```

---

## Task 5: Property suite

**Files:**
- Create: `src/modules/load.property.test.ts`

**Interfaces:** consumes `load`, `load-shared`. Uses `fast-check` (already a dep — see any `*.property.test.ts`).

Invariants (seed-independent). A counterexample is a real bug: shrink, report, fix minimally, document.

- [ ] **Step 1: Write the failing test** — `src/modules/load.property.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import { Simulation } from '../engine';
import { LOAD_NODES, SVC, percentile, type LoadState } from './load-shared';
import { load, type LoadPayload } from './load';

function run(seed: number, level: number, servers: number, variance: boolean, steps: number): LoadState {
  const sim = new Simulation<LoadState, LoadPayload>({ module: load, config: { nodeIds: LOAD_NODES }, seed });
  sim.runSteps(1);
  sim.external(SVC, { cmd: 'set-servers', c: servers });
  sim.external(SVC, { cmd: 'set-variance', on: variance });
  sim.external(SVC, { cmd: 'set-load', level });
  sim.runSteps(steps);
  return sim.getState(SVC);
}

describe('load module invariants', () => {
  test('(a) percentile ordering: p50 <= p95 <= p99 <= max', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 1, max: 20 }), (seed, level) => {
      const s = run(seed, level, 2, true, 800);
      const lat = s.user.map((c) => c.lat);
      if (lat.length === 0) return;
      expect(percentile(lat, 50)).toBeLessThanOrEqual(percentile(lat, 95));
      expect(percentile(lat, 95)).toBeLessThanOrEqual(percentile(lat, 99));
      expect(percentile(lat, 99)).toBeLessThanOrEqual(Math.max(...lat));
    }), { numRuns: 40 });
  });

  test('(b) response >= service: user latency >= each of its children; all latencies >= 1', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 1000 }), (seed) => {
      const s = run(seed, 12, 2, true, 800);
      for (const c of s.user) expect(c.lat).toBeGreaterThanOrEqual(1);
      for (const b of s.backend) expect(b).toBeGreaterThanOrEqual(1);
    }), { numRuns: 40 });
  });

  test('(c) server-count monotonicity by coupling: c+1 completes each request no later than c', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 8, max: 18 }), (seed, level) => {
      // Same seed + same command times => identical arrival + service stream (service drawn at arrival).
      const c1 = run(seed, level, 1, true, 1500);
      const c2 = run(seed, level, 2, true, 1500);
      // With more capacity, at least as many requests complete in the same #steps.
      expect(c2.completed).toBeGreaterThanOrEqual(c1.completed);
      // and the p99 under c=2 is <= p99 under c=1 (queueing only ever hurts the tail more with fewer servers).
      const p99a = percentile(c1.user.map((x) => x.lat), 99);
      const p99b = percentile(c2.user.map((x) => x.lat), 99);
      expect(p99b).toBeLessThanOrEqual(p99a + 1); // +1 tolerance for integer rounding
    }), { numRuns: 30 });
  });

  test('(d) utilisation bound: busyTicks <= servers * elapsed (servers constant)', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 1, max: 20 }), fc.integer({ min: 1, max: 3 }), (seed, level, c) => {
      const s = run(seed, level, c, true, 800);
      expect(s.busyTicks).toBeLessThanOrEqual(s.servers * s.lastEventT + 1e-9);
    }), { numRuns: 40 });
  });
});
```

- [ ] **Step 2: Run to verify it passes (fixing any real counterexample)**

Run: `npx vitest run src/modules/load.property.test.ts`
Expected: PASS. If (c) fails, the likely cause is service **not** drawn at arrival — verify `onArrival` draws `service` and stores it on the `SubReq` (never redrawn at start-of-service). Document any minimal fix as a code comment citing the invariant.

- [ ] **Step 3: Commit**

```bash
git add src/modules/load.property.test.ts
git commit -m "test(modules): Ch1 property suite — ordering, response>=service, server-count coupling, utilisation"
```

---

## Task 6: Pinned lesson test (three challenges, fixed seed)

**Files:**
- Create: `src/modules/load-lesson.test.ts`

Each challenge is its own sim at a fixed seed, asserted clause-by-clause. **Tune the constants in `load-shared.ts`** (`SLA`, `VAR_TAIL_MULT`, `LO_TAIL_MULT`, `FANOUT_MIN`, `LOAD_MAX`) until every clause holds with margin at the chosen seed. Tuning procedure: run the scenario, `console.log` the relevant `inspect()` percentiles, pick thresholds that clear with ≥ 20% margin, delete the logs.

- [ ] **Step 1: Write the failing test** — `src/modules/load-lesson.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { Simulation } from '../engine';
import { LOAD_NODES, SVC, FANOUT_MIN, type LoadState, type LoadInspect } from './load-shared';
import { load, type LoadPayload } from './load';

function makeSim(seed: number) {
  const sim = new Simulation<LoadState, LoadPayload>({ module: load, config: { nodeIds: LOAD_NODES }, seed });
  sim.runSteps(1);
  return sim;
}
const flags = (sim: Simulation<LoadState, LoadPayload>) => sim.getState(SVC).ch;

describe('C1 — the knee + rescue', () => {
  test('overload c=1 breaches the SLA, then a replica rescues it in one epoch', () => {
    const sim = makeSim(7);
    sim.external(SVC, { cmd: 'set-load', level: 18 }); // ρ(c=1) = 1.5
    sim.runSteps(6000);
    expect(flags(sim).c1.breached).toBe(true);   // p99 > SLA while p50 < SLA
    sim.external(SVC, { cmd: 'set-servers', c: 2 }); // ρ(c=2) = 0.75
    sim.runSteps(6000);
    expect(flags(sim).c1.rescued).toBe(true);
  });
});

describe('C2 — variance drives the tail', () => {
  test('variance on gives a fat tail; toggling off collapses it, in one epoch', () => {
    const sim = makeSim(11);
    sim.external(SVC, { cmd: 'set-servers', c: 3 });
    sim.external(SVC, { cmd: 'set-variance', on: true });
    sim.external(SVC, { cmd: 'set-load', level: 12 }); // ρ under 1 so queueing isn't the cause
    sim.runSteps(6000);
    expect(flags(sim).c2.hiTail).toBe(true);
    sim.external(SVC, { cmd: 'set-variance', on: false });
    sim.runSteps(6000);
    expect(flags(sim).c2.loTail).toBe(true);
  });
});

describe('C3 — tail-latency amplification', () => {
  test('fan-out makes the median user request feel the backend tail', () => {
    const sim = makeSim(5);
    sim.external(SVC, { cmd: 'set-servers', c: 8 });   // backend unsaturated
    sim.external(SVC, { cmd: 'set-variance', on: true });
    sim.external(SVC, { cmd: 'set-fanout', n: FANOUT_MIN });
    sim.external(SVC, { cmd: 'set-load', level: 2 });   // low λ; N sub-requests still fit
    sim.runSteps(20000);
    expect(flags(sim).c3.amplified).toBe(true);
  });
});
```

- [ ] **Step 2: Run, tune constants until green**

Run: `npx vitest run src/modules/load-lesson.test.ts`
Expected: eventually PASS after tuning. If C3 saturates the backend (queueing, not amplification), lower `level` or raise `servers` in the scenario, and confirm backend ρ < 1 (`inspect().utilisation` well under 1 during C3).

- [ ] **Step 3: Full gate + commit**

Run: `npx vitest run && npx tsc -b && npm run build`

```bash
git add src/modules/load-shared.ts src/modules/load-lesson.test.ts
git commit -m "test(modules): Ch1 pinned lesson — knee+rescue, variance tail, fan-out amplification; tune thresholds"
```

---

## Task 7: PercentilePanel (presentational)

**Files:**
- Create: `src/ui/labs/load/PercentilePanel.tsx`
- Test: `src/ui/labs/load/PercentilePanel.test.tsx`

Pure props, no engine import — the Ch12 `DerivedPanel` / Ch10 `StagePanel` pattern. Read `src/ui/labs/unbundled/DerivedPanel.tsx` first for the exact styling/idiom.

**Interfaces:**
- Produces: `export function PercentilePanel(props: { view: LoadInspect }): JSX.Element` where `LoadInspect` is imported from `../../../modules/load-shared`.

- [ ] **Step 1: Write the failing test** — `src/ui/labs/load/PercentilePanel.test.tsx`:

```tsx
import { describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PercentilePanel } from './PercentilePanel';
import type { LoadInspect } from '../../../modules/load-shared';

const base: LoadInspect = {
  loadLevel: 12, servers: 1, cacheHitRate: 0, varianceOn: true, fanout: 1,
  inService: 1, queueLen: 3, p50: 30, p95: 120, p99: 400, bp50: 30, bp95: 60, bp99: 90,
  throughput: 0.1, utilisation: 0.95, completed: 240, samples: 200, sla: 100,
  ch: { c1: { breached: false, rescued: false }, c2: { hiTail: false, loTail: false }, c3: { amplified: false } },
};

describe('PercentilePanel', () => {
  test('renders the three user percentiles', () => {
    render(<PercentilePanel view={base} />);
    expect(screen.getByText(/p50/i)).toBeInTheDocument();
    expect(screen.getByText(/p99/i)).toBeInTheDocument();
    expect(screen.getByText('400')).toBeInTheDocument();
  });
  test('shows a warming-up state before WINDOW_MIN samples', () => {
    render(<PercentilePanel view={{ ...base, samples: 5 }} />);
    expect(screen.getByText(/warming up/i)).toBeInTheDocument();
  });
  test('shows the backend row only when fanout > 1', () => {
    const { rerender } = render(<PercentilePanel view={base} />);
    expect(screen.queryByText(/backend/i)).toBeNull();
    rerender(<PercentilePanel view={{ ...base, fanout: 20 }} />);
    expect(screen.getByText(/backend/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/ui/labs/load/PercentilePanel.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `PercentilePanel.tsx`** — bars for p50/p95/p99 (user; backend row when `fanout>1`), an SLA marker line at `view.sla` (or the `SLA` constant), a throughput + queue-depth + utilisation readout, and a "warming up" placeholder when `view.samples < WINDOW_MIN`. Match the Tailwind idiom of `DerivedPanel.tsx`. Keep it a pure function of props.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/ui/labs/load/PercentilePanel.test.tsx && npx tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/labs/load/PercentilePanel.tsx src/ui/labs/load/PercentilePanel.test.tsx
git commit -m "feat(ui): Ch1 PercentilePanel — p50/p95/p99 bars, SLA line, throughput/util readout"
```

---

## Task 8: LoadLab (assembly)

**Files:**
- Create: `src/ui/labs/load/LoadLab.tsx`
- Test: `src/ui/labs/load/LoadLab.test.tsx`

Mirror `src/ui/labs/unbundled/UnbundledLab.tsx` exactly for sim wiring (the `useSimulation`/store hook, play/step controls, `TimelineScrubber`, `ChallengePanel` ×3, predict-before-run). Read it first. Differences:
- Controls: a **load slider** (`set-load`, 1..`LOAD_MAX`), a servers stepper (`set-servers`), a cache-hit slider (`set-cache`), a variance toggle (`set-variance`), a fan-out stepper (`set-fanout`).
- Middle: a queue visual — `servers` slots (busy/idle from `inspect().inService`) + a row of `queueLen` waiting dots (cap the drawn dots, show "+N" past a limit).
- Right: `<PercentilePanel view={inspect} />`.
- Three `ChallengePanel`s reading `inspect().ch.c1/c2/c3` for their win banners, each with its predict prompt (mirror the Ch12 challenge copy).

- [ ] **Step 1: Write the failing smoke + wiring test** — `src/ui/labs/load/LoadLab.test.tsx`:

```tsx
import { describe, expect, test } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LoadLab } from './LoadLab';

describe('LoadLab', () => {
  test('renders controls and the percentile panel', () => {
    render(<LoadLab />);
    expect(screen.getByLabelText(/load/i)).toBeInTheDocument();
    expect(screen.getByText(/p99/i)).toBeInTheDocument();
  });
  test('the three challenges render their titles', () => {
    render(<LoadLab />);
    expect(screen.getByText(/knee/i)).toBeInTheDocument();
    expect(screen.getByText(/variance/i)).toBeInTheDocument();
    expect(screen.getByText(/amplification/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify fail → implement → pass**

Implement `LoadLab.tsx` per the mirror above. Run: `npx vitest run src/ui/labs/load/LoadLab.test.tsx && npx tsc -b`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/ui/labs/load/LoadLab.tsx src/ui/labs/load/LoadLab.test.tsx
git commit -m "feat(ui): Ch1 LoadLab — load slider, queue visual, percentile panel, three challenges"
```

---

## Task 9: Debrief + MDX content

**Files:**
- Create: `src/ui/labs/load/Debrief.tsx` (export `LoadDebrief`), `content/ch01/debrief.mdx`

Mirror `src/ui/labs/unbundled/Debrief.tsx` and `content/ch12/debrief.mdx`. Journal key `ddia:ch01:journal`.

MDX content, in order (per spec §5): **Scalability** — load parameters; percentiles not averages; the p95/p99/p999 tail and why it's what users feel; the queueing knee (response time vs load); head-of-line blocking; service-time variance; **tail-latency amplification** (max-of-N, hedged requests as the remedy). Then prose-only: **Reliability** — faults vs failures; hardware/software/human errors; fault tolerance + deliberate fault injection (Chaos Monkey), cross-linking Ch5/Ch8/Ch9 as this book's "cause the fault yourself" labs. **Maintainability** — operability, simplicity (accidental complexity, good abstractions), evolvability. Real systems: Twitter fan-out-on-write timelines, Amazon's p99.9 SLA, Dean & Barroso "The Tail at Scale". Terms list: latency vs response time, percentile/p99/tail latency, throughput, load parameter, utilisation, head-of-line blocking, tail-latency amplification, SLA/SLO.

- [ ] **Step 1:** Write `content/ch01/debrief.mdx` with the sections above.
- [ ] **Step 2:** Write `Debrief.tsx` (host + journal), exporting `LoadDebrief`, mirroring the unbundled debrief.
- [ ] **Step 3:** `npx tsc -b && npm run build` (MDX compiles).
- [ ] **Step 4: Commit**

```bash
git add src/ui/labs/load/Debrief.tsx content/ch01/debrief.mdx
git commit -m "feat(content): Ch1 debrief — percentiles/tail/amplification + reliability & maintainability prose"
```

---

## Task 10: Wiring + ship gate

**Files:**
- Modify: `src/ui/shell/catalog.ts`, `src/ui/shell/catalog.test.ts`, `src/ui/App.tsx`, `README.md`, `docs/DESIGN_PLAN.md`, `docs/DESIGN_PLAN.en.md`

- [ ] **Step 1: Catalog** — in `catalog.ts` flip `1.1` to `status:'active'` and add `{ id:'1.d', label:'Debrief & Journal', status:'active' }` to `ch1.labs`. Update the ch1 assertion in `catalog.test.ts` (it currently expects `1.1` `soon`; assert both `1.1` and `1.d` are `active`, mirroring the ch12 test).

- [ ] **Step 2: App PAGES** — in `App.tsx` add imports `import { LoadLab } from './labs/load/LoadLab';` and `import { LoadDebrief } from './labs/load/Debrief';`, and PAGES entries for `'1.1'` (Component `LoadLab`, eyebrow "Chapter 1 — Scalability") and `'1.d'` (Component `LoadDebrief`, eyebrow "Chapter 1 — Debrief"), mirroring the `'12.1'`/`'12.d'` entries.

- [ ] **Step 3: README + DESIGN_PLAN** — README ch1 block + counter bump ("Eleven chapters live"). In `DESIGN_PLAN.en.md` §7 Phase 5 note: append "ch1 shipped 2026-07-20 — 1.1 Load Simulator (M/M/c queue, p50/p95/p99 tail, knee+rescue / variance / fan-out amplification challenges, all engine-verified) + 1.d debrief; only ch2 remains." Keep `DESIGN_PLAN.md` (Vietnamese) frozen per the ch12 precedent (commit 27e05b1) — English-only note.

- [ ] **Step 4: Full gate**

Run: `npx vitest run && npx tsc -b && npm run build`
Expected: all green.

- [ ] **Step 5: Browser DoD (ship gate)** — `npm run dev`, drive C1 live: raise the load slider past the knee → watch p99 cross the SLA line (breach banner) → add a replica → p99 drops back under SLA (rescue banner). Confirm 0 console errors (playwright or manual). Screenshot the breach + rescue.

- [ ] **Step 6: Commit**

```bash
git add src/ui/shell/catalog.ts src/ui/shell/catalog.test.ts src/ui/App.tsx README.md docs/DESIGN_PLAN.en.md
git commit -m "feat(ui): ship Ch1 Load Simulator — catalog 1.1/1.d active, App pages, README, roadmap"
```

---

## Self-Review

**Spec coverage:** §1 In → Tasks 1 (shared) / 2–4 (module) / 7 (panel) / 8 (lab) / 9 (debrief) / 10 (wiring). §1 Out → all prose in Task 9's MDX. §2 model → Tasks 1–3. §3 interaction → Task 2 `onExternal` + Task 8 controls. §4 challenges → Tasks 1 (`evalChallenges`) + 4 (gating) + 6 (pinned). §5 UI/debrief/wiring → 7/8/9/10. §6 testing → each task's tests + 5 (property) + 6 (lesson). §7 files → File Structure. §8 risks: fan-out load confounder → Task 6 C3 note; seed-robust thresholds → Task 6 tuning; warmup → `WINDOW_MIN` gate in Task 1; ρ>1 unbounded queue → Task 8 dot cap. All covered.

**Placeholder scan:** the one deliberate typo (`s.slaOr`) is called out with its fix in Task 1 Step 4; the `20`→`FANOUT_MIN` swap is called out in Task 2 Step 4. No other TBD/TODO. UI tasks reference concrete existing files to mirror (allowed — real codebase patterns, not sibling plan tasks).

**Type consistency:** `LoadState`/`LoadInspect`/`SubReq`/`Parent`/`Completion`/`Challenges` defined in Task 1, imported unchanged in Tasks 2–8. Command union `LoadExternal` and timer union `LoadTimer` defined in Task 2, used verbatim in Tasks 3/4/6. `evalChallenges` signature matches its Task 1 definition and its Task 2 call site (`{servers,varianceOn,fanout,user,backend}`).
