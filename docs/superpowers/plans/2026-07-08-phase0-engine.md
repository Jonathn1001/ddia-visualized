# Phase 0 — Simulation Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the deterministic discrete-event simulation core of DDIA Visualized — event loop, virtual clock, seeded RNG, SimNetwork with chaos, snapshot/replay timeline recorder, SimModule contract v0 — validated by a 3-node ping-pong module and property-based tests.

**Architecture:** Pure-TypeScript simulation core (`src/engine/`) with zero UI dependencies. Everything is an event in a priority queue ordered by virtual time; nodes are pure reducers `(state, event) => [state', effects[]]`; all randomness flows through one seeded PRNG so every run is reproducible. A TimelineRecorder snapshots full sim state every N events and scrubs by restore + deterministic replay. See `docs/DESIGN_PLAN.en.md` §5 for the full rationale.

**Tech Stack:** TypeScript (strict), Vitest, @vitest/coverage-v8, fast-check, ESLint (typescript-eslint flat config), npm. No React/Vite yet — Phase 1 adds the UI on top without restructuring.

## Global Constraints

- Working directory: `/home/elgnas/Projects/Personal/ddia-visualized` (all paths below relative to it; `docs/` already exists).
- TypeScript `strict: true`; `"type": "module"`; Node ≥ 20.
- `src/engine/**` and `src/modules/**` must never import `react`, `react-dom`, `zustand`, `motion`, or anything DOM-flavored (ESLint-enforced, DESIGN_PLAN §5).
- No `Math.random`, `Date.now`, `setTimeout`, `setInterval` in `src/engine/**` or `src/modules/**`. All time is virtual; all randomness comes from `SeededRng`. (`performance.now` allowed in test files only.)
- Module state must be plain JSON-serializable objects — no class instances, `Map`, or `Set` inside module state (they must survive `structuredClone` and `JSON.stringify`).
- Deterministic tie-break: events with equal virtual time process in insertion order (`seq`).
- Coverage ≥ 80% (lines, branches, functions, statements) over `src/**` excluding tests.
- Conventional commit messages.

**Phase 0 Definition of Done (from `docs/DESIGN_PLAN.en.md` §9)** — task mapping:

| DoD item | Task |
|---|---|
| Same seed + action log → identical event-log hash over 100 runs | Task 6 |
| Scrub across 10k events to any point < 100 ms | Task 7 |
| 3-node ping-pong passes property tests under delay/drop/reorder | Task 9 |
| Sim core has 0 React/DOM deps (import lint rule) | Task 1, verified Task 10 |
| Module contract v0 validated by a module implementing full interface | Task 8 |
| Sim core coverage ≥ 80% | Task 10 |

---

### Task 1: Project Scaffold & Toolchain

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`, `.gitignore`, `src/engine/toolchain.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: working `npm test`, `npm run lint`, `npm run typecheck` commands every later task relies on.

- [ ] **Step 1: Init git and npm**

```bash
cd /home/elgnas/Projects/Personal/ddia-visualized
git init
npm init -y
npm i -D typescript vitest @vitest/coverage-v8 fast-check eslint typescript-eslint
```

- [ ] **Step 2: Write config files**

Replace `package.json` scripts/meta (keep the `devDependencies` npm generated):

```json
{
  "name": "ddia-visualized",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "coverage": "vitest run --coverage",
    "lint": "eslint src",
    "typecheck": "tsc --noEmit"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"]
}
```

(`DOM` lib is only for `structuredClone`/`performance` typings; actual DOM imports are lint-banned in the core.)

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
```

Create `eslint.config.js`:

```js
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules', 'dist', 'coverage', 'docs'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/engine/**/*.ts', 'src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react', 'react-*', 'react/*', '*react*', 'zustand', 'zustand/*', 'motion', 'motion/*'],
              message: 'Simulation core must stay free of UI dependencies (DESIGN_PLAN §5).',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'setTimeout', message: 'Virtual clock only — schedule events instead.' },
        { name: 'setInterval', message: 'Virtual clock only — schedule events instead.' },
      ],
    },
  },
  {
    files: ['src/**/*.test.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },
);
```

Create `.gitignore`:

```
node_modules/
dist/
coverage/
.env
.env.*
*.local
```

- [ ] **Step 3: Write toolchain sanity test**

Create `src/engine/toolchain.test.ts`:

```ts
import { expect, test } from 'vitest';

test('toolchain sanity', () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 4: Verify all three commands pass**

Run: `npm test && npm run lint && npm run typecheck`
Expected: 1 test PASS, lint clean, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold TypeScript + Vitest + ESLint toolchain"
```

---

### Task 2: SeededRng

**Files:**
- Create: `src/engine/rng.ts`
- Test: `src/engine/rng.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class SeededRng { constructor(seed: number); next(): number /* [0,1) */; int(minIncl: number, maxExcl: number): number; getState(): number; setState(s: number): void }` — used by SimNetwork, Simulation, and every module's `reduce`.

- [ ] **Step 1: Write the failing test**

Create `src/engine/rng.test.ts`:

```ts
import { expect, test } from 'vitest';
import { SeededRng } from './rng';

test('same seed produces the same sequence', () => {
  const a = new SeededRng(42);
  const b = new SeededRng(42);
  for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
});

test('different seeds produce different sequences', () => {
  const a = new SeededRng(1);
  const b = new SeededRng(2);
  const seqA = Array.from({ length: 10 }, () => a.next());
  const seqB = Array.from({ length: 10 }, () => b.next());
  expect(seqA).not.toEqual(seqB);
});

test('next() stays in [0, 1)', () => {
  const rng = new SeededRng(7);
  for (let i = 0; i < 1000; i++) {
    const v = rng.next();
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  }
});

test('int(min, maxExcl) stays in range and hits both ends eventually', () => {
  const rng = new SeededRng(7);
  const seen = new Set<number>();
  for (let i = 0; i < 1000; i++) {
    const v = rng.int(3, 6);
    expect(v).toBeGreaterThanOrEqual(3);
    expect(v).toBeLessThan(6);
    seen.add(v);
  }
  expect(seen).toEqual(new Set([3, 4, 5]));
});

test('getState/setState replays the stream exactly', () => {
  const rng = new SeededRng(99);
  rng.next();
  rng.next();
  const state = rng.getState();
  const ahead = [rng.next(), rng.next(), rng.next()];
  rng.setState(state);
  expect([rng.next(), rng.next(), rng.next()]).toEqual(ahead);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/rng.test.ts`
Expected: FAIL — `Cannot find module './rng'`.

- [ ] **Step 3: Implement SeededRng (mulberry32)**

Create `src/engine/rng.ts`:

```ts
/**
 * Deterministic PRNG (mulberry32). Single uint32 of state so snapshots are
 * trivial — the entire stream position is captured by getState().
 */
export class SeededRng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [minIncl, maxExcl). */
  int(minIncl: number, maxExcl: number): number {
    return minIncl + Math.floor(this.next() * (maxExcl - minIncl));
  }

  getState(): number {
    return this.state;
  }

  setState(s: number): void {
    this.state = s >>> 0;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/rng.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/rng.ts src/engine/rng.test.ts
git commit -m "feat(engine): seeded PRNG with snapshotable state"
```

---

### Task 3: Event Types & Priority Queue

**Files:**
- Create: `src/engine/events.ts`
- Test: `src/engine/events.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type NodeId = string`
  - `interface SimEvent<P = unknown> { time: number; seq: number; target: NodeId; kind: 'init' | 'message' | 'timer' | 'external' | 'control'; from?: NodeId; payload: P }`
  - `class EventQueue { push(e: SimEvent): void; pop(): SimEvent | undefined; peek(): SimEvent | undefined; get size(): number; toArray(): SimEvent[]; loadFrom(events: SimEvent[]): void }` — min-heap by `(time, seq)`; `toArray`/`loadFrom` exchange the raw heap array for snapshots.

- [ ] **Step 1: Write the failing test**

Create `src/engine/events.test.ts`:

```ts
import { expect, test } from 'vitest';
import { EventQueue, type SimEvent } from './events';

const ev = (time: number, seq: number, payload: unknown): SimEvent => ({
  time,
  seq,
  target: 'a',
  kind: 'message',
  payload,
});

test('pops events in virtual-time order', () => {
  const q = new EventQueue();
  q.push(ev(30, 0, 'c'));
  q.push(ev(10, 1, 'a'));
  q.push(ev(20, 2, 'b'));
  expect(q.pop()!.payload).toBe('a');
  expect(q.pop()!.payload).toBe('b');
  expect(q.pop()!.payload).toBe('c');
  expect(q.pop()).toBeUndefined();
});

test('equal timestamps break ties by seq (FIFO)', () => {
  const q = new EventQueue();
  q.push(ev(5, 0, 'first'));
  q.push(ev(5, 1, 'second'));
  q.push(ev(1, 2, 'early'));
  expect(q.pop()!.payload).toBe('early');
  expect(q.pop()!.payload).toBe('first');
  expect(q.pop()!.payload).toBe('second');
});

test('peek returns the minimum without removing it', () => {
  const q = new EventQueue();
  expect(q.peek()).toBeUndefined();
  q.push(ev(9, 0, 'x'));
  q.push(ev(3, 1, 'y'));
  expect(q.peek()!.payload).toBe('y');
  expect(q.size).toBe(2);
});

test('interleaved push/pop keeps ordering', () => {
  const q = new EventQueue();
  q.push(ev(4, 0, 4));
  q.push(ev(1, 1, 1));
  expect(q.pop()!.payload).toBe(1);
  q.push(ev(2, 2, 2));
  q.push(ev(3, 3, 3));
  expect(q.pop()!.payload).toBe(2);
  expect(q.pop()!.payload).toBe(3);
  expect(q.pop()!.payload).toBe(4);
});

test('toArray/loadFrom round-trips the queue', () => {
  const q = new EventQueue();
  for (const [t, s] of [[5, 0], [1, 1], [3, 2], [1, 3]] as const) q.push(ev(t, s, `${t}:${s}`));
  const copy = new EventQueue();
  copy.loadFrom(q.toArray());
  const drain = (queue: EventQueue) => {
    const out: unknown[] = [];
    for (let e = queue.pop(); e; e = queue.pop()) out.push(e.payload);
    return out;
  };
  expect(drain(copy)).toEqual(['1:1', '1:3', '3:2', '5:0']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/events.test.ts`
Expected: FAIL — `Cannot find module './events'`.

- [ ] **Step 3: Implement the queue**

Create `src/engine/events.ts`:

```ts
export type NodeId = string;

export interface SimEvent<P = unknown> {
  /** Virtual milliseconds. */
  time: number;
  /** Global insertion counter — deterministic tie-break for equal times. */
  seq: number;
  target: NodeId;
  kind: 'init' | 'message' | 'timer' | 'external' | 'control';
  from?: NodeId;
  payload: P;
}

/** Binary min-heap ordered by (time, seq). */
export class EventQueue {
  private heap: SimEvent[] = [];

  get size(): number {
    return this.heap.length;
  }

  private before(a: SimEvent, b: SimEvent): boolean {
    return a.time !== b.time ? a.time < b.time : a.seq < b.seq;
  }

  push(e: SimEvent): void {
    const h = this.heap;
    h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.before(h[i], h[p])) {
        [h[i], h[p]] = [h[p], h[i]];
        i = p;
      } else break;
    }
  }

  peek(): SimEvent | undefined {
    return this.heap[0];
  }

  pop(): SimEvent | undefined {
    const h = this.heap;
    if (h.length === 0) return undefined;
    const top = h[0];
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && this.before(h[l], h[m])) m = l;
        if (r < h.length && this.before(h[r], h[m])) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m], h[i]];
        i = m;
      }
    }
    return top;
  }

  /** Raw heap array (heap order, not sorted) — for snapshots. */
  toArray(): SimEvent[] {
    return [...this.heap];
  }

  /** Restore from an array previously produced by toArray(). */
  loadFrom(events: SimEvent[]): void {
    this.heap = [...events];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/events.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/events.ts src/engine/events.test.ts
git commit -m "feat(engine): SimEvent type and (time, seq) min-heap event queue"
```

---

### Task 4: SimNetwork (latency, drop, duplicate, partition)

**Files:**
- Create: `src/engine/network.ts`
- Test: `src/engine/network.test.ts`

**Interfaces:**
- Consumes: `SeededRng` (Task 2), `NodeId` (Task 3).
- Produces:
  - `interface NetworkOptions { latency: [min: number, max: number]; dropRate: number; duplicateRate: number }`
  - `interface Delivery { delay: number }`
  - `class SimNetwork { constructor(opts?: Partial<NetworkOptions>); opts: NetworkOptions; partition(groups: NodeId[][]): void; heal(): void; canReach(from: NodeId, to: NodeId): boolean; plan(from: NodeId, to: NodeId, rng: SeededRng): Delivery[]; snapshot(): NetworkSnapshot; restore(s: NetworkSnapshot): void }`
  - `plan` returns `[]` when dropped/partitioned, one `Delivery` normally, two when duplicated. Reordering emerges naturally from random per-message latency.

- [ ] **Step 1: Write the failing test**

Create `src/engine/network.test.ts`:

```ts
import { expect, test } from 'vitest';
import { SeededRng } from './rng';
import { SimNetwork } from './network';

test('delivers exactly once within latency bounds by default', () => {
  const net = new SimNetwork({ latency: [5, 10] });
  const rng = new SeededRng(1);
  for (let i = 0; i < 200; i++) {
    const ds = net.plan('a', 'b', rng);
    expect(ds).toHaveLength(1);
    expect(ds[0].delay).toBeGreaterThanOrEqual(5);
    expect(ds[0].delay).toBeLessThanOrEqual(10);
  }
});

test('dropRate=1 drops everything', () => {
  const net = new SimNetwork({ dropRate: 1 });
  const rng = new SeededRng(1);
  for (let i = 0; i < 50; i++) expect(net.plan('a', 'b', rng)).toEqual([]);
});

test('duplicateRate=1 always delivers twice', () => {
  const net = new SimNetwork({ duplicateRate: 1 });
  const rng = new SeededRng(1);
  for (let i = 0; i < 50; i++) expect(net.plan('a', 'b', rng)).toHaveLength(2);
});

test('partition blocks cross-group, allows in-group', () => {
  const net = new SimNetwork();
  const rng = new SeededRng(1);
  net.partition([['a', 'b'], ['c']]);
  expect(net.canReach('a', 'b')).toBe(true);
  expect(net.canReach('a', 'c')).toBe(false);
  expect(net.canReach('c', 'a')).toBe(false);
  expect(net.plan('a', 'c', rng)).toEqual([]);
  expect(net.plan('a', 'b', rng)).toHaveLength(1);
});

test('heal removes the partition', () => {
  const net = new SimNetwork();
  net.partition([['a'], ['b']]);
  expect(net.canReach('a', 'b')).toBe(false);
  net.heal();
  expect(net.canReach('a', 'b')).toBe(true);
});

test('snapshot/restore round-trips options and partition', () => {
  const net = new SimNetwork({ latency: [2, 4], dropRate: 0.5 });
  net.partition([['a'], ['b']]);
  const snap = net.snapshot();
  net.heal();
  net.opts.dropRate = 0;
  net.restore(snap);
  expect(net.canReach('a', 'b')).toBe(false);
  expect(net.opts.dropRate).toBe(0.5);
  expect(net.opts.latency).toEqual([2, 4]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/network.test.ts`
Expected: FAIL — `Cannot find module './network'`.

- [ ] **Step 3: Implement SimNetwork**

Create `src/engine/network.ts`:

```ts
import type { NodeId } from './events';
import type { SeededRng } from './rng';

export interface NetworkOptions {
  /** [min, max] uniform latency in virtual ms (inclusive). */
  latency: [min: number, max: number];
  /** Probability 0..1 that a message is silently dropped. */
  dropRate: number;
  /** Probability 0..1 that a message is delivered twice. */
  duplicateRate: number;
}

export interface Delivery {
  delay: number;
}

export interface NetworkSnapshot {
  opts: NetworkOptions;
  groups: NodeId[][] | null;
}

/**
 * Decides the fate of each send: latency, drop, duplication, partitions.
 * Reordering emerges naturally from random per-message latency.
 */
export class SimNetwork {
  opts: NetworkOptions;
  private groups: NodeId[][] | null = null;

  constructor(opts?: Partial<NetworkOptions>) {
    this.opts = { latency: [1, 10], dropRate: 0, duplicateRate: 0, ...opts };
  }

  partition(groups: NodeId[][]): void {
    this.groups = groups;
  }

  heal(): void {
    this.groups = null;
  }

  canReach(from: NodeId, to: NodeId): boolean {
    if (!this.groups) return true;
    const g = this.groups.find((grp) => grp.includes(from));
    return g !== undefined && g.includes(to);
  }

  /** [] = dropped/partitioned; 1 entry = normal; 2 entries = duplicated. */
  plan(from: NodeId, to: NodeId, rng: SeededRng): Delivery[] {
    if (!this.canReach(from, to)) return [];
    if (rng.next() < this.opts.dropRate) return [];
    const [min, max] = this.opts.latency;
    const out: Delivery[] = [{ delay: rng.int(min, max + 1) }];
    if (rng.next() < this.opts.duplicateRate) out.push({ delay: rng.int(min, max + 1) });
    return out;
  }

  snapshot(): NetworkSnapshot {
    return structuredClone({ opts: this.opts, groups: this.groups });
  }

  restore(s: NetworkSnapshot): void {
    const c = structuredClone(s);
    this.opts = c.opts;
    this.groups = c.groups;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/network.test.ts`
Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/network.ts src/engine/network.test.ts
git commit -m "feat(engine): SimNetwork with latency, drop, duplicate, partition"
```

---

### Task 5: SimModule Contract & Simulation Core

**Files:**
- Create: `src/engine/module.ts`, `src/engine/sim.ts`, `src/engine/fixtures.ts`
- Test: `src/engine/sim.test.ts`

**Interfaces:**
- Consumes: `SeededRng` (Task 2), `EventQueue`/`SimEvent`/`NodeId` (Task 3), `SimNetwork` (Task 4).
- Produces (used by every later task):
  - `module.ts`: `Effect`, `ModuleConfig`, `ChaosCapability`, `MetricSample`, `InspectorTree`, `ModuleEvent<P>`, `SimModule<S, P>` — exact code below.
  - `sim.ts`: `class Simulation<S, P>` with `constructor(opts: { module: SimModule<S, P>; config: ModuleConfig; seed: number; network?: Partial<NetworkOptions> })`, `time: number`, `processed: number`, `readonly eventLog: LoggedEvent[]`, `step(): LoggedEvent | undefined`, `runSteps(n: number): void`, `runUntil(t: number): void`, `external(target: NodeId, payload: unknown): void`, `control(action: ControlAction): void`, `getState(id: NodeId): S`, `get pending(): number`, `network: SimNetwork`. (`snapshot()`/`restore()` are added in Task 7.)
  - `fixtures.ts`: test modules `counter`, `echo`, `chatty` reused by Tasks 5–7.

- [ ] **Step 1: Write the module contract types (types only — no test needed)**

Create `src/engine/module.ts`:

```ts
import type { NodeId } from './events';
import type { SeededRng } from './rng';

/** What a reducer may ask the engine to do. Interpreted by Simulation. */
export type Effect =
  | { type: 'send'; to: NodeId; payload: unknown }
  | { type: 'timer'; delay: number; payload: unknown };

export interface ModuleConfig {
  nodeIds: NodeId[];
  params?: Record<string, unknown>;
}

export type ChaosCapability =
  | 'kill-node'
  | 'partition'
  | 'delay'
  | 'drop'
  | 'duplicate'
  | 'clock-skew'
  | 'crash-mid-write'
  | 'torn-write'
  | 'disk-full';

export interface MetricSample {
  name: string;
  value: number;
}

export type InspectorTree = Record<string, unknown>;

/** The event shape a module's reduce() receives. 'control' never reaches modules. */
export interface ModuleEvent<P = unknown> {
  kind: 'init' | 'message' | 'timer' | 'external';
  self: NodeId;
  from?: NodeId;
  payload: P;
}

/**
 * Module contract v0.1 — one module per DDIA lab (DESIGN_PLAN §5).
 * S = per-node state (plain serializable object). P = payload union.
 * Refinements over the §5 draft: init receives its nodeId; reduce receives
 * the sim RNG (state is part of snapshots, so determinism holds); metrics
 * receives all node states.
 */
export interface SimModule<S, P = unknown> {
  id: string;
  chaos: ChaosCapability[];
  init(nodeId: NodeId, config: ModuleConfig, rng: SeededRng): S;
  reduce(state: S, event: ModuleEvent<P>, rng: SeededRng): [S, Effect[]];
  metrics(states: Map<NodeId, S>): MetricSample[];
  inspect(state: S): InspectorTree;
}
```

- [ ] **Step 2: Write test fixtures (shared by Tasks 5–7)**

Create `src/engine/fixtures.ts`:

```ts
import type { NodeId } from './events';
import type { InspectorTree, SimModule } from './module';

/** Single node counts to 3 via self-timers. Exercises init + timer effects. */
export interface CounterState {
  self: NodeId;
  count: number;
}

export const counter: SimModule<CounterState, null> = {
  id: 'counter',
  chaos: [],
  init: (nodeId) => ({ self: nodeId, count: 0 }),
  reduce: (state, event) => {
    if (event.kind === 'init') return [state, [{ type: 'timer', delay: 10, payload: null }]];
    if (event.kind === 'timer') {
      const next = { ...state, count: state.count + 1 };
      return [next, next.count < 3 ? [{ type: 'timer', delay: 10, payload: null }] : []];
    }
    return [state, []];
  },
  metrics: () => [],
  inspect: (s) => ({ ...s }) as InspectorTree,
};

/** 'a' pings 'b'; 'b' pongs back. Exercises send effects + from-field. */
export interface EchoState {
  self: NodeId;
  got: string[];
}

export const echo: SimModule<EchoState, { msg: string } | null> = {
  id: 'echo',
  chaos: [],
  init: (nodeId) => ({ self: nodeId, got: [] }),
  reduce: (state, event) => {
    if (event.kind === 'init' && state.self === 'a')
      return [state, [{ type: 'send', to: 'b', payload: { msg: 'ping' } }]];
    if (event.kind === 'message') {
      const { msg } = event.payload as { msg: string };
      const next = { ...state, got: [...state.got, msg] };
      if (msg === 'ping') return [next, [{ type: 'send', to: event.from!, payload: { msg: 'pong' } }]];
      return [next, []];
    }
    return [state, []];
  },
  metrics: () => [],
  inspect: (s) => ({ ...s }) as InspectorTree,
};

/**
 * Ring of nodes that never stops talking: every node re-arms a jittered
 * timer forever and forwards hops. Generates an unbounded, RNG-dependent
 * event stream — used for determinism and scrubbing tests.
 */
export interface ChatState {
  self: NodeId;
  next: NodeId;
  heard: number;
}

export const chatty: SimModule<ChatState, { hop: number } | null> = {
  id: 'chatty',
  chaos: ['partition', 'delay', 'drop', 'duplicate', 'kill-node'],
  init: (nodeId, config) => {
    const ids = config.nodeIds;
    return { self: nodeId, next: ids[(ids.indexOf(nodeId) + 1) % ids.length], heard: 0 };
  },
  reduce: (state, event, rng) => {
    if (event.kind === 'init')
      return [state, [
        { type: 'send', to: state.next, payload: { hop: 1 } },
        { type: 'timer', delay: rng.int(1, 5), payload: null },
      ]];
    if (event.kind === 'message') {
      const { hop } = event.payload as { hop: number };
      return [{ ...state, heard: state.heard + 1 }, [{ type: 'send', to: state.next, payload: { hop: hop + 1 } }]];
    }
    if (event.kind === 'timer')
      return [state, [
        { type: 'send', to: state.next, payload: { hop: 0 } },
        { type: 'timer', delay: rng.int(1, 5), payload: null },
      ]];
    return [state, []];
  },
  metrics: (states) => {
    let sum = 0;
    for (const s of states.values()) sum += s.heard;
    return [{ name: 'messages-heard', value: sum }];
  },
  inspect: (s) => ({ ...s }) as InspectorTree,
};
```

- [ ] **Step 3: Write the failing simulation test**

Create `src/engine/sim.test.ts`:

```ts
import { expect, test } from 'vitest';
import { Simulation } from './sim';
import { counter, echo, chatty } from './fixtures';

test('timer effects fire in virtual time and advance the clock', () => {
  const sim = new Simulation({ module: counter, config: { nodeIds: ['a'] }, seed: 1 });
  sim.runUntil(100);
  expect(sim.getState('a').count).toBe(3);
  expect(sim.time).toBe(100); // clock advances to runUntil bound
  // init@0 + three timers@10/20/30
  expect(sim.eventLog.map((e) => [e.kind, e.time])).toEqual([
    ['init', 0],
    ['timer', 10],
    ['timer', 20],
    ['timer', 30],
  ]);
});

test('send effects deliver through the network with latency and from-field', () => {
  const sim = new Simulation({ module: echo, config: { nodeIds: ['a', 'b'] }, seed: 42 });
  sim.runUntil(100);
  expect(sim.getState('b').got).toEqual(['ping']);
  expect(sim.getState('a').got).toEqual(['pong']);
  const msg = sim.eventLog.find((e) => e.kind === 'message' && e.target === 'b')!;
  expect(msg.from).toBe('a');
  expect(msg.time).toBeGreaterThanOrEqual(1); // network latency applied
});

test('external() enqueues a user action at current virtual time', () => {
  const sim = new Simulation({ module: echo, config: { nodeIds: ['a', 'b'] }, seed: 1 });
  sim.runUntil(50);
  sim.external('a', { cmd: 'poke' });
  const before = sim.eventLog.length;
  sim.step();
  expect(sim.eventLog.length).toBe(before + 1);
  const e = sim.eventLog[sim.eventLog.length - 1];
  expect(e.kind).toBe('external');
  expect(e.time).toBe(50);
});

test('control kill: a dead node consumes events without reducing', () => {
  const sim = new Simulation({ module: echo, config: { nodeIds: ['a', 'b'] }, seed: 42 });
  sim.control({ type: 'kill', node: 'b' });
  sim.runUntil(100);
  expect(sim.getState('b').got).toEqual([]); // ping arrived but b was dead
  expect(sim.getState('a').got).toEqual([]); // so no pong either
});

test('control partition: cross-partition messages never arrive', () => {
  const sim = new Simulation({ module: echo, config: { nodeIds: ['a', 'b'] }, seed: 42 });
  sim.control({ type: 'partition', groups: [['a'], ['b']] });
  sim.runUntil(100);
  expect(sim.getState('b').got).toEqual([]);
});

test('processed counts every consumed event; pending exposes queue size', () => {
  const sim = new Simulation({ module: chatty, config: { nodeIds: ['a', 'b', 'c'] }, seed: 7 });
  expect(sim.pending).toBe(3); // three init events
  sim.runSteps(50);
  expect(sim.processed).toBe(50);
  expect(sim.pending).toBeGreaterThan(0); // chatty never goes quiet
});

test('getState throws for unknown node ids', () => {
  const sim = new Simulation({ module: counter, config: { nodeIds: ['a'] }, seed: 1 });
  expect(() => sim.getState('nope')).toThrow(/unknown node/);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run src/engine/sim.test.ts`
Expected: FAIL — `Cannot find module './sim'`.

- [ ] **Step 5: Implement the Simulation core**

Create `src/engine/sim.ts`:

```ts
import { EventQueue, type NodeId, type SimEvent } from './events';
import { SeededRng } from './rng';
import { SimNetwork, type NetworkOptions } from './network';
import type { Effect, ModuleConfig, ModuleEvent, SimModule } from './module';

/** Chaos & config actions. Enter the event queue like any user input. */
export type ControlAction =
  | { type: 'kill'; node: NodeId }
  | { type: 'revive'; node: NodeId }
  | { type: 'partition'; groups: NodeId[][] }
  | { type: 'heal' }
  | { type: 'net'; opts: Partial<NetworkOptions> };

export interface LoggedEvent {
  index: number;
  time: number;
  target: NodeId;
  kind: SimEvent['kind'];
  from?: NodeId;
  payload: unknown;
}

/** Reserved pseudo-target for engine-level control events. */
const CONTROL_TARGET = '#control';

export class Simulation<S, P = unknown> {
  readonly module: SimModule<S, P>;
  readonly config: ModuleConfig;
  readonly network: SimNetwork;
  readonly eventLog: LoggedEvent[] = [];
  time = 0;
  /** Number of events processed so far — the timeline position. */
  processed = 0;

  protected seq = 0;
  protected rng: SeededRng;
  protected queue = new EventQueue();
  protected states = new Map<NodeId, S>();
  protected dead = new Set<NodeId>();

  constructor(opts: {
    module: SimModule<S, P>;
    config: ModuleConfig;
    seed: number;
    network?: Partial<NetworkOptions>;
  }) {
    this.module = opts.module;
    this.config = opts.config;
    this.rng = new SeededRng(opts.seed);
    this.network = new SimNetwork(opts.network);
    for (const id of opts.config.nodeIds) {
      this.states.set(id, this.module.init(id, this.config, this.rng));
      this.schedule({ time: 0, target: id, kind: 'init', payload: null });
    }
  }

  protected schedule(e: Omit<SimEvent, 'seq'>): void {
    this.queue.push({ ...e, seq: this.seq++ });
  }

  /** User input path — enters the queue at current virtual time (DESIGN_PLAN §5). */
  external(target: NodeId, payload: unknown): void {
    this.schedule({ time: this.time, target, kind: 'external', payload });
  }

  /** Chaos path — same rule: recorded, replayable. */
  control(action: ControlAction): void {
    this.schedule({ time: this.time, target: CONTROL_TARGET, kind: 'control', payload: action });
  }

  getState(id: NodeId): S {
    const s = this.states.get(id);
    if (s === undefined) throw new Error(`unknown node: ${id}`);
    return s;
  }

  get pending(): number {
    return this.queue.size;
  }

  /** Process exactly one event. Returns its log entry, or undefined if idle. */
  step(): LoggedEvent | undefined {
    const e = this.queue.pop();
    if (!e) return undefined;
    this.time = e.time;
    const logged: LoggedEvent = {
      index: this.processed,
      time: e.time,
      target: e.target,
      kind: e.kind,
      from: e.from,
      payload: e.payload,
    };
    this.eventLog.push(logged);
    this.processed++;

    if (e.kind === 'control') {
      this.applyControl(e.payload as ControlAction);
      return logged;
    }
    if (!this.dead.has(e.target)) {
      const mev: ModuleEvent<P> = {
        kind: e.kind as ModuleEvent<P>['kind'],
        self: e.target,
        from: e.from,
        payload: e.payload as P,
      };
      const [next, effects] = this.module.reduce(this.states.get(e.target)!, mev, this.rng);
      this.states.set(e.target, next);
      for (const ef of effects) this.applyEffect(e.target, ef);
    }
    return logged;
  }

  protected applyControl(a: ControlAction): void {
    switch (a.type) {
      case 'kill':
        this.dead.add(a.node);
        break;
      case 'revive':
        this.dead.delete(a.node);
        break;
      case 'partition':
        this.network.partition(a.groups);
        break;
      case 'heal':
        this.network.heal();
        break;
      case 'net':
        Object.assign(this.network.opts, a.opts);
        break;
    }
  }

  protected applyEffect(self: NodeId, ef: Effect): void {
    if (ef.type === 'timer') {
      this.schedule({ time: this.time + ef.delay, target: self, kind: 'timer', payload: ef.payload });
    } else {
      for (const d of this.network.plan(self, ef.to, this.rng)) {
        this.schedule({ time: this.time + d.delay, target: ef.to, kind: 'message', from: self, payload: ef.payload });
      }
    }
  }

  runSteps(n: number): void {
    for (let i = 0; i < n && this.queue.size > 0; i++) this.step();
  }

  /** Process all events with time <= t, then advance the clock to t. */
  runUntil(t: number): void {
    for (let next = this.queue.peek(); next && next.time <= t; next = this.queue.peek()) this.step();
    this.time = Math.max(this.time, t);
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/engine/sim.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 7: Run full suite, lint, typecheck**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all PASS/clean.

- [ ] **Step 8: Commit**

```bash
git add src/engine/module.ts src/engine/sim.ts src/engine/fixtures.ts src/engine/sim.test.ts
git commit -m "feat(engine): SimModule contract v0.1 and discrete-event Simulation core"
```

---

### Task 6: Event-Log Hash & Determinism Guarantee

**Files:**
- Create: `src/engine/hash.ts`
- Test: `src/engine/hash.test.ts`, `src/engine/determinism.test.ts`

**Interfaces:**
- Consumes: `LoggedEvent` (Task 5), `Simulation` + `chatty` fixture (Task 5).
- Produces: `fnv1a(str: string, hash?: number): number` and `hashEventLog(log: readonly LoggedEvent[]): string` (8-char lowercase hex) — used by recorder tests (Task 7) and property tests (Task 9).

- [ ] **Step 1: Write the failing hash test**

Create `src/engine/hash.test.ts`:

```ts
import { expect, test } from 'vitest';
import { fnv1a, hashEventLog } from './hash';
import type { LoggedEvent } from './sim';

test('fnv1a matches known 32-bit FNV-1a vectors', () => {
  expect(fnv1a('').toString(16)).toBe('811c9dc5');
  expect(fnv1a('a').toString(16)).toBe('e40c292c');
  expect(fnv1a('foobar').toString(16)).toBe('bf9cf968');
});

test('hashEventLog is order- and content-sensitive', () => {
  const e = (index: number, payload: unknown): LoggedEvent => ({
    index,
    time: index * 10,
    target: 'a',
    kind: 'message',
    payload,
  });
  const h1 = hashEventLog([e(0, 'x'), e(1, 'y')]);
  const h2 = hashEventLog([e(0, 'y'), e(1, 'x')]);
  const h3 = hashEventLog([e(0, 'x'), e(1, 'y')]);
  expect(h1).not.toBe(h2);
  expect(h1).toBe(h3);
  expect(h1).toMatch(/^[0-9a-f]{8}$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/hash.test.ts`
Expected: FAIL — `Cannot find module './hash'`.

- [ ] **Step 3: Implement the hash**

Create `src/engine/hash.ts`:

```ts
import type { LoggedEvent } from './sim';

/** 32-bit FNV-1a. Pass the previous return value as `hash` to chain. */
export function fnv1a(str: string, hash = 0x811c9dc5): number {
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Deterministic fingerprint of a run. Payload key order is stable because
 * replays construct payloads through identical code paths.
 */
export function hashEventLog(log: readonly LoggedEvent[]): string {
  let h = 0x811c9dc5;
  for (const e of log) {
    h = fnv1a(`${e.index}|${e.time}|${e.target}|${e.kind}|${e.from ?? ''}|${JSON.stringify(e.payload)}`, h);
  }
  return h.toString(16).padStart(8, '0');
}
```

- [ ] **Step 4: Run hash test to verify it passes**

Run: `npx vitest run src/engine/hash.test.ts`
Expected: 2 tests PASS.

- [ ] **Step 5: Write the DoD determinism test (100 runs, with chaos actions)**

Create `src/engine/determinism.test.ts`:

```ts
import { expect, test } from 'vitest';
import { Simulation } from './sim';
import { hashEventLog } from './hash';
import { chatty } from './fixtures';

const run = (seed: number): string => {
  const sim = new Simulation({
    module: chatty,
    config: { nodeIds: ['a', 'b', 'c'] },
    seed,
    network: { latency: [1, 10], dropRate: 0.05, duplicateRate: 0.05 },
  });
  sim.runSteps(500);
  sim.control({ type: 'partition', groups: [['a'], ['b', 'c']] });
  sim.runSteps(500);
  sim.control({ type: 'heal' });
  sim.runSteps(1000);
  return hashEventLog(sim.eventLog);
};

test('DoD: same seed + same action sequence → identical hash across 100 runs', () => {
  const first = run(42);
  for (let i = 0; i < 99; i++) expect(run(42)).toBe(first);
});

test('different seeds diverge', () => {
  expect(run(1)).not.toBe(run(2));
});
```

- [ ] **Step 6: Run determinism test to verify it passes**

Run: `npx vitest run src/engine/determinism.test.ts`
Expected: 2 tests PASS (if the 100-run test fails, there is nondeterminism in the core — find it, do not weaken the test).

- [ ] **Step 7: Commit**

```bash
git add src/engine/hash.ts src/engine/hash.test.ts src/engine/determinism.test.ts
git commit -m "feat(engine): FNV-1a event-log hash + 100-run determinism guarantee"
```

---

### Task 7: Snapshot/Restore & TimelineRecorder (scrubbing)

**Files:**
- Modify: `src/engine/sim.ts` (add `SimSnapshot`, `snapshot()`, `restore()`)
- Create: `src/engine/recorder.ts`
- Test: `src/engine/recorder.test.ts`

**Interfaces:**
- Consumes: `Simulation`, `chatty`, `hashEventLog` from earlier tasks.
- Produces:
  - `interface SimSnapshot` (opaque to callers) and `Simulation.snapshot(): SimSnapshot` / `Simulation.restore(s: SimSnapshot): void`.
  - `class TimelineRecorder<S, P> { constructor(sim: Simulation<S, P>, interval?: number); readonly sim: Simulation<S, P>; step(): boolean; runSteps(n: number): void; get position(): number; scrubTo(index: number): void; invalidateFuture(): void }` — `scrubTo` lands so that exactly `index` events have been processed.

- [ ] **Step 1: Write the failing test**

Create `src/engine/recorder.test.ts`:

```ts
import { expect, test } from 'vitest';
import { Simulation } from './sim';
import { TimelineRecorder } from './recorder';
import { hashEventLog } from './hash';
import { chatty } from './fixtures';

const mk = () =>
  new Simulation({
    module: chatty,
    config: { nodeIds: ['a', 'b', 'c'] },
    seed: 7,
    network: { latency: [1, 10], dropRate: 0.05, duplicateRate: 0.05 },
  });

test('snapshot/restore resumes identically', () => {
  const sim = mk();
  sim.runSteps(300);
  const snap = sim.snapshot();
  sim.runSteps(200);
  const hashAhead = hashEventLog(sim.eventLog);
  sim.restore(snap);
  expect(sim.processed).toBe(300);
  sim.runSteps(200);
  expect(hashEventLog(sim.eventLog)).toBe(hashAhead);
});

test('scrubTo(k) reproduces exactly a fresh k-step run, back and forward', () => {
  const rec = new TimelineRecorder(mk(), 100);
  rec.runSteps(2500);
  const hashFull = hashEventLog(rec.sim.eventLog);

  rec.scrubTo(1234); // backward
  const fresh = mk();
  fresh.runSteps(1234);
  expect(rec.position).toBe(1234);
  expect(hashEventLog(rec.sim.eventLog)).toBe(hashEventLog(fresh.eventLog));
  expect(rec.sim.getState('b')).toEqual(fresh.getState('b'));

  rec.scrubTo(2500); // forward again
  expect(rec.position).toBe(2500);
  expect(hashEventLog(rec.sim.eventLog)).toBe(hashFull);
});

test('diverging after a backward scrub: invalidateFuture keeps scrubbing correct', () => {
  const rec = new TimelineRecorder(mk(), 100);
  rec.runSteps(1000);
  rec.scrubTo(250);
  rec.sim.control({ type: 'partition', groups: [['a'], ['b', 'c']] });
  rec.invalidateFuture();
  rec.runSteps(500);
  expect(rec.position).toBe(750);

  rec.scrubTo(600);
  const fresh = mk();
  fresh.runSteps(250);
  fresh.control({ type: 'partition', groups: [['a'], ['b', 'c']] });
  fresh.runSteps(350);
  expect(hashEventLog(rec.sim.eventLog)).toBe(hashEventLog(fresh.eventLog));
});

test('DoD: scrub across 10k events lands anywhere in under 100ms', () => {
  const rec = new TimelineRecorder(mk(), 500);
  rec.runSteps(10_000);
  for (const target of [9_999, 5_000, 1, 7_777, 0]) {
    const t0 = performance.now();
    rec.scrubTo(target);
    const dt = performance.now() - t0;
    expect(rec.position).toBe(target);
    expect(dt).toBeLessThan(100);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/recorder.test.ts`
Expected: FAIL — `Cannot find module './recorder'` (and `snapshot` missing on Simulation).

- [ ] **Step 3: Add snapshot/restore to Simulation**

In `src/engine/sim.ts`, add after the `LoggedEvent` interface:

```ts
import type { NetworkSnapshot } from './network';

export interface SimSnapshot {
  time: number;
  seq: number;
  processed: number;
  rngState: number;
  heap: SimEvent[];
  states: [NodeId, unknown][];
  dead: NodeId[];
  network: NetworkSnapshot;
  logLength: number;
}
```

(Merge the `NetworkSnapshot` import into the existing `./network` import line.)

Add these methods at the bottom of the `Simulation` class:

```ts
  /** Full deep-copied state of the sim — everything replay needs. */
  snapshot(): SimSnapshot {
    return structuredClone({
      time: this.time,
      seq: this.seq,
      processed: this.processed,
      rngState: this.rng.getState(),
      heap: this.queue.toArray(),
      states: [...this.states.entries()],
      dead: [...this.dead],
      network: this.network.snapshot(),
      logLength: this.eventLog.length,
    }) as SimSnapshot;
  }

  restore(s: SimSnapshot): void {
    const c = structuredClone(s) as SimSnapshot;
    this.time = c.time;
    this.seq = c.seq;
    this.processed = c.processed;
    this.rng.setState(c.rngState);
    this.queue.loadFrom(c.heap);
    this.states = new Map(c.states as [NodeId, S][]);
    this.dead = new Set(c.dead);
    this.network.restore(c.network);
    this.eventLog.length = c.logLength; // future entries are re-derived on replay
  }
```

- [ ] **Step 4: Implement TimelineRecorder**

Create `src/engine/recorder.ts`:

```ts
import type { Simulation, SimSnapshot } from './sim';

/**
 * Hybrid scrubbing (DESIGN_PLAN §5): snapshot every `interval` processed
 * events; scrubbing restores the nearest snapshot <= target and replays
 * deterministically the rest of the way.
 */
export class TimelineRecorder<S, P = unknown> {
  private snapshots: { index: number; snap: SimSnapshot }[] = [];

  constructor(
    readonly sim: Simulation<S, P>,
    private interval = 500,
  ) {
    this.snapshots.push({ index: sim.processed, snap: sim.snapshot() });
  }

  get position(): number {
    return this.sim.processed;
  }

  /** Step once, snapshotting on interval boundaries. Returns false when idle. */
  step(): boolean {
    if (!this.sim.step()) return false;
    const at = this.sim.processed;
    if (at % this.interval === 0 && !this.snapshots.some((s) => s.index === at)) {
      this.snapshots.push({ index: at, snap: this.sim.snapshot() });
    }
    return true;
  }

  runSteps(n: number): void {
    for (let i = 0; i < n; i++) if (!this.step()) break;
  }

  /** Land so that exactly `index` events have been processed. */
  scrubTo(index: number): void {
    if (index >= this.sim.processed) {
      while (this.sim.processed < index && this.step()) {
        /* forward replay */
      }
      return;
    }
    let base = this.snapshots[0];
    for (const s of this.snapshots) {
      if (s.index <= index) base = s;
      else break;
    }
    this.sim.restore(base.snap);
    while (this.sim.processed < index && this.sim.step()) {
      /* replay from snapshot */
    }
  }

  /**
   * Call after injecting external()/control() following a backward scrub —
   * the previously recorded future is no longer this timeline's future.
   */
  invalidateFuture(): void {
    this.snapshots = this.snapshots.filter((s) => s.index <= this.sim.processed);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/engine/recorder.test.ts`
Expected: 4 tests PASS, including the < 100ms DoD benchmark.

- [ ] **Step 6: Run full suite, lint, typecheck**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all PASS/clean.

- [ ] **Step 7: Commit**

```bash
git add src/engine/sim.ts src/engine/recorder.ts src/engine/recorder.test.ts
git commit -m "feat(engine): sim snapshot/restore + hybrid snapshot-replay timeline scrubbing"
```

---

### Task 8: Ping-Pong Module (contract validation)

**Files:**
- Create: `src/modules/pingpong.ts`
- Test: `src/modules/pingpong.test.ts`

**Interfaces:**
- Consumes: `SimModule`, `Effect`, `ModuleEvent`, `InspectorTree` (Task 5), `NodeId` (Task 3), `Simulation` (Task 5).
- Produces: `pingPong: SimModule<PPState, PPPayload>` and `interface PPState { self: NodeId; next: NodeId; starter: boolean; lastDelivered: number; pendingToken: number | null }` — used by property tests (Task 9). Protocol: token ring with retransmission (50ms timer) and dedupe by token number.

- [ ] **Step 1: Write the failing test**

Create `src/modules/pingpong.test.ts`:

```ts
import { expect, test } from 'vitest';
import { Simulation } from '../engine/sim';
import { pingPong } from './pingpong';

const NODES = ['n0', 'n1', 'n2'];
const mk = (opts: { seed?: number; drop?: number; dup?: number } = {}) =>
  new Simulation({
    module: pingPong,
    config: { nodeIds: NODES },
    seed: opts.seed ?? 42,
    network: { latency: [1, 10], dropRate: opts.drop ?? 0, duplicateRate: opts.dup ?? 0 },
  });

test('token circulates the ring on a clean network', () => {
  const sim = mk();
  sim.runUntil(1000);
  for (const id of NODES) expect(sim.getState(id).lastDelivered).toBeGreaterThan(5);
});

test('duplicates are ignored and the ring still advances', () => {
  const sim = mk({ dup: 0.5 });
  sim.runUntil(2000);
  for (const id of NODES) expect(sim.getState(id).lastDelivered).toBeGreaterThan(5);
});

test('retransmission recovers from drops', () => {
  const sim = mk({ drop: 0.3 });
  sim.runUntil(10_000);
  const max = Math.max(...NODES.map((id) => sim.getState(id).lastDelivered));
  expect(max).toBeGreaterThan(10);
});

test('a partitioned ring stops making progress, then resumes after heal', () => {
  const sim = mk();
  sim.runUntil(500);
  const before = Math.max(...NODES.map((id) => sim.getState(id).lastDelivered));
  sim.control({ type: 'partition', groups: [['n0'], ['n1', 'n2']] });
  sim.runUntil(1500);
  const during = Math.max(...NODES.map((id) => sim.getState(id).lastDelivered));
  expect(during - before).toBeLessThanOrEqual(2); // at most in-flight remnants
  sim.control({ type: 'heal' });
  sim.runUntil(3000);
  const after = Math.max(...NODES.map((id) => sim.getState(id).lastDelivered));
  expect(after).toBeGreaterThan(during + 5); // retransmit revives the token
});

test('metrics and inspect implement the contract', () => {
  const sim = mk();
  sim.runUntil(500);
  const states = new Map(NODES.map((id) => [id, sim.getState(id)]));
  const metrics = pingPong.metrics(states);
  expect(metrics.map((m) => m.name)).toEqual(['max-token', 'total-delivered']);
  expect(metrics[0].value).toBeGreaterThan(0);
  expect(pingPong.inspect(sim.getState('n0'))).toMatchObject({ self: 'n0' });
  expect(pingPong.chaos).toContain('partition');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/pingpong.test.ts`
Expected: FAIL — `Cannot find module './pingpong'`.

- [ ] **Step 3: Implement the ping-pong module**

Create `src/modules/pingpong.ts`:

```ts
import type { NodeId } from '../engine/events';
import type { Effect, InspectorTree, SimModule } from '../engine/module';

/**
 * Token ring with retransmission — the Phase 0 engine demo (DESIGN_PLAN §7).
 * Node 0 starts token 1; each node delivers a token once (dedupe by number),
 * forwards token+1, and retransmits its last send every RETRANSMIT_MS until
 * a higher token comes back around the ring.
 */
export interface PPState {
  self: NodeId;
  next: NodeId;
  starter: boolean;
  /** Highest token this node has processed. */
  lastDelivered: number;
  /** Token sent but not yet confirmed by ring progress. */
  pendingToken: number | null;
}

export type PPPayload = { token: number } | { retransmit: number } | null;

const RETRANSMIT_MS = 50;

function sendToken(state: PPState, token: number): [PPState, Effect[]] {
  return [
    { ...state, pendingToken: token },
    [
      { type: 'send', to: state.next, payload: { token } },
      { type: 'timer', delay: RETRANSMIT_MS, payload: { retransmit: token } },
    ],
  ];
}

export const pingPong: SimModule<PPState, PPPayload> = {
  id: 'ping-pong',
  chaos: ['kill-node', 'partition', 'delay', 'drop', 'duplicate'],

  init(nodeId, config) {
    const ids = config.nodeIds;
    const i = ids.indexOf(nodeId);
    return {
      self: nodeId,
      next: ids[(i + 1) % ids.length],
      starter: i === 0,
      lastDelivered: 0,
      pendingToken: null,
    };
  },

  reduce(state, event): [PPState, Effect[]] {
    switch (event.kind) {
      case 'init': {
        if (!state.starter) return [state, []];
        return sendToken(state, 1);
      }
      case 'message': {
        const { token } = event.payload as { token: number };
        if (token <= state.lastDelivered) return [state, []]; // duplicate or stale
        const cleared =
          state.pendingToken !== null && token > state.pendingToken
            ? { ...state, pendingToken: null }
            : state;
        return sendToken({ ...cleared, lastDelivered: token }, token + 1);
      }
      case 'timer': {
        const { retransmit } = event.payload as { retransmit: number };
        if (state.pendingToken !== retransmit) return [state, []]; // superseded
        return [
          state,
          [
            { type: 'send', to: state.next, payload: { token: retransmit } },
            { type: 'timer', delay: RETRANSMIT_MS, payload: { retransmit } },
          ],
        ];
      }
      default:
        return [state, []];
    }
  },

  metrics(states) {
    let max = 0;
    let sum = 0;
    for (const s of states.values()) {
      max = Math.max(max, s.lastDelivered);
      sum += s.lastDelivered;
    }
    return [
      { name: 'max-token', value: max },
      { name: 'total-delivered', value: sum },
    ];
  },

  inspect(state) {
    return { ...state } as InspectorTree;
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/pingpong.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/pingpong.ts src/modules/pingpong.test.ts
git commit -m "feat(modules): ping-pong token ring validating SimModule contract v0.1"
```

---

### Task 9: Property-Based Tests (fast-check)

**Files:**
- Test: `src/modules/pingpong.property.test.ts`

**Interfaces:**
- Consumes: `Simulation`, `hashEventLog`, `pingPong` from earlier tasks; `fast-check` (installed Task 1).
- Produces: the DoD guarantee "ping-pong passes property tests under random delay/drop/reorder/duplicate + partition/heal".

- [ ] **Step 1: Write the failing property tests**

Create `src/modules/pingpong.property.test.ts`:

```ts
import { describe, test } from 'vitest';
import fc from 'fast-check';
import { Simulation } from '../engine/sim';
import { hashEventLog } from '../engine/hash';
import { pingPong } from './pingpong';

const NODES = ['n0', 'n1', 'n2'];
// Fixed fc seed: reproducible in CI; bump numRuns locally when hunting bugs.
const FC = { seed: 20260708, numRuns: 25 };

describe('ping-pong properties', () => {
  test('determinism: same seed + same chaos schedule → same hash', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2 ** 31 - 1 }),
        fc.double({ min: 0, max: 0.3, noNaN: true }),
        fc.double({ min: 0, max: 0.3, noNaN: true }),
        (seed, drop, dup) => {
          const run = () => {
            const sim = new Simulation({
              module: pingPong,
              config: { nodeIds: NODES },
              seed,
              network: { latency: [1, 20], dropRate: drop, duplicateRate: dup },
            });
            sim.runSteps(1000);
            sim.control({ type: 'partition', groups: [['n0'], ['n1', 'n2']] });
            sim.runSteps(500);
            sim.control({ type: 'heal' });
            sim.runSteps(1500);
            return hashEventLog(sim.eventLog);
          };
          return run() === run();
        },
      ),
      FC,
    );
  });

  test('safety: delivered tokens never regress on any node, under any drop/dup mix', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2 ** 31 - 1 }),
        fc.double({ min: 0, max: 0.4, noNaN: true }),
        fc.double({ min: 0, max: 0.4, noNaN: true }),
        (seed, drop, dup) => {
          const sim = new Simulation({
            module: pingPong,
            config: { nodeIds: NODES },
            seed,
            network: { latency: [1, 30], dropRate: drop, duplicateRate: dup },
          });
          const last: Record<string, number> = { n0: 0, n1: 0, n2: 0 };
          for (let i = 0; i < 3000; i++) {
            if (!sim.step()) break;
            for (const id of NODES) {
              const d = sim.getState(id).lastDelivered;
              if (d < last[id]) return false; // regression = engine or dedupe bug
              last[id] = d;
            }
          }
          return true;
        },
      ),
      FC,
    );
  });

  test('progress: with a clean network the token keeps circulating', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), (seed) => {
        const sim = new Simulation({
          module: pingPong,
          config: { nodeIds: NODES },
          seed,
          network: { latency: [1, 10], dropRate: 0, duplicateRate: 0 },
        });
        sim.runUntil(5000);
        const max = Math.max(...NODES.map((id) => sim.getState(id).lastDelivered));
        return max >= 20; // ~166 rounds expected; 20 is a safe floor
      }),
      FC,
    );
  });
});
```

- [ ] **Step 2: Run the properties**

Run: `npx vitest run src/modules/pingpong.property.test.ts`
Expected: 3 tests PASS. If fast-check reports a counterexample, it prints the shrunk `(seed, drop, dup)` tuple — reproduce it in a scratch unit test with those exact values and fix the engine/module before continuing. Do not raise the floors or shrink the ranges to make it pass.

- [ ] **Step 3: Commit**

```bash
git add src/modules/pingpong.property.test.ts
git commit -m "test(modules): property-based chaos tests for ping-pong (fast-check)"
```

---

### Task 10: Public API, Coverage Gate, Docs Sync & DoD Verification

**Files:**
- Create: `src/engine/index.ts`, `README.md`
- Modify: `vitest.config.ts` (coverage thresholds), `docs/DESIGN_PLAN.md` §5, `docs/DESIGN_PLAN.en.md` §5
- Delete: `src/engine/toolchain.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `src/engine/index.ts` as the single import surface Phase 1 will use.

- [ ] **Step 1: Write the public API barrel**

Create `src/engine/index.ts`:

```ts
export { SeededRng } from './rng';
export { EventQueue } from './events';
export type { SimEvent, NodeId } from './events';
export { SimNetwork } from './network';
export type { NetworkOptions, NetworkSnapshot, Delivery } from './network';
export type {
  SimModule,
  ModuleConfig,
  ModuleEvent,
  Effect,
  ChaosCapability,
  MetricSample,
  InspectorTree,
} from './module';
export { Simulation } from './sim';
export type { ControlAction, LoggedEvent, SimSnapshot } from './sim';
export { TimelineRecorder } from './recorder';
export { fnv1a, hashEventLog } from './hash';
```

- [ ] **Step 2: Enable the coverage gate**

Replace `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
```

- [ ] **Step 3: Remove the toolchain sanity test**

```bash
git rm src/engine/toolchain.test.ts
```

- [ ] **Step 4: Run the coverage gate**

Run: `npm run coverage`
Expected: all tests PASS, coverage ≥ 80% on every metric. If a file is under, add unit tests for its uncovered branches (likely candidates: `EventQueue.pop` right-child branch, `SimNetwork.restore`, `applyControl` revive/net arms) — do not lower thresholds.

- [ ] **Step 5: Write the README**

Create `README.md`:

```markdown
# DDIA Visualized

Interactive learning labs that turn "Designing Data-Intensive Applications"
into browser simulations you can break: kill nodes, partition networks,
reorder messages — and watch what happens to your data.

Design: [`docs/DESIGN_PLAN.en.md`](docs/DESIGN_PLAN.en.md) (Vietnamese original: [`docs/DESIGN_PLAN.md`](docs/DESIGN_PLAN.md)).

## Status

Phase 0 — deterministic simulation engine (`src/engine/`): discrete-event
loop with a virtual clock, seeded RNG, chaos-capable SimNetwork,
snapshot/replay timeline scrubbing, and the `SimModule` plug-in contract.
Demo module: a token ring with retransmission (`src/modules/pingpong.ts`).

## Develop

    npm install
    npm test            # unit + property tests
    npm run coverage    # with 80% gate
    npm run lint
    npm run typecheck
```

- [ ] **Step 6: Sync the contract refinements back into the design docs**

In `docs/DESIGN_PLAN.md` §5, replace the `interface SimModule<S, E>` code block with:

```ts
interface SimModule<S, P> {
  id: string;                                       // 'lsm-tree' | 'raft' | ...
  chaos: ChaosCapability[];                         // vocabulary lab này hỗ trợ
  init(nodeId: NodeId, config: ModuleConfig, rng: SeededRng): S;
  reduce(state: S, event: ModuleEvent<P>, rng: SeededRng): [S, Effect[]]; // pure
  metrics(states: Map<NodeId, S>): MetricSample[];  // số đếm được cho panel
  inspect(state: S): InspectorTree;                 // state expose cho renderer
}
```

and change the preceding sentence's "Draft v0:" to "v0.1 (đã validate bằng engine Phase 0, `src/engine/module.ts`):".

In `docs/DESIGN_PLAN.en.md` §5, replace the same block with:

```ts
interface SimModule<S, P> {
  id: string;                                       // 'lsm-tree' | 'raft' | ...
  chaos: ChaosCapability[];                         // the vocabulary this lab supports
  init(nodeId: NodeId, config: ModuleConfig, rng: SeededRng): S;
  reduce(state: S, event: ModuleEvent<P>, rng: SeededRng): [S, Effect[]]; // pure
  metrics(states: Map<NodeId, S>): MetricSample[];  // countable numbers for the panel
  inspect(state: S): InspectorTree;                 // state exposed to the renderer
}
```

and change its preceding "Draft v0:" to "v0.1 (validated by the Phase 0 engine, `src/engine/module.ts`):".

- [ ] **Step 7: Full DoD verification run**

Run: `npm run coverage && npm run lint && npm run typecheck`
Expected: everything green. Then confirm each DoD row from the Global Constraints table maps to a passing test:
- determinism → `src/engine/determinism.test.ts`
- scrub < 100ms → `src/engine/recorder.test.ts` ("DoD: scrub across 10k events…")
- property tests → `src/modules/pingpong.property.test.ts`
- lint isolation → `npm run lint` (rule active on `src/engine/**`, `src/modules/**`)
- contract validated → `src/modules/pingpong.test.ts`
- coverage ≥ 80% → threshold gate in `vitest.config.ts`

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(engine): public API barrel, coverage gate, README, contract v0.1 doc sync"
```

---

## Self-Review Notes

- **Spec coverage:** every Phase 0 deliverable from DESIGN_PLAN §7 (event loop, virtual clock, seeded RNG, SimNetwork with delay/drop/partition, timeline recorder, module contract v0, ping-pong demo) has a dedicated task; every §9 Phase 0 DoD row is mapped in the Global Constraints table.
- **Type consistency check:** `SimModule<S, P>` generics, `ModuleEvent<P>`, `Effect`, `ControlAction`, `SimSnapshot`, `NetworkSnapshot`, and `TimelineRecorder` signatures are identical across Tasks 5–10 and match the barrel exports in Task 10.
- **Known deviations from DESIGN_PLAN §5 draft contract** (synced back to docs in Task 10 Step 6): `init` gains `nodeId`; `reduce` gains the sim `SeededRng` (its state is snapshot-captured, so determinism holds); `metrics` receives all node states.
- **Deliberate scope cuts (YAGNI, Phase 1+):** clock-skew chaos (capability enum exists, no engine behavior yet — Ch8 lab needs it), storage-chaos behaviors (Ch3 lab), Web Worker hosting, action-log JSON export/import file format, URL scenario encoding, any UI.
