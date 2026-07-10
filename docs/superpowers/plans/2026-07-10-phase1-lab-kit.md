# Phase 1 v2 — Lab Kit + Replication Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first interactive lab in the browser — reusable Lab Kit UI + leader-follower replication module + engine-verified "stale read" chaos challenge — deployed to GitHub Pages.

**Architecture:** The Phase 0 deterministic engine (`src/engine/`) gains three small contract-v0.2 additions pulled by UI need (`inFlight()`, `delivered` flag, event/metrics time). A one-directional bridge (`SimDriver` rAF loop → Zustand store → React selectors) feeds four reusable kit components, proven first on the existing ping-pong module, then consumed by the new replication lab. Spec: `docs/superpowers/specs/2026-07-10-phase1-lab-kit-design.md`.

**Tech Stack:** Existing: TypeScript strict, Vitest, fast-check, ESLint flat config. New: Vite, React 19, Tailwind v4, Zustand, `motion`, Recharts, MDX (`@mdx-js/rollup`), jsdom + @testing-library/react (UI tests), GitHub Actions (CI + Pages deploy).

## Global Constraints

- Working directory: `/home/elgnas/Projects/Personal/ddia-visualized` (all paths relative).
- TypeScript `strict: true`; `"type": "module"`; Node ≥ 20.
- `src/engine/**` and `src/modules/**` must never import React/DOM/zustand/motion **or anything under `src/ui/`** (ESLint-enforced; this plan extends the fence).
- No `Math.random`, `Date.now`, `setTimeout`, `setInterval` in engine/modules. UI layer (`src/ui/**`) MAY use `requestAnimationFrame`, `Date.now`, `localStorage`.
- Module state stays plain JSON-serializable (no `Map`/`Set`/class instances inside module state).
- Coverage gate ≥ 80% applies to `src/engine/**` + `src/modules/**` only (UI excluded from the gate this phase — DoD wording is "sim core coverage").
- Persistence: `localStorage` + file export only (DESIGN_PLAN §1 Non-goals).
- Story mode is OUT — do not build walkthrough scaffolding.
- Conventional commit messages.
- Committing `.github/workflows/` is explicitly approved (user cleared the git-policy exception; no secrets in workflows).
- Creating/pushing the public GitHub repo (Task 15) requires explicit user confirmation at execution time — outward-facing action.

**Phase 1 DoD v2 → task mapping:**

| DoD item | Task |
|---|---|
| Replication lab sandbox + chaos in browser | 9–11 |
| "Stale read" challenge, engine-verified | 10, 12 |
| MetricsPanel ≥ 3 live numbers | 8, 9 |
| Predict-before-run + journal persist across reload | 12, 13 |
| Property test: sync-acked write survives follower death | 10 |
| CI green: typecheck + lint + coverage + scrub benchmark | 4 |
| Bundle ≤ 500 KB gzip | 15 |
| Site live on GitHub Pages | 15 |

---

### Task 1: Engine — `inFlight()` accessor + `sentAt` on messages

**Files:**
- Modify: `src/engine/events.ts` (SimEvent gains optional `sentAt`)
- Modify: `src/engine/sim.ts` (set `sentAt` in `applyEffect`; add `inFlight()`)
- Modify: `src/engine/index.ts` (export `InFlightMessage`)
- Test: `src/engine/inflight.test.ts`

**Interfaces:**
- Consumes: existing `Simulation`, `EventQueue.toArray()`, `pingPong` module.
- Produces: `sim.inFlight(): InFlightMessage[]` where `InFlightMessage = { from: NodeId; target: NodeId; sentAt: number; deliverAt: number; payload: unknown }`, sorted by `(deliverAt, sentAt)`. Task 6 (SimDriver) and Task 7 (ClusterView) rely on this exact shape.

- [ ] **Step 1: Write the failing test**

```ts
// src/engine/inflight.test.ts
import { expect, test } from 'vitest';
import { Simulation } from './sim';
import { pingPong, type PPPayload, type PPState } from '../modules/pingpong';

function makeSim(): Simulation<PPState, PPPayload> {
  return new Simulation({ module: pingPong, config: { nodeIds: ['a', 'b', 'c'] }, seed: 7 });
}

test('inFlight lists undelivered messages with send/deliver times', () => {
  const sim = makeSim();
  sim.runSteps(3); // three init events; starter 'a' sent token 1 to 'b'
  const inf = sim.inFlight();
  expect(inf).toHaveLength(1); // the retransmit timer is NOT in the list
  expect(inf[0]).toMatchObject({ from: 'a', target: 'b', sentAt: 0 });
  expect(inf[0].deliverAt).toBeGreaterThanOrEqual(1);
  expect(inf[0].payload).toEqual({ token: 1 });
});

test('inFlight advances as messages deliver', () => {
  const sim = makeSim();
  sim.runSteps(4); // inits + deliver token1 to b -> b sends token2 to c
  expect(sim.inFlight().some((m) => m.from === 'b' && m.target === 'c')).toBe(true);
});

test('inFlight returns deep copies — mutating a payload does not corrupt the sim', () => {
  const sim = makeSim();
  sim.runSteps(3);
  const inf = sim.inFlight();
  (inf[0].payload as { token: number }).token = 999;
  expect((sim.inFlight()[0].payload as { token: number }).token).toBe(1);
});

test('inFlight is sorted by deliverAt', () => {
  const sim = makeSim();
  sim.runSteps(6);
  const times = sim.inFlight().map((m) => m.deliverAt);
  expect(times).toEqual([...times].sort((x, y) => x - y));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/inflight.test.ts`
Expected: FAIL — `sim.inFlight is not a function`.

- [ ] **Step 3: Implement**

In `src/engine/events.ts`, add to `SimEvent` (after the `from?` field):

```ts
  from?: NodeId;
  /** Virtual time the message was sent (kind 'message' only). */
  sentAt?: number;
```

In `src/engine/sim.ts`:

Add after the `SimSnapshot` interface:

```ts
/** A scheduled-but-undelivered message — the renderer's "dots in flight". */
export interface InFlightMessage {
  from: NodeId;
  target: NodeId;
  sentAt: number;
  deliverAt: number;
  payload: unknown;
}
```

In `applyEffect`, change the message scheduling line to include `sentAt`:

```ts
      for (const d of this.network.plan(self, ef.to, this.rng)) {
        this.schedule({
          time: this.time + d.delay,
          target: ef.to,
          kind: 'message',
          from: self,
          sentAt: this.time,
          payload: ef.payload,
        });
      }
```

Add the accessor after `get pending()`:

```ts
  /** Read-only view of undelivered messages, sorted by delivery time. */
  inFlight(): InFlightMessage[] {
    return this.queue
      .toArray()
      .filter((e) => e.kind === 'message')
      .map((e) => ({
        from: e.from!,
        target: e.target,
        sentAt: e.sentAt ?? e.time,
        deliverAt: e.time,
        payload: structuredClone(e.payload),
      }))
      .sort((a, b) => a.deliverAt - b.deliverAt || a.sentAt - b.sentAt);
  }
```

In `src/engine/index.ts`, extend the sim type export line:

```ts
export type { ControlAction, LoggedEvent, SimSnapshot, InFlightMessage } from './sim';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/inflight.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Full suite, lint, typecheck**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all green (snapshot/restore round-trips `sentAt` automatically via `structuredClone`).

- [ ] **Step 6: Commit**

```bash
git add src/engine/events.ts src/engine/sim.ts src/engine/index.ts src/engine/inflight.test.ts
git commit -m "feat(engine): inFlight() accessor with sentAt for message-dot rendering"
```

---

### Task 2: Engine — `delivered`/`dropReason` on LoggedEvent + `deadNodes()`

**Files:**
- Modify: `src/engine/sim.ts` (LoggedEvent fields, step() restructure, `deadNodes()`)
- Modify: `src/engine/hash.ts` (fold delivered/dropReason into the hash string)
- Test: `src/engine/delivered.test.ts`

**Interfaces:**
- Consumes: `echo` fixture module from `src/engine/fixtures.ts` (node 'a' pings 'b' on init).
- Produces: `LoggedEvent` gains `delivered: boolean` and `dropReason?: 'dead-node' | 'partition'`; `sim.deadNodes(): NodeId[]`. Task 6 (driver) uses `deadNodes()`; Task 10/12 (verifier, timeline honesty) rely on `delivered`. Precedence rule: a dead target reports `dead-node` even if also partitioned.

- [ ] **Step 1: Write the failing test**

```ts
// src/engine/delivered.test.ts
import { expect, test } from 'vitest';
import { Simulation } from './sim';
import { echo, type EchoState } from './fixtures';

test('normal delivery: delivered true, no dropReason', () => {
  const sim = new Simulation<EchoState>({ module: echo, config: { nodeIds: ['a', 'b'] }, seed: 1 });
  sim.runUntil(100);
  const msg = sim.eventLog.find((e) => e.kind === 'message' && e.target === 'b');
  expect(msg).toMatchObject({ delivered: true });
  expect(msg?.dropReason).toBeUndefined();
});

test('dead target: delivered false, dropReason dead-node', () => {
  const sim = new Simulation<EchoState>({ module: echo, config: { nodeIds: ['a', 'b'] }, seed: 1 });
  sim.control({ type: 'kill', node: 'b' }); // control at t=0 precedes any message delivery (t>=1)
  sim.runUntil(100);
  const msg = sim.eventLog.find((e) => e.kind === 'message' && e.target === 'b');
  expect(msg).toMatchObject({ delivered: false, dropReason: 'dead-node' });
  const ctrl = sim.eventLog.find((e) => e.kind === 'control');
  expect(ctrl?.delivered).toBe(true); // control events always "deliver" to the engine
});

test('partition formed mid-flight: delivered false, dropReason partition', () => {
  const sim = new Simulation<EchoState>({
    module: echo,
    config: { nodeIds: ['a', 'b'] },
    seed: 1,
    network: { latency: [5, 5] },
  });
  sim.runSteps(2); // inits processed; ping in flight for t=5
  sim.control({ type: 'partition', groups: [['a'], ['b']] }); // t=0 control beats t=5 delivery
  sim.runUntil(50);
  const msg = sim.eventLog.find((e) => e.kind === 'message');
  expect(msg).toMatchObject({ delivered: false, dropReason: 'partition' });
});

test('deadNodes reflects kill and revive', () => {
  const sim = new Simulation<EchoState>({ module: echo, config: { nodeIds: ['a', 'b'] }, seed: 1 });
  expect(sim.deadNodes()).toEqual([]);
  sim.control({ type: 'kill', node: 'b' });
  sim.runSteps(3);
  expect(sim.deadNodes()).toEqual(['b']);
  sim.control({ type: 'revive', node: 'b' });
  sim.runSteps(1);
  expect(sim.deadNodes()).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/delivered.test.ts`
Expected: FAIL — `delivered` undefined / `deadNodes is not a function`.

- [ ] **Step 3: Implement**

In `src/engine/sim.ts`, extend `LoggedEvent`:

```ts
export interface LoggedEvent {
  index: number;
  time: number;
  target: NodeId;
  kind: SimEvent['kind'];
  from?: NodeId;
  payload: unknown;
  /** False when the event was skipped at delivery (dead target or partition). */
  delivered: boolean;
  dropReason?: 'dead-node' | 'partition';
}
```

Replace the body of `step()` with (compute fate BEFORE logging; dead-node takes precedence over partition):

```ts
  step(): LoggedEvent | undefined {
    const e = this.queue.pop();
    if (!e) return undefined;
    this.time = e.time;
    const isControl = e.kind === 'control';
    const deadTarget = !isControl && this.dead.has(e.target);
    // Recheck reachability at delivery, not just at send: a partition may form
    // between send and delivery, and an in-flight message is then lost.
    const blocked =
      !isControl &&
      !deadTarget &&
      e.kind === 'message' &&
      e.from !== undefined &&
      !this.network.canReach(e.from, e.target);
    const logged: LoggedEvent = {
      index: this.processed,
      time: e.time,
      target: e.target,
      kind: e.kind,
      from: e.from,
      payload: e.payload,
      delivered: !deadTarget && !blocked,
      ...(deadTarget ? { dropReason: 'dead-node' as const } : blocked ? { dropReason: 'partition' as const } : {}),
    };
    this.eventLog.push(logged);
    this.processed++;

    if (isControl) {
      this.applyControl(e.payload as ControlAction);
      return logged;
    }
    if (logged.delivered) {
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
```

Add after `getState`:

```ts
  /** Currently-killed nodes — cheap accessor for the UI bridge. */
  deadNodes(): NodeId[] {
    return [...this.dead];
  }
```

In `src/engine/hash.ts`, extend the per-event hash string so delivery fate is determinism-guarded (run-to-run comparisons stay valid — replays derive identical flags):

```ts
    h = fnv1a(
      `${e.index}|${e.time}|${e.target}|${e.kind}|${e.from ?? ''}|${e.delivered ? 1 : 0}|${e.dropReason ?? ''}|${JSON.stringify(e.payload)}`,
      h,
    );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/delivered.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Full suite, lint, typecheck**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all green. (`hash.test.ts` golden constants cover `fnv1a` string inputs only, not event logs — unaffected. Determinism tests compare run-to-run — unaffected.)

- [ ] **Step 6: Commit**

```bash
git add src/engine/sim.ts src/engine/hash.ts src/engine/delivered.test.ts
git commit -m "feat(engine): delivered/dropReason on LoggedEvent; deadNodes() accessor"
```

---

### Task 3: Engine — event/metrics time + `net` deep-clone fix (contract v0.2)

**Files:**
- Modify: `src/engine/module.ts` (`ModuleEvent.time`, `metrics(states, time)`)
- Modify: `src/engine/sim.ts` (pass `time` into `ModuleEvent`; deep-clone `net` opts)
- Test: `src/engine/contract-v02.test.ts`

**Interfaces:**
- Consumes: `SimModule`, `Simulation`.
- Produces: `ModuleEvent<P>` gains `time: number` (virtual time of the event being reduced); `SimModule.metrics(states: Map<NodeId, S>, time: number)`. Existing modules implementing `metrics(states)` remain type-compatible (TS allows fewer params). Task 9 (replication) uses both.

- [ ] **Step 1: Write the failing test**

```ts
// src/engine/contract-v02.test.ts
import { expect, test } from 'vitest';
import { Simulation } from './sim';
import type { InspectorTree, SimModule } from './module';
import type { NodeId } from './events';

interface ProbeState {
  self: NodeId;
  times: number[];
}

const probe: SimModule<ProbeState, null> = {
  id: 'probe',
  chaos: [],
  init: (nodeId) => ({ self: nodeId, times: [] }),
  reduce: (state, event) => {
    const next = { ...state, times: [...state.times, event.time] };
    if (event.kind === 'init') return [next, [{ type: 'timer', delay: 25, payload: null }]];
    return [next, []];
  },
  metrics: (states, time) => [{ name: 'now', value: time }],
  inspect: (s) => ({ ...s }) as InspectorTree,
};

test('reduce receives the virtual time of each event', () => {
  const sim = new Simulation<ProbeState, null>({ module: probe, config: { nodeIds: ['p'] }, seed: 3 });
  sim.runUntil(100);
  expect(sim.getState('p').times).toEqual([0, 25]); // init at t=0, timer at t=25
});

test('metrics receives virtual time', () => {
  const sim = new Simulation<ProbeState, null>({ module: probe, config: { nodeIds: ['p'] }, seed: 3 });
  sim.runUntil(100);
  const states = new Map([['p', sim.getState('p')]]);
  expect(sim.module.metrics(states, sim.time)).toEqual([{ name: 'now', value: 100 }]);
});

test("'net' control deep-clones opts — caller mutation cannot reach inside", () => {
  const sim = new Simulation<ProbeState, null>({ module: probe, config: { nodeIds: ['p'] }, seed: 3 });
  const opts = { latency: [5, 5] as [number, number] };
  sim.control({ type: 'net', opts });
  sim.runSteps(2); // init + control
  opts.latency[1] = 99;
  expect(sim.network.opts.latency[1]).toBe(5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/contract-v02.test.ts`
Expected: FAIL — `event.time` undefined → `times` equals `[undefined, undefined]`; net test fails with `99`.

- [ ] **Step 3: Implement**

In `src/engine/module.ts`:

```ts
/** The event shape a module's reduce() receives. 'control' never reaches modules. */
export interface ModuleEvent<P = unknown> {
  kind: 'init' | 'message' | 'timer' | 'external';
  self: NodeId;
  from?: NodeId;
  /** Virtual time at which this event is being processed. */
  time: number;
  payload: P;
}
```

and

```ts
  metrics(states: Map<NodeId, S>, time: number): MetricSample[];
```

Update the contract doc block's version note from `v0.1` to `v0.2` and append to the refinement list: `v0.2: events carry time; metrics receives time (rates need a window).`

In `src/engine/sim.ts` inside `step()`, add `time` to the `ModuleEvent`:

```ts
      const mev: ModuleEvent<P> = {
        kind: e.kind as ModuleEvent<P>['kind'],
        self: e.target,
        from: e.from,
        time: e.time,
        payload: e.payload as P,
      };
```

In `applyControl`, fix the aliasing (carry-forward minor):

```ts
      case 'net':
        Object.assign(this.network.opts, structuredClone(a.opts));
        break;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/contract-v02.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Full suite, lint, typecheck**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all green — `pingpong.ts` and fixtures ignore the new field/param and stay compatible.

- [ ] **Step 6: Commit**

```bash
git add src/engine/module.ts src/engine/sim.ts src/engine/contract-v02.test.ts
git commit -m "feat(engine): contract v0.2 — events and metrics carry virtual time; net opts deep-clone"
```

---

### Task 4: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: existing npm scripts `typecheck`, `lint`, `coverage` (coverage includes the 10k-scrub benchmark test).
- Produces: a `test` job that Task 15's `deploy` job will depend on (`needs: test`).

- [ ] **Step 1: Write the workflow**

```yaml
# .github/workflows/ci.yml
name: CI
on:
  push:
    branches: [master]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm run coverage
```

- [ ] **Step 2: Validate YAML locally**

Run: `npx --yes yaml-lint .github/workflows/ci.yml 2>/dev/null || node -e "const yaml=require('node:fs').readFileSync('.github/workflows/ci.yml','utf8'); console.log('bytes:', yaml.length)"`
Expected: no parse error output (full validation happens on first push in Task 15).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: typecheck + lint + coverage gate with scrub benchmark"
```

---

### Task 5: Vite + React 19 shell, Tailwind, lint fence, jsdom test support

**Files:**
- Create: `index.html`, `vite.config.ts`, `src/ui/main.tsx`, `src/ui/App.tsx`, `src/ui/index.css`, `src/ui/App.test.tsx`
- Modify: `package.json` (deps + scripts), `tsconfig.json` (jsx), `eslint.config.js` (ui fence), `vitest.config.ts` (tsx tests, coverage scope)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `npm run dev` serves the app; `App` is the mount point Tasks 8/11/13 extend with tabs. Coverage gate now scoped to `src/engine/**` + `src/modules/**`.

- [ ] **Step 1: Install dependencies**

```bash
npm install react react-dom zustand motion recharts
npm install -D vite @vitejs/plugin-react tailwindcss @tailwindcss/vite \
  @types/react @types/react-dom jsdom @testing-library/react @testing-library/dom
```

- [ ] **Step 2: Write the failing smoke test**

```tsx
// src/ui/App.test.tsx
// @vitest-environment jsdom
import { expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from './App';

test('shell renders the app title', () => {
  render(<App />);
  expect(screen.getByText('DDIA Visualized')).toBeTruthy();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/ui/App.test.tsx`
Expected: FAIL — cannot resolve `./App` (and/or tsx not included until config updated in step 4).

- [ ] **Step 4: Write config + shell files**

`vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [react(), tailwindcss()],
});
```

`index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DDIA Visualized</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/ui/main.tsx"></script>
  </body>
</html>
```

`src/ui/index.css`:

```css
@import 'tailwindcss';
```

`src/ui/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`src/ui/App.tsx`:

```tsx
export default function App() {
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-6">
      <h1 className="text-2xl font-bold">DDIA Visualized</h1>
      <p className="text-slate-400">Phase 1 — Lab Kit</p>
    </main>
  );
}
```

`tsconfig.json` — add to `compilerOptions`:

```json
    "jsx": "react-jsx",
```

`package.json` — add scripts:

```json
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
```

`vitest.config.ts` — replace `test` block:

```ts
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/engine/**/*.ts', 'src/modules/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
```

`eslint.config.js` — inside the engine/modules block's `no-restricted-imports` patterns array, add a second pattern object after the existing one:

```js
            {
              group: ['**/ui/**'],
              message: 'Simulation core must not import the UI layer (DESIGN_PLAN §5).',
            },
```

and change the test-override `files` glob so `.tsx` tests are exempted too:

```js
    files: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/ui/App.test.tsx`
Expected: PASS.

- [ ] **Step 6: Verify dev server + full gates**

Run: `npm run build && npm test && npm run lint && npm run typecheck && npm run coverage`
Expected: `vite build` outputs `dist/`; all gates green (coverage now scoped to engine+modules).

- [ ] **Step 7: Commit**

```bash
git add index.html vite.config.ts src/ui tsconfig.json package.json package-lock.json eslint.config.js vitest.config.ts
git commit -m "feat(ui): Vite + React 19 + Tailwind shell; ui lint fence; jsdom test support"
```

---

### Task 6: Bridge — `simStore` + `SimDriver` (proven on ping-pong)

**Files:**
- Create: `src/ui/bridge/simStore.ts`, `src/ui/bridge/SimDriver.ts`
- Test: `src/ui/bridge/SimDriver.test.ts` (node env — rAF injected, no DOM needed)

**Interfaces:**
- Consumes: `Simulation`, `TimelineRecorder`, `inFlight()` (Task 1), `deadNodes()` (Task 2), `metrics(states, time)` (Task 3).
- Produces:
  - `useSimStore` (Zustand) with state `SimView { time, processed, pending, running, speed, nodes: NodeView[], inFlight, metricsHistory: MetricsPoint[], logTail }`, actions `publish(v: PublishedView)`, `reset()`.
  - `NodeView = { id: NodeId; dead: boolean; inspect: Record<string, unknown> }`; `MetricsPoint = { time: number } & Record<string, number>`.
  - `class SimDriver<S, P>`: `constructor({ sim, seed, publish, raf?, caf? })`, `start()`, `pause()`, `stepOnce()`, `scrubTo(i)`, `setSpeed(n)`, `external(target, payload)`, `control(action)`, `exportSession(journal?): string`, `publishNow()`, `running: boolean`, `speed: number`, `sim`, `recorder`, `seed`.
  - Tasks 8/11/12/13 consume these exact names.

- [ ] **Step 1: Write the failing test**

```ts
// src/ui/bridge/SimDriver.test.ts
import { expect, test } from 'vitest';
import { Simulation } from '../../engine';
import { pingPong, type PPPayload, type PPState } from '../../modules/pingpong';
import { SimDriver, type PublishedView } from './SimDriver';

function fakeRaf() {
  const q: (() => void)[] = [];
  return {
    raf: (cb: () => void) => {
      q.push(cb);
      return q.length;
    },
    caf: (id: number) => {
      q[id - 1] = () => undefined;
    },
    flush: () => {
      const cbs = q.splice(0, q.length);
      for (const cb of cbs) cb();
    },
  };
}

function makeDriver() {
  const views: PublishedView[] = [];
  const { raf, caf, flush } = fakeRaf();
  const sim = new Simulation<PPState, PPPayload>({
    module: pingPong,
    config: { nodeIds: ['a', 'b', 'c'] },
    seed: 42,
  });
  const driver = new SimDriver<PPState, PPPayload>({ sim, seed: 42, publish: (v) => views.push(v), raf, caf });
  return { driver, sim, views, flush };
}

test('publishes an initial view on construction', () => {
  const { views } = makeDriver();
  expect(views).toHaveLength(1);
  expect(views[0].nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
  expect(views[0].running).toBe(false);
});

test('start steps speed events per frame; pause stops stepping', () => {
  const { driver, sim, views, flush } = makeDriver();
  driver.setSpeed(5);
  driver.start();
  flush();
  expect(sim.processed).toBe(5);
  expect(views.at(-1)!.processed).toBe(5);
  driver.pause();
  flush();
  expect(sim.processed).toBe(5);
  expect(views.at(-1)!.running).toBe(false);
});

test('external and control are recorded for session export', () => {
  const { driver } = makeDriver();
  driver.control({ type: 'kill', node: 'b' });
  driver.external('a', { poke: true });
  const session = JSON.parse(driver.exportSession('learned something'));
  expect(session.seed).toBe(42);
  expect(session.actions).toEqual([
    { at: 0, type: 'control', action: { type: 'kill', node: 'b' } },
    { at: 0, type: 'external', target: 'a', payload: { poke: true } },
  ]);
  expect(session.journal).toBe('learned something');
});

test('backward scrub + new control rewrites the timeline deterministically', () => {
  const { driver, sim } = makeDriver();
  driver.stepOnce();
  for (let i = 0; i < 99; i++) driver.stepOnce();
  expect(sim.processed).toBe(100);
  driver.scrubTo(50);
  expect(sim.processed).toBe(50);
  driver.control({ type: 'kill', node: 'c' });
  driver.stepOnce();
  expect(sim.eventLog[50]!.kind).toBe('control'); // injected action is the new event 50
});

test('metrics point per publish carries virtual time', () => {
  const { driver, views } = makeDriver();
  driver.stepOnce();
  const last = views.at(-1)!;
  expect(last.metricsHistory).toHaveLength(1);
  expect(last.metricsHistory[0].time).toBe(views.at(-1)!.time);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/bridge/SimDriver.test.ts`
Expected: FAIL — module `./SimDriver` not found.

- [ ] **Step 3: Implement the store**

```ts
// src/ui/bridge/simStore.ts
import { create } from 'zustand';
import type { InFlightMessage, LoggedEvent, NodeId } from '../../engine';

export interface NodeView {
  id: NodeId;
  dead: boolean;
  inspect: Record<string, unknown>;
}

export type MetricsPoint = { time: number } & Record<string, number>;

export interface SimView {
  time: number;
  processed: number;
  pending: number;
  running: boolean;
  speed: number;
  nodes: NodeView[];
  inFlight: InFlightMessage[];
  metricsHistory: MetricsPoint[];
  logTail: LoggedEvent[];
}

/** What SimDriver publishes each batch: full view, one new metrics point. */
export type PublishedView = Omit<SimView, 'metricsHistory'> & { metricsHistory: MetricsPoint[] };

interface SimStore extends SimView {
  publish: (v: PublishedView) => void;
  reset: () => void;
}

const MAX_HISTORY = 300;

const initial: SimView = {
  time: 0,
  processed: 0,
  pending: 0,
  running: false,
  speed: 25,
  nodes: [],
  inFlight: [],
  metricsHistory: [],
  logTail: [],
};

export const useSimStore = create<SimStore>((set) => ({
  ...initial,
  publish: (v) =>
    set((s) => {
      // Trim any points from a scrubbed-away future, then append/replace by time.
      const kept = s.metricsHistory.filter((p) => p.time < v.time);
      const merged = [...kept, ...v.metricsHistory].slice(-MAX_HISTORY);
      return { ...v, metricsHistory: merged };
    }),
  reset: () => set(() => ({ ...initial, metricsHistory: [], nodes: [], inFlight: [], logTail: [] })),
}));
```

- [ ] **Step 4: Implement the driver**

```ts
// src/ui/bridge/SimDriver.ts
import { Simulation, TimelineRecorder, type ControlAction, type NodeId } from '../../engine';
import type { MetricsPoint, PublishedView } from './simStore';

export type { PublishedView } from './simStore';

export type SessionAction =
  | { at: number; type: 'external'; target: NodeId; payload: unknown }
  | { at: number; type: 'control'; action: ControlAction };

type Raf = (cb: () => void) => number;
type Caf = (id: number) => void;

/**
 * One-directional bridge (DESIGN_PLAN §5): steps the sim on an rAF loop and
 * publishes batched snapshots. All user input flows through external()/control()
 * so every session is recorded and replayable.
 */
export class SimDriver<S, P = unknown> {
  readonly sim: Simulation<S, P>;
  readonly recorder: TimelineRecorder<S, P>;
  readonly seed: number;
  speed = 25; // events per frame

  private readonly actions: SessionAction[] = [];
  private rafId: number | null = null;
  private readonly raf: Raf;
  private readonly caf: Caf;
  private readonly publish: (v: PublishedView) => void;

  constructor(opts: {
    sim: Simulation<S, P>;
    seed: number;
    publish: (v: PublishedView) => void;
    raf?: Raf;
    caf?: Caf;
  }) {
    this.sim = opts.sim;
    this.seed = opts.seed;
    this.publish = opts.publish;
    this.recorder = new TimelineRecorder(this.sim);
    this.raf = opts.raf ?? ((cb) => requestAnimationFrame(cb));
    this.caf = opts.caf ?? ((id) => cancelAnimationFrame(id));
    this.publishNow();
  }

  get running(): boolean {
    return this.rafId !== null;
  }

  start(): void {
    if (this.rafId !== null) return;
    this.rafId = this.raf(this.tick);
    this.publishNow();
  }

  pause(): void {
    if (this.rafId === null) return;
    this.caf(this.rafId);
    this.rafId = null;
    this.publishNow();
  }

  private tick = (): void => {
    this.rafId = this.raf(this.tick);
    this.recorder.runSteps(this.speed);
    this.publishNow();
  };

  setSpeed(n: number): void {
    this.speed = n;
  }

  stepOnce(): void {
    this.recorder.runSteps(1);
    this.publishNow();
  }

  scrubTo(index: number): void {
    this.recorder.scrubTo(index);
    this.publishNow();
  }

  external(target: NodeId, payload: unknown): void {
    this.recorder.invalidateFuture();
    this.actions.push({ at: this.sim.time, type: 'external', target, payload });
    this.sim.external(target, payload);
    this.publishNow();
  }

  control(action: ControlAction): void {
    this.recorder.invalidateFuture();
    this.actions.push({ at: this.sim.time, type: 'control', action });
    this.sim.control(action);
    this.publishNow();
  }

  exportSession(journal?: string): string {
    return JSON.stringify({ seed: this.seed, actions: this.actions, journal: journal ?? null }, null, 2);
  }

  publishNow(): void {
    const ids = this.sim.config.nodeIds;
    const dead = new Set(this.sim.deadNodes());
    const states = new Map(ids.map((id) => [id, this.sim.getState(id)] as const));
    const point: MetricsPoint = { time: this.sim.time };
    for (const m of this.sim.module.metrics(states, this.sim.time)) point[m.name] = m.value;
    this.publish({
      time: this.sim.time,
      processed: this.sim.processed,
      pending: this.sim.pending,
      running: this.running,
      speed: this.speed,
      nodes: ids.map((id) => ({ id, dead: dead.has(id), inspect: this.sim.module.inspect(states.get(id)!) })),
      inFlight: this.sim.inFlight(),
      metricsHistory: [point],
      logTail: this.sim.eventLog.slice(-50),
    });
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/ui/bridge/SimDriver.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Full suite, lint, typecheck**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/ui/bridge
git commit -m "feat(ui): SimDriver rAF bridge + Zustand simStore with session recording"
```

---

### Task 7: Lab Kit — `ClusterView` + `ChaosToolbar`

**Files:**
- Create: `src/ui/kit/ClusterView.tsx`, `src/ui/kit/ChaosToolbar.tsx`
- Test: `src/ui/kit/ClusterView.test.tsx`, `src/ui/kit/ChaosToolbar.test.tsx`

**Interfaces:**
- Consumes: `NodeView`, `InFlightMessage`, `ChaosCapability`, `ControlAction`.
- Produces:
  - `ClusterView({ nodes: NodeView[]; inFlight: InFlightMessage[]; time: number; onNodeClick?: (id: NodeId) => void })` — SVG ring layout; message-dot position = linear interpolation by `(time - sentAt) / (deliverAt - sentAt)`.
  - `ChaosToolbar({ caps: ChaosCapability[]; nodeIds: NodeId[]; deadNodes: NodeId[]; onAction: (a: ControlAction) => void })` — renders ONLY controls whose capability is declared (DESIGN_PLAN §5).

- [ ] **Step 1: Write the failing tests**

```tsx
// src/ui/kit/ClusterView.test.tsx
// @vitest-environment jsdom
import { expect, test, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { ClusterView } from './ClusterView';

const nodes = [
  { id: 'a', dead: false, inspect: {} },
  { id: 'b', dead: true, inspect: {} },
  { id: 'c', dead: false, inspect: {} },
];

test('renders one circle per node plus one dot per in-flight message', () => {
  const inFlight = [{ from: 'a', target: 'b', sentAt: 0, deliverAt: 10, payload: null }];
  const { container } = render(<ClusterView nodes={nodes} inFlight={inFlight} time={5} />);
  expect(container.querySelectorAll('circle')).toHaveLength(4); // 3 nodes + 1 dot
});

test('node click reports the node id', () => {
  const onNodeClick = vi.fn();
  const { getByText } = render(<ClusterView nodes={nodes} inFlight={[]} time={0} onNodeClick={onNodeClick} />);
  fireEvent.click(getByText('a'));
  expect(onNodeClick).toHaveBeenCalledWith('a');
});
```

```tsx
// src/ui/kit/ChaosToolbar.test.tsx
// @vitest-environment jsdom
import { expect, test } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ControlAction } from '../../engine';
import { ChaosToolbar } from './ChaosToolbar';

test('renders only declared capabilities', () => {
  render(<ChaosToolbar caps={['kill-node']} nodeIds={['a', 'b']} deadNodes={[]} onAction={() => undefined} />);
  expect(screen.getByText('kill a')).toBeTruthy();
  expect(screen.queryByText('heal')).toBeNull();
  expect(screen.queryByText(/drop/)).toBeNull();
});

test('kill/revive toggle by dead state; actions dispatched', () => {
  const actions: ControlAction[] = [];
  render(
    <ChaosToolbar
      caps={['kill-node', 'partition']}
      nodeIds={['a', 'b']}
      deadNodes={['b']}
      onAction={(a) => actions.push(a)}
    />,
  );
  fireEvent.click(screen.getByText('kill a'));
  fireEvent.click(screen.getByText('revive b'));
  fireEvent.click(screen.getByText('heal'));
  expect(actions).toEqual([
    { type: 'kill', node: 'a' },
    { type: 'revive', node: 'b' },
    { type: 'heal' },
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ui/kit`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement ClusterView**

```tsx
// src/ui/kit/ClusterView.tsx
import { motion } from 'motion/react';
import type { InFlightMessage, NodeId } from '../../engine';
import type { NodeView } from '../bridge/simStore';

const R = 120;
const CX = 180;
const CY = 160;
const NODE_R = 26;

function pos(i: number, n: number): { x: number; y: number } {
  const a = (2 * Math.PI * i) / n - Math.PI / 2;
  return { x: CX + R * Math.cos(a), y: CY + R * Math.sin(a) };
}

/** SVG cluster ring: nodes + message dots interpolated along virtual time. */
export function ClusterView({
  nodes,
  inFlight,
  time,
  onNodeClick,
}: {
  nodes: NodeView[];
  inFlight: InFlightMessage[];
  time: number;
  onNodeClick?: (id: NodeId) => void;
}) {
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  return (
    <svg viewBox="0 0 360 320" className="w-[360px] shrink-0 select-none">
      {inFlight.map((m, k) => {
        const fi = index.get(m.from);
        const ti = index.get(m.target);
        if (fi === undefined || ti === undefined) return null;
        const f = pos(fi, nodes.length);
        const t = pos(ti, nodes.length);
        const p =
          m.deliverAt === m.sentAt ? 1 : Math.min(1, Math.max(0, (time - m.sentAt) / (m.deliverAt - m.sentAt)));
        return (
          <circle key={k} cx={f.x + (t.x - f.x) * p} cy={f.y + (t.y - f.y) * p} r={4} className="fill-amber-400" />
        );
      })}
      {nodes.map((n, i) => {
        const q = pos(i, nodes.length);
        return (
          <g key={n.id} onClick={() => onNodeClick?.(n.id)} className="cursor-pointer">
            <motion.circle
              cx={q.x}
              cy={q.y}
              r={NODE_R}
              animate={{ opacity: n.dead ? 0.25 : 1 }}
              className="fill-sky-600"
            />
            <text x={q.x} y={q.y + 5} textAnchor="middle" className="fill-white text-xs font-mono">
              {n.id}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
```

- [ ] **Step 4: Implement ChaosToolbar**

```tsx
// src/ui/kit/ChaosToolbar.tsx
import type { ChaosCapability, ControlAction, NodeId } from '../../engine';

const btn =
  'px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-600 text-xs font-mono';

/** Renders only the controls the module declares (DESIGN_PLAN §5). */
export function ChaosToolbar({
  caps,
  nodeIds,
  deadNodes,
  onAction,
}: {
  caps: ChaosCapability[];
  nodeIds: NodeId[];
  deadNodes: NodeId[];
  onAction: (a: ControlAction) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {caps.includes('kill-node') &&
        nodeIds.map((id) =>
          deadNodes.includes(id) ? (
            <button key={id} className={btn} onClick={() => onAction({ type: 'revive', node: id })}>
              revive {id}
            </button>
          ) : (
            <button key={id} className={btn} onClick={() => onAction({ type: 'kill', node: id })}>
              kill {id}
            </button>
          ),
        )}
      {caps.includes('partition') && (
        <>
          <button
            className={btn}
            onClick={() => onAction({ type: 'partition', groups: [[nodeIds[0]], nodeIds.slice(1)] })}
          >
            isolate {nodeIds[0]}
          </button>
          <button className={btn} onClick={() => onAction({ type: 'heal' })}>
            heal
          </button>
        </>
      )}
      {caps.includes('delay') && (
        <label className="text-xs font-mono flex items-center gap-1">
          latency max
          <input
            type="range"
            min={1}
            max={300}
            defaultValue={10}
            onChange={(e) => onAction({ type: 'net', opts: { latency: [1, Number(e.target.value)] } })}
          />
        </label>
      )}
      {caps.includes('drop') && (
        <label className="text-xs font-mono flex items-center gap-1">
          drop %
          <input
            type="range"
            min={0}
            max={90}
            defaultValue={0}
            onChange={(e) => onAction({ type: 'net', opts: { dropRate: Number(e.target.value) / 100 } })}
          />
        </label>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/ui/kit`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/ui/kit
git commit -m "feat(ui): ClusterView and ChaosToolbar kit components"
```

---

### Task 8: Lab Kit — `MetricsPanel` + `TimelineScrubber` + ping-pong lab page

**Files:**
- Create: `src/ui/kit/MetricsPanel.tsx`, `src/ui/kit/TimelineScrubber.tsx`, `src/ui/labs/pingpong/PingPongLab.tsx`
- Modify: `src/ui/App.tsx` (mount the lab)
- Test: `src/ui/kit/TimelineScrubber.test.tsx`

**Interfaces:**
- Consumes: kit components (Task 7), bridge (Task 6), `pingPong` module.
- Produces:
  - `MetricsPanel({ history: MetricsPoint[] })` — Recharts line chart, one line per metric key.
  - `TimelineScrubber({ processed, pending, running, onPlayPause, onStep, onScrub })`.
  - `PingPongLab()` — full kit assembly; the kit-reusability proof.

- [ ] **Step 1: Write the failing scrubber test**

```tsx
// src/ui/kit/TimelineScrubber.test.tsx
// @vitest-environment jsdom
import { expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TimelineScrubber } from './TimelineScrubber';

test('scrub emits the target index; play/pause and step wired', () => {
  const onScrub = vi.fn();
  const onPlayPause = vi.fn();
  const onStep = vi.fn();
  const { container } = render(
    <TimelineScrubber processed={40} pending={10} running={false} onPlayPause={onPlayPause} onStep={onStep} onScrub={onScrub} />,
  );
  fireEvent.change(container.querySelector('input[type=range]')!, { target: { value: '12' } });
  expect(onScrub).toHaveBeenCalledWith(12);
  fireEvent.click(screen.getByText('play'));
  expect(onPlayPause).toHaveBeenCalled();
  fireEvent.click(screen.getByText('step'));
  expect(onStep).toHaveBeenCalled();
});

test('scrubbing disabled while running', () => {
  const { container } = render(
    <TimelineScrubber processed={5} pending={0} running={true} onPlayPause={() => undefined} onStep={() => undefined} onScrub={() => undefined} />,
  );
  expect((container.querySelector('input[type=range]') as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByText('pause')).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/kit/TimelineScrubber.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement TimelineScrubber**

```tsx
// src/ui/kit/TimelineScrubber.tsx
const btn =
  'px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-600 text-xs font-mono';

/** Hybrid snapshot+replay scrubbing UI over TimelineRecorder (DESIGN_PLAN §5). */
export function TimelineScrubber({
  processed,
  pending,
  running,
  onPlayPause,
  onStep,
  onScrub,
}: {
  processed: number;
  pending: number;
  running: boolean;
  onPlayPause: () => void;
  onStep: () => void;
  onScrub: (index: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <button className={btn} onClick={onPlayPause}>
        {running ? 'pause' : 'play'}
      </button>
      <button className={btn} onClick={onStep} disabled={running}>
        step
      </button>
      <input
        type="range"
        min={0}
        max={processed + pending}
        value={processed}
        disabled={running}
        onChange={(e) => onScrub(Number(e.target.value))}
        className="grow"
      />
      <span className="font-mono text-xs w-16 text-right">{processed}</span>
    </div>
  );
}
```

- [ ] **Step 4: Implement MetricsPanel**

(No jsdom test — Recharts layout depends on real measurement; covered by lab usage.)

```tsx
// src/ui/kit/MetricsPanel.tsx
import { Legend, Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts';
import type { MetricsPoint } from '../bridge/simStore';

const COLORS = ['#0ea5e9', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6'];

/** Live metrics chart — one stepped line per metric name (DESIGN_PLAN §4: countable numbers). */
export function MetricsPanel({ history }: { history: MetricsPoint[] }) {
  const last = history[history.length - 1];
  const keys = last ? Object.keys(last).filter((k) => k !== 'time') : [];
  return (
    <LineChart width={440} height={200} data={history}>
      <XAxis dataKey="time" tick={{ fontSize: 10 }} />
      <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
      <Tooltip />
      <Legend />
      {keys.map((k, i) => (
        <Line
          key={k}
          type="stepAfter"
          dataKey={k}
          dot={false}
          isAnimationActive={false}
          stroke={COLORS[i % COLORS.length]}
        />
      ))}
    </LineChart>
  );
}
```

- [ ] **Step 5: Implement PingPongLab and mount it**

```tsx
// src/ui/labs/pingpong/PingPongLab.tsx
import { useEffect, useRef } from 'react';
import { Simulation } from '../../../engine';
import { pingPong, type PPPayload, type PPState } from '../../../modules/pingpong';
import { SimDriver } from '../../bridge/SimDriver';
import { useSimStore } from '../../bridge/simStore';
import { ChaosToolbar } from '../../kit/ChaosToolbar';
import { ClusterView } from '../../kit/ClusterView';
import { MetricsPanel } from '../../kit/MetricsPanel';
import { TimelineScrubber } from '../../kit/TimelineScrubber';

const NODE_IDS = ['n0', 'n1', 'n2'];

export function PingPongLab() {
  const ref = useRef<SimDriver<PPState, PPPayload> | null>(null);
  if (!ref.current) {
    useSimStore.getState().reset();
    const sim = new Simulation<PPState, PPPayload>({
      module: pingPong,
      config: { nodeIds: NODE_IDS },
      seed: 42,
      network: { latency: [5, 40] },
    });
    ref.current = new SimDriver({ sim, seed: 42, publish: (v) => useSimStore.getState().publish(v) });
  }
  const driver = ref.current;
  useEffect(() => () => driver.pause(), [driver]);
  const view = useSimStore();

  return (
    <div className="space-y-4">
      <TimelineScrubber
        processed={view.processed}
        pending={view.pending}
        running={view.running}
        onPlayPause={() => (view.running ? driver.pause() : driver.start())}
        onStep={() => driver.stepOnce()}
        onScrub={(i) => driver.scrubTo(i)}
      />
      <div className="flex gap-6 items-start">
        <ClusterView
          nodes={view.nodes}
          inFlight={view.inFlight}
          time={view.time}
          onNodeClick={(id) =>
            driver.control(
              view.nodes.find((n) => n.id === id)?.dead ? { type: 'revive', node: id } : { type: 'kill', node: id },
            )
          }
        />
        <MetricsPanel history={view.metricsHistory} />
      </div>
      <ChaosToolbar
        caps={pingPong.chaos}
        nodeIds={NODE_IDS}
        deadNodes={view.nodes.filter((n) => n.dead).map((n) => n.id)}
        onAction={(a) => driver.control(a)}
      />
    </div>
  );
}
```

Replace `src/ui/App.tsx`:

```tsx
import { PingPongLab } from './labs/pingpong/PingPongLab';

export default function App() {
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-bold">DDIA Visualized</h1>
        <p className="text-slate-400">Phase 1 — Lab Kit</p>
      </header>
      <PingPongLab />
    </main>
  );
}
```

(App.test.tsx keeps passing — the title text is unchanged. If jsdom errors on rendering the lab appear, they surface here, not in prod.)

- [ ] **Step 6: Run tests + manual smoke**

Run: `npx vitest run src/ui && npm run typecheck && npm run lint`
Expected: PASS.
Then: `npm run dev` — open the browser: press play, dots fly around the ring, killing a node stops the token, revive + retransmission recovers it, scrubbing rewinds.

- [ ] **Step 7: Commit**

```bash
git add src/ui
git commit -m "feat(ui): MetricsPanel, TimelineScrubber, ping-pong lab proving kit reuse"
```

---

### Task 9: Replication module (leader-follower, async/sync)

**Files:**
- Create: `src/modules/replication.ts`
- Test: `src/modules/replication.test.ts`

**Interfaces:**
- Consumes: `SimModule` v0.2 (`event.time`, `metrics(states, time)` from Task 3).
- Produces (Tasks 10–12 rely on these exact names):
  - `replication: SimModule<RepState, RepPayload>` with `id: 'replication-leader-follower'`.
  - `RepMode = 'async' | 'sync'` (module param `config.params.mode`, default `'async'`); `config.nodeIds[0]` is the leader.
  - `RepState` (all plain JSON): `{ self, role: 'leader'|'follower', leader, followers, mode, log: RepEntry[], data: Record<string,{value,seq}>, nextSeq, pending: Record<number,{entry,awaiting:NodeId[]}>, buffer: Record<number,RepEntry>, history: RepHistory[] }`.
  - `RepEntry = { seq: number; key: string; value: string }`.
  - `RepHistory = { type:'ack'; seq; key; time } | { type:'read'; node; key; returnedSeq; time }`.
  - `RepPayload = { cmd:'write'; key; value } | { cmd:'read'; key } | { rep:'append'; entry } | { rep:'ack'; seq } | { retransmit: number } | null`.
  - Invariant: `log[i].seq === i + 1` on every node (leader assigns consecutive seqs from 1; followers apply in order, buffering gaps).
  - Semantics: async = ack at write time, no retransmission (drops lose data — the lesson); sync = ack only after ALL followers ack, retransmit every 60 virtual ms until acked.

- [ ] **Step 1: Write the failing tests**

```ts
// src/modules/replication.test.ts
import { expect, test } from 'vitest';
import { Simulation } from '../engine';
import { replication, type RepPayload, type RepState } from './replication';

const NODES = ['L', 'F1', 'F2'];

function makeSim(mode: 'async' | 'sync', network?: { latency?: [number, number]; dropRate?: number }) {
  return new Simulation<RepState, RepPayload>({
    module: replication,
    config: { nodeIds: NODES, params: { mode } },
    seed: 11,
    network: { latency: [5, 20], ...network },
  });
}

test('async write propagates to all followers and acks immediately', () => {
  const sim = makeSim('async');
  sim.runSteps(3); // inits
  sim.external('L', { cmd: 'write', key: 'x', value: '1' });
  sim.runSteps(1); // leader processes the write
  expect(sim.getState('L').history).toEqual([{ type: 'ack', seq: 1, key: 'x', time: 0 }]);
  sim.runUntil(500);
  for (const id of NODES) {
    expect(sim.getState(id).data['x']).toEqual({ value: '1', seq: 1 });
    expect(sim.getState(id).log).toHaveLength(1);
  }
});

test('sync write acks only after all followers confirm', () => {
  const sim = makeSim('sync');
  sim.runSteps(3);
  sim.external('L', { cmd: 'write', key: 'x', value: '1' });
  sim.runSteps(1);
  expect(sim.getState('L').history).toEqual([]); // not acked yet
  sim.runUntil(500);
  const acks = sim.getState('L').history.filter((h) => h.type === 'ack');
  expect(acks).toEqual([{ type: 'ack', seq: 1, key: 'x', time: expect.any(Number) }]);
});

test('reads record the returned seq per node', () => {
  const sim = makeSim('async');
  sim.runSteps(3);
  sim.external('F1', { cmd: 'read', key: 'x' });
  sim.runSteps(1);
  expect(sim.getState('F1').history).toEqual([
    { type: 'read', node: 'F1', key: 'x', returnedSeq: 0, time: 0 },
  ]);
});

test('sync mode retransmits through total drop until the network heals', () => {
  const sim = makeSim('sync', { dropRate: 1 });
  sim.runSteps(3);
  sim.external('L', { cmd: 'write', key: 'k', value: 'v' });
  sim.runUntil(300);
  expect(sim.getState('L').history.filter((h) => h.type === 'ack')).toHaveLength(0);
  expect(sim.getState('F1').log).toHaveLength(0);
  sim.control({ type: 'net', opts: { dropRate: 0 } });
  sim.runUntil(1500);
  expect(sim.getState('L').history.filter((h) => h.type === 'ack')).toHaveLength(1);
  expect(sim.getState('F1').log).toHaveLength(1);
  expect(sim.getState('F2').log).toHaveLength(1);
});

test('followers buffer out-of-order appends and apply in seq order', () => {
  const sim = makeSim('async', { latency: [1, 200] }); // wide latency → reorder likely
  sim.runSteps(3);
  for (let i = 1; i <= 5; i++) sim.external('L', { cmd: 'write', key: `k${i}`, value: String(i) });
  sim.runUntil(2000);
  for (const id of ['F1', 'F2']) {
    expect(sim.getState(id).log.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  }
});

test('metrics reports lag, acked writes, and stale reads', () => {
  const sim = makeSim('async');
  sim.runSteps(3);
  sim.external('L', { cmd: 'write', key: 'x', value: '1' });
  sim.runSteps(1); // acked at leader; appends still in flight
  sim.external('F1', { cmd: 'read', key: 'x' }); // stale: F1 hasn't applied yet
  sim.runSteps(1);
  const states = new Map(NODES.map((id) => [id, sim.getState(id)] as const));
  const m = Object.fromEntries(sim.module.metrics(states, sim.time).map((s) => [s.name, s.value]));
  expect(m['max-replication-lag']).toBe(1);
  expect(m['acked-writes']).toBe(1);
  expect(m['stale-reads']).toBe(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/modules/replication.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

```ts
// src/modules/replication.ts
import type { NodeId } from '../engine/events';
import type { Effect, InspectorTree, ModuleEvent, SimModule } from '../engine/module';

/**
 * Leader-follower replication (DDIA Ch5, Phase 1 slice). nodeIds[0] is the
 * leader. async: ack at write time, no retransmission — drops lose data.
 * sync: ack only after ALL followers confirm; unacked appends retransmit
 * every RETRANSMIT_MS. Followers apply strictly in seq order, buffering gaps.
 */
export type RepMode = 'async' | 'sync';

export interface RepEntry {
  seq: number;
  key: string;
  value: string;
}

export type RepHistory =
  | { type: 'ack'; seq: number; key: string; time: number }
  | { type: 'read'; node: NodeId; key: string; returnedSeq: number; time: number };

export interface RepState {
  self: NodeId;
  role: 'leader' | 'follower';
  leader: NodeId;
  followers: NodeId[];
  mode: RepMode;
  log: RepEntry[];
  data: Record<string, { value: string; seq: number }>;
  /** Leader: next seq to assign (starts at 1). */
  nextSeq: number;
  /** Leader, sync mode: writes awaiting follower acks. */
  pending: Record<number, { entry: RepEntry; awaiting: NodeId[] }>;
  /** Follower: out-of-order entries waiting for the gap to fill. */
  buffer: Record<number, RepEntry>;
  history: RepHistory[];
}

export type RepPayload =
  | { cmd: 'write'; key: string; value: string }
  | { cmd: 'read'; key: string }
  | { rep: 'append'; entry: RepEntry }
  | { rep: 'ack'; seq: number }
  | { retransmit: number }
  | null;

const RETRANSMIT_MS = 60;

function applyEntry(s: RepState, entry: RepEntry): RepState {
  return {
    ...s,
    log: [...s.log, entry],
    data: { ...s.data, [entry.key]: { value: entry.value, seq: entry.seq } },
  };
}

function handleClient(s: RepState, ev: ModuleEvent<RepPayload>): [RepState, Effect[]] {
  const p = ev.payload;
  if (p && 'cmd' in p && p.cmd === 'read') {
    const returnedSeq = s.data[p.key]?.seq ?? 0;
    return [
      { ...s, history: [...s.history, { type: 'read', node: s.self, key: p.key, returnedSeq, time: ev.time }] },
      [],
    ];
  }
  if (!p || !('cmd' in p) || p.cmd !== 'write' || s.role !== 'leader') return [s, []];
  const entry: RepEntry = { seq: s.nextSeq, key: p.key, value: p.value };
  let next = applyEntry({ ...s, nextSeq: s.nextSeq + 1 }, entry);
  const sends: Effect[] = next.followers.map((f) => ({ type: 'send', to: f, payload: { rep: 'append', entry } }));
  if (next.mode === 'async') {
    next = { ...next, history: [...next.history, { type: 'ack', seq: entry.seq, key: entry.key, time: ev.time }] };
    return [next, sends];
  }
  next = { ...next, pending: { ...next.pending, [entry.seq]: { entry, awaiting: [...next.followers] } } };
  return [next, [...sends, { type: 'timer', delay: RETRANSMIT_MS, payload: { retransmit: entry.seq } }]];
}

function handleMessage(s: RepState, ev: ModuleEvent<RepPayload>): [RepState, Effect[]] {
  const p = ev.payload;
  if (p && 'rep' in p && p.rep === 'append' && s.role === 'follower') {
    const appliedBefore = s.log.length; // invariant: log[i].seq === i + 1
    let next: RepState = { ...s, buffer: { ...s.buffer, [p.entry.seq]: p.entry } };
    const ackSeqs: number[] = p.entry.seq <= appliedBefore ? [p.entry.seq] : []; // duplicate → re-ack
    for (;;) {
      const gap = next.log.length + 1;
      const e = next.buffer[gap];
      if (!e) break;
      const buffer = { ...next.buffer };
      delete buffer[gap];
      next = { ...applyEntry(next, e), buffer };
      ackSeqs.push(e.seq);
    }
    const effects: Effect[] =
      next.mode === 'sync'
        ? ackSeqs.map((seq) => ({ type: 'send', to: next.leader, payload: { rep: 'ack', seq } }))
        : [];
    return [next, effects];
  }
  if (p && 'rep' in p && p.rep === 'ack' && s.role === 'leader') {
    const pend = s.pending[p.seq];
    if (!pend || ev.from === undefined) return [s, []]; // already acked / malformed
    const awaiting = pend.awaiting.filter((n) => n !== ev.from);
    if (awaiting.length === pend.awaiting.length) return [s, []]; // duplicate ack
    if (awaiting.length > 0) return [{ ...s, pending: { ...s.pending, [p.seq]: { ...pend, awaiting } } }, []];
    const pending = { ...s.pending };
    delete pending[p.seq];
    return [
      { ...s, pending, history: [...s.history, { type: 'ack', seq: p.seq, key: pend.entry.key, time: ev.time }] },
      [],
    ];
  }
  return [s, []];
}

function handleTimer(s: RepState, ev: ModuleEvent<RepPayload>): [RepState, Effect[]] {
  const p = ev.payload;
  if (!p || !('retransmit' in p)) return [s, []];
  const pend = s.pending[p.retransmit];
  if (!pend) return [s, []]; // fully acked — timer superseded
  return [
    s,
    [
      ...pend.awaiting.map((f): Effect => ({ type: 'send', to: f, payload: { rep: 'append', entry: pend.entry } })),
      { type: 'timer', delay: RETRANSMIT_MS, payload: { retransmit: p.retransmit } },
    ],
  ];
}

function leaderOf(states: Map<NodeId, RepState>): RepState | undefined {
  for (const s of states.values()) if (s.role === 'leader') return s;
  return undefined;
}

function isStale(read: Extract<RepHistory, { type: 'read' }>, acks: Extract<RepHistory, { type: 'ack' }>[]): boolean {
  return acks.some((a) => a.key === read.key && a.seq > read.returnedSeq && a.time <= read.time);
}

/**
 * Chaos-challenge verifier: a read that returned seq s while a same-key write
 * with seq' > s was acked at or before the read. Pure over module states.
 */
export interface StaleReadResult {
  read: Extract<RepHistory, { type: 'read' }>;
  ack: Extract<RepHistory, { type: 'ack' }>;
}

export function detectStaleRead(states: Map<NodeId, RepState>): StaleReadResult | null {
  const leader = leaderOf(states);
  if (!leader) return null;
  const acks = leader.history.filter((h): h is Extract<RepHistory, { type: 'ack' }> => h.type === 'ack');
  for (const s of states.values()) {
    for (const h of s.history) {
      if (h.type !== 'read') continue;
      for (const a of acks) {
        if (a.key === h.key && a.seq > h.returnedSeq && a.time <= h.time) return { read: h, ack: a };
      }
    }
  }
  return null;
}

export const replication: SimModule<RepState, RepPayload> = {
  id: 'replication-leader-follower',
  chaos: ['kill-node', 'partition', 'delay', 'drop', 'duplicate'],

  init(nodeId, config) {
    const [leader, ...followers] = config.nodeIds;
    return {
      self: nodeId,
      role: nodeId === leader ? 'leader' : 'follower',
      leader,
      followers,
      mode: (config.params?.mode as RepMode | undefined) ?? 'async',
      log: [],
      data: {},
      nextSeq: 1,
      pending: {},
      buffer: {},
      history: [],
    };
  },

  reduce(state, event): [RepState, Effect[]] {
    switch (event.kind) {
      case 'external':
        return handleClient(state, event);
      case 'message':
        return handleMessage(state, event);
      case 'timer':
        return handleTimer(state, event);
      default:
        return [state, []];
    }
  },

  metrics(states, time) {
    const leader = leaderOf(states);
    if (!leader) return [];
    let maxLag = 0;
    for (const s of states.values())
      if (s.role === 'follower') maxLag = Math.max(maxLag, leader.log.length - s.log.length);
    const acks = leader.history.filter((h): h is Extract<RepHistory, { type: 'ack' }> => h.type === 'ack');
    let staleReads = 0;
    for (const s of states.values()) for (const h of s.history) if (h.type === 'read' && isStale(h, acks)) staleReads++;
    return [
      { name: 'max-replication-lag', value: maxLag },
      { name: 'acked-writes', value: acks.length },
      { name: 'writes-per-sec', value: acks.filter((a) => a.time > time - 1000).length },
      { name: 'stale-reads', value: staleReads },
    ];
  },

  inspect(state) {
    return {
      role: state.role,
      mode: state.mode,
      applied: state.log.length,
      data: state.data,
      pendingWrites: Object.keys(state.pending).length,
      buffered: Object.keys(state.buffer).length,
    } as InspectorTree;
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/modules/replication.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Full suite, lint, typecheck, coverage**

Run: `npm test && npm run lint && npm run typecheck && npm run coverage`
Expected: all green; coverage gate holds.

- [ ] **Step 6: Commit**

```bash
git add src/modules/replication.ts src/modules/replication.test.ts
git commit -m "feat(modules): leader-follower replication with async/sync ack and stale-read detector"
```

---

### Task 10: Replication property tests (fast-check)

**Files:**
- Create: `src/modules/replication.property.test.ts`

**Interfaces:**
- Consumes: `replication`, `detectStaleRead`, `RepState`, `RepPayload` (Task 9).
- Produces: the Phase 1 DoD property — sync-acked writes survive follower death — plus prefix-consistency and verifier-soundness properties.

- [ ] **Step 1: Write the property tests**

```ts
// src/modules/replication.property.test.ts
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { Simulation } from '../engine';
import { detectStaleRead, replication, type RepPayload, type RepState } from './replication';

const NODES = ['L', 'F1', 'F2'];
const KEYS = ['a', 'b', 'c'];

interface Op {
  kind: 'write' | 'read';
  key: string;
  node: string;
}

const opArb: fc.Arbitrary<Op> = fc.record({
  kind: fc.constantFrom<'write' | 'read'>('write', 'read'),
  key: fc.constantFrom(...KEYS),
  node: fc.constantFrom(...NODES),
});

function runScenario(opts: {
  mode: 'async' | 'sync';
  seed: number;
  ops: Op[];
  killAt?: { opIndex: number; follower: string };
  readsOnLeaderOnly?: boolean;
}) {
  const sim = new Simulation<RepState, RepPayload>({
    module: replication,
    config: { nodeIds: NODES, params: { mode: opts.mode } },
    seed: opts.seed,
    network: { latency: [1, 50] },
  });
  sim.runSteps(3);
  let t = 0;
  opts.ops.forEach((op, i) => {
    t += 20;
    sim.runUntil(t);
    if (opts.killAt && opts.killAt.opIndex === i) sim.control({ type: 'kill', node: opts.killAt.follower });
    if (op.kind === 'write') sim.external('L', { cmd: 'write', key: op.key, value: `v${i}` });
    else sim.external(opts.readsOnLeaderOnly ? 'L' : op.node, { cmd: 'read', key: op.key });
  });
  sim.runUntil(t + 3000);
  return sim;
}

test('DoD property: a sync-acked write is never lost when one follower dies', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 2 ** 30 }),
      fc.array(opArb, { minLength: 1, maxLength: 15 }),
      fc.nat({ max: 14 }),
      fc.constantFrom('F1', 'F2'),
      (seed, ops, killIndex, follower) => {
        const sim = runScenario({ mode: 'sync', seed, ops, killAt: { opIndex: killIndex % ops.length, follower } });
        const leader = sim.getState('L');
        const acks = leader.history.filter((h) => h.type === 'ack');
        const alive = NODES.filter((id) => !sim.deadNodes().includes(id));
        for (const a of acks) {
          for (const id of alive) {
            // in-order apply ⇒ having seq n means having every entry ≤ n
            expect(sim.getState(id).log.length).toBeGreaterThanOrEqual(a.seq);
          }
        }
      },
    ),
    { numRuns: 50 },
  );
});

test('property: follower log is always a prefix of the leader log', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 2 ** 30 }),
      fc.constantFrom<'async' | 'sync'>('async', 'sync'),
      fc.array(opArb, { minLength: 1, maxLength: 15 }),
      (seed, mode, ops) => {
        const sim = runScenario({ mode, seed, ops });
        const leaderLog = sim.getState('L').log;
        for (const id of ['F1', 'F2']) {
          const flog = sim.getState(id).log;
          expect(flog).toEqual(leaderLog.slice(0, flog.length));
        }
      },
    ),
    { numRuns: 50 },
  );
});

test('property: verifier never fires when all reads go to the leader', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 2 ** 30 }),
      fc.constantFrom<'async' | 'sync'>('async', 'sync'),
      fc.array(opArb, { minLength: 1, maxLength: 15 }),
      (seed, mode, ops) => {
        const sim = runScenario({ mode, seed, ops, readsOnLeaderOnly: true });
        const states = new Map(NODES.map((id) => [id, sim.getState(id)] as const));
        expect(detectStaleRead(states)).toBeNull();
      },
    ),
    { numRuns: 50 },
  );
});
```

- [ ] **Step 2: Run the properties**

Run: `npx vitest run src/modules/replication.property.test.ts`
Expected: PASS (3 properties × 50 runs). If a property fails, fast-check prints the shrunken counterexample — fix the module, not the property.

- [ ] **Step 3: Full suite + coverage**

Run: `npm test && npm run coverage`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add src/modules/replication.property.test.ts
git commit -m "test(modules): replication property suite — acked-write durability, prefix consistency, verifier soundness"
```

---

### Task 11: Replication lab page

**Files:**
- Create: `src/ui/labs/replication/ReplicationLab.tsx`, `src/ui/labs/replication/ClientControls.tsx`
- Modify: `src/ui/App.tsx` (tab switch between labs)

**Interfaces:**
- Consumes: kit + bridge + `replication` module.
- Produces: `ReplicationLab()` exporting nothing else; internally exposes its `SimDriver<RepState, RepPayload>` to `ChallengePanel` (Task 12) via prop. `ClientControls({ nodeIds, leader, onWrite, onRead })`. Mode toggle rebuilds the sim (new driver, store reset).

- [ ] **Step 1: Implement ClientControls**

```tsx
// src/ui/labs/replication/ClientControls.tsx
import { useState } from 'react';
import type { NodeId } from '../../../engine';

const btn =
  'px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-600 text-xs font-mono';

export function ClientControls({
  nodeIds,
  leader,
  onWrite,
  onRead,
}: {
  nodeIds: NodeId[];
  leader: NodeId;
  onWrite: (key: string, value: string) => void;
  onRead: (node: NodeId, key: string) => void;
}) {
  const [key, setKey] = useState('x');
  const [value, setValue] = useState('1');
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
      <input className="w-16 bg-slate-900 border border-slate-600 rounded px-1 py-0.5" value={key} onChange={(e) => setKey(e.target.value)} aria-label="key" />
      <input className="w-16 bg-slate-900 border border-slate-600 rounded px-1 py-0.5" value={value} onChange={(e) => setValue(e.target.value)} aria-label="value" />
      <button className={btn} onClick={() => onWrite(key, value)}>
        write → {leader}
      </button>
      {nodeIds.map((id) => (
        <button key={id} className={btn} onClick={() => onRead(id, key)}>
          read @ {id}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Implement ReplicationLab**

```tsx
// src/ui/labs/replication/ReplicationLab.tsx
import { useEffect, useRef, useState } from 'react';
import { Simulation } from '../../../engine';
import { replication, type RepMode, type RepPayload, type RepState } from '../../../modules/replication';
import { SimDriver } from '../../bridge/SimDriver';
import { useSimStore } from '../../bridge/simStore';
import { ChaosToolbar } from '../../kit/ChaosToolbar';
import { ClusterView } from '../../kit/ClusterView';
import { MetricsPanel } from '../../kit/MetricsPanel';
import { TimelineScrubber } from '../../kit/TimelineScrubber';
import { ChallengePanel } from './ChallengePanel';
import { ClientControls } from './ClientControls';

const NODE_IDS = ['L', 'F1', 'F2'];

export function ReplicationLab() {
  const [mode, setMode] = useState<RepMode>('async');
  const [epoch, setEpoch] = useState(0); // bump to rebuild with a fresh seed
  const ref = useRef<{ driver: SimDriver<RepState, RepPayload>; key: string } | null>(null);
  const simKey = `${mode}:${epoch}`;
  if (!ref.current || ref.current.key !== simKey) {
    ref.current?.driver.pause();
    useSimStore.getState().reset();
    const seed = 1000 + epoch;
    const sim = new Simulation<RepState, RepPayload>({
      module: replication,
      config: { nodeIds: NODE_IDS, params: { mode } },
      seed,
      network: { latency: [10, 80] },
    });
    ref.current = {
      driver: new SimDriver({ sim, seed, publish: (v) => useSimStore.getState().publish(v) }),
      key: simKey,
    };
  }
  const driver = ref.current.driver;
  useEffect(() => () => driver.pause(), [driver]);
  const view = useSimStore();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 text-xs font-mono">
        <span>replication:</span>
        {(['async', 'sync'] as const).map((m) => (
          <label key={m} className="flex items-center gap-1">
            <input type="radio" checked={mode === m} onChange={() => setMode(m)} />
            {m}
          </label>
        ))}
        <button
          className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-600"
          onClick={() => setEpoch((e) => e + 1)}
        >
          reset (new seed)
        </button>
      </div>
      <TimelineScrubber
        processed={view.processed}
        pending={view.pending}
        running={view.running}
        onPlayPause={() => (view.running ? driver.pause() : driver.start())}
        onStep={() => driver.stepOnce()}
        onScrub={(i) => driver.scrubTo(i)}
      />
      <div className="flex gap-6 items-start">
        <ClusterView nodes={view.nodes} inFlight={view.inFlight} time={view.time} />
        <MetricsPanel history={view.metricsHistory} />
      </div>
      <ClientControls
        nodeIds={NODE_IDS}
        leader="L"
        onWrite={(key, value) => driver.external('L', { cmd: 'write', key, value })}
        onRead={(node, key) => driver.external(node, { cmd: 'read', key })}
      />
      <ChaosToolbar
        caps={replication.chaos}
        nodeIds={NODE_IDS}
        deadNodes={view.nodes.filter((n) => n.dead).map((n) => n.id)}
        onAction={(a) => driver.control(a)}
      />
      <ChallengePanel driver={driver} />
    </div>
  );
}
```

Note: `ChallengePanel` arrives in Task 12. To keep this task independently green, create a placeholder now:

```tsx
// src/ui/labs/replication/ChallengePanel.tsx
import type { SimDriver } from '../../bridge/SimDriver';
import type { RepPayload, RepState } from '../../../modules/replication';

/** Replaced with the real challenge in the next task. */
export function ChallengePanel(_props: { driver: SimDriver<RepState, RepPayload> }) {
  return null;
}
```

- [ ] **Step 3: Wire the tab switch in App**

Replace `src/ui/App.tsx`:

```tsx
import { useState } from 'react';
import { PingPongLab } from './labs/pingpong/PingPongLab';
import { ReplicationLab } from './labs/replication/ReplicationLab';

const TABS = ['replication', 'pingpong'] as const;
type Tab = (typeof TABS)[number];

export default function App() {
  const [tab, setTab] = useState<Tab>('replication');
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-6 space-y-6">
      <header className="flex items-baseline gap-6">
        <h1 className="text-2xl font-bold">DDIA Visualized</h1>
        <nav className="flex gap-2 text-sm">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-2 py-1 rounded ${tab === t ? 'bg-sky-700' : 'bg-slate-800 hover:bg-slate-700'}`}
            >
              {t}
            </button>
          ))}
        </nav>
      </header>
      {tab === 'replication' ? <ReplicationLab /> : <PingPongLab />}
    </main>
  );
}
```

- [ ] **Step 4: Gates + manual smoke**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: all green.
Then `npm run dev`: async mode → write, immediately read @ F1 → `stale-reads` metric ticks up; sync mode → write with a follower killed → never acks until revive.

- [ ] **Step 5: Commit**

```bash
git add src/ui
git commit -m "feat(ui): replication lab — client controls, mode toggle, kit assembly"
```

---

### Task 12: Challenge panel + predict-before-run

**Files:**
- Modify: `src/ui/labs/replication/ChallengePanel.tsx` (replace the placeholder)
- Test: `src/ui/labs/replication/ChallengePanel.test.tsx`

**Interfaces:**
- Consumes: `detectStaleRead`, `StaleReadResult` (Task 9); `SimDriver` (Task 6); `useSimStore` (`processed` as the re-check trigger).
- Produces: `ChallengePanel({ driver: SimDriver<RepState, RepPayload> })` — challenge lifecycle idle → predicting → running → won. localStorage keys: `ddia:ch05:stale-read:attempt` (counter), `ddia:ch05:stale-read:prediction:<n>`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/ui/labs/replication/ChallengePanel.test.tsx
// @vitest-environment jsdom
import { beforeEach, expect, test } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { Simulation } from '../../../engine';
import { replication, type RepPayload, type RepState } from '../../../modules/replication';
import { SimDriver } from '../../bridge/SimDriver';
import { useSimStore } from '../../bridge/simStore';
import { ChallengePanel } from './ChallengePanel';

function makeDriver() {
  const sim = new Simulation<RepState, RepPayload>({
    module: replication,
    config: { nodeIds: ['L', 'F1', 'F2'], params: { mode: 'async' } },
    seed: 5,
    network: { latency: [10, 80] },
  });
  return new SimDriver<RepState, RepPayload>({
    sim,
    seed: 5,
    publish: (v) => useSimStore.getState().publish(v),
    raf: () => 0,
    caf: () => undefined,
  });
}

beforeEach(() => {
  localStorage.clear();
  useSimStore.getState().reset();
});

test('prediction is stored on attempt start and win detected on stale read', () => {
  const driver = makeDriver();
  render(<ChallengePanel driver={driver} />);
  fireEvent.change(screen.getByPlaceholderText(/how will you cause/i), {
    target: { value: 'read follower before append arrives' },
  });
  fireEvent.click(screen.getByText('start attempt'));
  expect(localStorage.getItem('ddia:ch05:stale-read:prediction:1')).toBe('read follower before append arrives');

  act(() => {
    driver.stepOnce(); // init L
    driver.stepOnce(); // init F1
    driver.stepOnce(); // init F2
    driver.external('L', { cmd: 'write', key: 'x', value: '1' });
    driver.stepOnce(); // leader applies + acks (async)
    driver.external('F1', { cmd: 'read', key: 'x' }); // stale
    driver.stepOnce();
  });
  expect(screen.getByText(/challenge complete/i)).toBeTruthy();
  expect(screen.getByText(/read follower before append arrives/)).toBeTruthy();
});

test('attempt counter increments across attempts', () => {
  const driver = makeDriver();
  render(<ChallengePanel driver={driver} />);
  fireEvent.click(screen.getByText('start attempt'));
  expect(localStorage.getItem('ddia:ch05:stale-read:attempt')).toBe('1');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/labs/replication/ChallengePanel.test.tsx`
Expected: FAIL — placeholder renders null; no controls found.

- [ ] **Step 3: Implement**

```tsx
// src/ui/labs/replication/ChallengePanel.tsx
import { useEffect, useState } from 'react';
import { detectStaleRead, type RepPayload, type RepState, type StaleReadResult } from '../../../modules/replication';
import type { SimDriver } from '../../bridge/SimDriver';
import { useSimStore } from '../../bridge/simStore';

const ATTEMPT_KEY = 'ddia:ch05:stale-read:attempt';
const predictionKey = (n: number) => `ddia:ch05:stale-read:prediction:${n}`;

/**
 * Chaos Challenge #1 (DESIGN_PLAN §3): "Produce a stale read."
 * Predict-before-run: the prediction is captured before the attempt and
 * shown beside the engine-verified outcome — prediction vs reality.
 */
export function ChallengePanel({ driver }: { driver: SimDriver<RepState, RepPayload> }) {
  const processed = useSimStore((s) => s.processed);
  const [attempt, setAttempt] = useState<number | null>(null);
  const [prediction, setPrediction] = useState('');
  const [win, setWin] = useState<StaleReadResult | null>(null);

  useEffect(() => {
    if (attempt === null || win) return;
    const states = new Map(driver.sim.config.nodeIds.map((id) => [id, driver.sim.getState(id)] as const));
    const result = detectStaleRead(states);
    if (result) {
      setWin(result);
      driver.pause();
    }
  }, [processed, attempt, win, driver]);

  const start = () => {
    const n = Number(localStorage.getItem(ATTEMPT_KEY) ?? '0') + 1;
    localStorage.setItem(ATTEMPT_KEY, String(n));
    localStorage.setItem(predictionKey(n), prediction);
    setAttempt(n);
    setWin(null);
  };

  return (
    <section className="border border-slate-700 rounded p-3 space-y-2 max-w-xl">
      <h2 className="font-bold text-sm">Chaos Challenge: produce a stale read</h2>
      {attempt === null && (
        <>
          <textarea
            className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-xs font-mono"
            rows={2}
            placeholder="Predict first: how will you cause a stale read? (skippable)"
            value={prediction}
            onChange={(e) => setPrediction(e.target.value)}
          />
          <button
            className="px-2 py-1 rounded bg-sky-700 hover:bg-sky-600 text-xs font-mono"
            onClick={start}
          >
            start attempt
          </button>
        </>
      )}
      {attempt !== null && !win && (
        <p className="text-xs text-slate-400 font-mono">
          attempt #{attempt} running — make a read return older data than an acknowledged write.
        </p>
      )}
      {win && (
        <div className="text-xs font-mono space-y-1">
          <p className="text-emerald-400 font-bold">✓ challenge complete — stale read verified by the engine</p>
          <p>
            read <code>{win.read.key}</code> @ {win.read.node} returned seq {win.read.returnedSeq} at t=
            {win.read.time}, after write seq {win.ack.seq} was acked at t={win.ack.time}.
          </p>
          <p className="text-slate-400">
            your prediction: “{localStorage.getItem(predictionKey(attempt!)) || '(skipped)'}”
          </p>
          <button className="underline" onClick={() => setAttempt(null)}>
            try again
          </button>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/labs/replication/ChallengePanel.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Full gates + manual smoke**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green.
Manual: start attempt with prediction → async write → read @ F1 fast → win banner shows prediction vs verified stale read. Reload page → attempt counter persisted.

- [ ] **Step 6: Commit**

```bash
git add src/ui/labs/replication
git commit -m "feat(ui): stale-read chaos challenge with engine verifier and predict-before-run"
```

---

### Task 13: Debrief (MDX) + surprise journal + session export

**Files:**
- Create: `content/ch05/debrief.mdx`, `src/ui/labs/replication/Debrief.tsx`, `src/ui/kit/SurpriseJournal.tsx`, `src/mdx.d.ts`
- Modify: `vite.config.ts` (mdx plugin), `src/ui/App.tsx` (debrief tab), `src/ui/labs/replication/ReplicationLab.tsx` (export button)
- Test: `src/ui/kit/SurpriseJournal.test.tsx`

**Interfaces:**
- Consumes: `driver.exportSession(journal)` (Task 6).
- Produces: `SurpriseJournal()` persisting to localStorage key `ddia:ch05:journal`; `Debrief()` rendering the MDX; export button downloads `{seed, actions, journal}` JSON.

- [ ] **Step 1: Install MDX**

```bash
npm install -D @mdx-js/rollup @types/mdx
```

- [ ] **Step 2: Write the failing journal test**

```tsx
// src/ui/kit/SurpriseJournal.test.tsx
// @vitest-environment jsdom
import { beforeEach, expect, test } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { SurpriseJournal } from './SurpriseJournal';

beforeEach(() => localStorage.clear());

test('journal persists to localStorage and reloads', () => {
  const { container, unmount } = render(<SurpriseJournal />);
  fireEvent.change(container.querySelector('textarea')!, { target: { value: 'async ack lies to you' } });
  expect(localStorage.getItem('ddia:ch05:journal')).toBe('async ack lies to you');
  unmount();
  const second = render(<SurpriseJournal />);
  expect((second.container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('async ack lies to you');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/ui/kit/SurpriseJournal.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement journal, MDX config, debrief, export**

```tsx
// src/ui/kit/SurpriseJournal.tsx
import { useState } from 'react';

const KEY = 'ddia:ch05:journal';

/** Active-recall journal: what surprised you? Persists locally; exported with the session. */
export function SurpriseJournal() {
  const [text, setText] = useState(() => localStorage.getItem(KEY) ?? '');
  return (
    <label className="block space-y-1">
      <span className="text-xs font-bold">What surprised you?</span>
      <textarea
        className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-xs font-mono"
        rows={4}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          localStorage.setItem(KEY, e.target.value);
        }}
      />
    </label>
  );
}
```

`src/mdx.d.ts`:

```ts
declare module '*.mdx' {
  import type { ComponentType } from 'react';
  const MDXComponent: ComponentType<Record<string, unknown>>;
  export default MDXComponent;
}
```

`vite.config.ts` — add the plugin (MDX must run before react):

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import mdx from '@mdx-js/rollup';

export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [mdx(), react(), tailwindcss()],
});
```

`content/ch05/debrief.mdx`:

```mdx
# Chapter 5 — Replication: Debrief

## The trade-off you just played with

**Async replication** acks before followers confirm — fast writes, but the ack is a
promise the leader may not keep: a crash or a dropped append loses acknowledged data,
and followers serve stale reads in the lag window (you proved this in the challenge).

**Sync replication** acks only after every follower confirms — an acked write survives
any single follower failure (the property test pins this), but one slow or dead
follower stalls every write. Real systems compromise: semi-synchronous (one sync
follower), or quorum acks (Ch5's leaderless variant — a later lab iteration).

## What real systems do

- **PostgreSQL**: `synchronous_commit` / `synchronous_standby_names` — per-transaction
  choice on this exact dial.
- **MySQL**: semi-sync plugin — at least one follower ack.
- **Kafka**: `acks=1` vs `acks=all` + `min.insync.replicas` — same dial, log-speak.

## Terms

*replication lag* · *read-after-write consistency* · *monotonic reads* — the lag
window you exploited is why these read-consistency models exist.
```

`src/ui/labs/replication/Debrief.tsx`:

```tsx
import DebriefContent from '../../../../content/ch05/debrief.mdx';
import { SurpriseJournal } from '../../kit/SurpriseJournal';

export function Debrief() {
  return (
    <article className="prose prose-invert prose-sm max-w-xl space-y-4">
      <DebriefContent />
      <SurpriseJournal />
    </article>
  );
}
```

In `src/ui/App.tsx`, extend the tabs:

```tsx
import { useState } from 'react';
import { PingPongLab } from './labs/pingpong/PingPongLab';
import { Debrief } from './labs/replication/Debrief';
import { ReplicationLab } from './labs/replication/ReplicationLab';

const TABS = ['replication', 'debrief', 'pingpong'] as const;
type Tab = (typeof TABS)[number];

export default function App() {
  const [tab, setTab] = useState<Tab>('replication');
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-6 space-y-6">
      <header className="flex items-baseline gap-6">
        <h1 className="text-2xl font-bold">DDIA Visualized</h1>
        <nav className="flex gap-2 text-sm">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-2 py-1 rounded ${tab === t ? 'bg-sky-700' : 'bg-slate-800 hover:bg-slate-700'}`}
            >
              {t}
            </button>
          ))}
        </nav>
      </header>
      {tab === 'replication' && <ReplicationLab />}
      {tab === 'debrief' && <Debrief />}
      {tab === 'pingpong' && <PingPongLab />}
    </main>
  );
}
```

In `src/ui/labs/replication/ReplicationLab.tsx`, add an export button next to the reset button (inside the mode-toggle row):

```tsx
        <button
          className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-600"
          onClick={() => {
            const json = driver.exportSession(localStorage.getItem('ddia:ch05:journal') ?? undefined);
            const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = `ddia-ch05-session-${driver.seed}.json`;
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          export session
        </button>
```

- [ ] **Step 5: Run tests + gates**

Run: `npx vitest run src/ui && npm test && npm run typecheck && npm run lint && npm run build`
Expected: all green; build bundles the MDX.

- [ ] **Step 6: Commit**

```bash
git add content src/ui src/mdx.d.ts vite.config.ts package.json package-lock.json
git commit -m "feat(ui): ch05 debrief (MDX), surprise journal, session export with journal"
```

---

### Task 14: DESIGN_PLAN v1.2 sync

**Files:**
- Modify: `docs/DESIGN_PLAN.en.md` (all edits below), `docs/DESIGN_PLAN.md` (changelog pointer)

**Interfaces:** none — documentation truth-sync per the approved spec ("Design-doc updates").

- [ ] **Step 1: Apply the EN edits**

In `docs/DESIGN_PLAN.en.md`:

1. After the v1.1 changelog blockquote line, add a new blockquote line:

```md
> **v1.2 changelog (Phase 1 kickoff, 2026-07-10):** Story mode replaced by annotated replay (§3). §5: contract bumped to v0.2 (events + metrics carry virtual time); snapshot interval fixed at N = 500; deep-clone wording corrected; chaos-vocabulary status notes added. §9: Phase 0 DoD checked off; Phase 1 DoD replaced by v2 (spec: `docs/superpowers/specs/2026-07-10-phase1-lab-kit-design.md`). Appendix: (c) resolved → GitHub Pages; share URLs deferred; added (e) RNG stream split. English version is canonical from v1.2.
```

2. §3 — append to the end of the "**Mode 1 — Story (guided walkthrough).**" paragraph:

```md
 *(v1.2: Story mode is dropped as a built deliverable — replaced by **annotated replay**: a recorded sandbox session (action log) annotated in MDX. The primary learner is the builder; authoring annotations is itself active recall.)*
```

3. §5 Timeline scrubber — replace `(plain objects, structural sharing on update)` with `(plain objects; the engine deep-clones via structuredClone on snapshot/restore)` and replace `(N ≈ 500–1000, tuned by benchmark in Phase 0)` with `(N = 500, validated by the Phase 0 scrub benchmark)`.

4. §5 contract snippet — replace the `interface SimModule<S, P> { ... }` code block with the v0.2 shape:

```ts
interface SimModule<S, P = unknown> {
  id: string;                                       // 'lsm-tree' | 'raft' | ...
  chaos: ChaosCapability[];                         // the vocabulary this lab supports
  init(nodeId: NodeId, config: ModuleConfig, rng: SeededRng): S;
  reduce(state: S, event: ModuleEvent<P>, rng: SeededRng): [S, Effect[]]; // pure; event carries virtual time
  metrics(states: Map<NodeId, S>, time: number): MetricSample[];  // countable numbers for the panel
  inspect(state: S): InspectorTree;                 // state exposed to the renderer
}
```

and change `v0.1 (validated by the Phase 0 engine, ...)` to `v0.2 (validated by the Phase 0 engine and the Phase 1 replication lab, src/engine/module.ts)`.

5. §5 chaos vocabulary paragraph — append:

```md
 *(v1.2 status: `reorder` is not a `ChaosCapability` — reordering emerges from randomized per-message latency. `clock-skew` and the storage family are declared vocabulary without an engine delivery path yet; decide before Ch3/Ch8 — see `docs/superpowers/plans/phase1-carry-forward.md`.)*
```

6. §9 Phase 0 DoD — flip all six `- [ ]` to `- [x]`.

7. §9 Phase 1 DoD — replace the six old items with:

```md
- [ ] Replication lab (leader-follower) sandbox + chaos runs in the browser.
- [ ] "Stale read" chaos challenge with an engine-verified win condition (no grading by eye).
- [ ] Metrics panel shows ≥ 3 live numbers (replication lag, write throughput, stale-read count).
- [ ] Predict-before-run and surprise journal persist across reload (localStorage).
- [ ] Property test: a write acknowledged under sync replication is never lost when 1 follower dies.
- [ ] Debrief page published with the Chapter 5 notes (in-repo MDX).
- [ ] CI green: typecheck + lint + coverage ≥ 80% (engine+modules) + 10k-scrub benchmark.
- [ ] Bundle ≤ 500 KB gzip (measured in CI).
- [ ] Site live on GitHub Pages, deployed by CI from master.
```

8. Appendix — replace item **(c)** with:

```md
- **(c) Deploy target — RESOLVED (v1.2):** GitHub Pages, deployed by GitHub Actions from master. Custom domain still open.
```

and append:

```md
- **(e) RNG stream split:** module logic and network chaos share one SeededRng stream — a reducer's extra draw shifts downstream network fates for the same seed. Split into decoupled streams if per-module hash stability matters. Decide before Phase 3 (Raft election jitter). See `docs/superpowers/plans/phase1-carry-forward.md`.
- **(f) Share URLs `?seed=&scenario=`:** deferred from Phase 1 (v1.2) — action-log export/import covers the self-learning use case; revisit when labs get an audience.
```

- [ ] **Step 2: Add the VI pointer**

In `docs/DESIGN_PLAN.md`, after the v1.1 changelog blockquote, add:

```md
> **v1.2 (2026-07-10):** Từ v1.2, bản tiếng Anh `DESIGN_PLAN.en.md` là bản canonical — Story mode → annotated replay, contract v0.2, DoD Phase 1 v2, chốt deploy GitHub Pages. Bản tiếng Việt này giữ nguyên nội dung v1.1 làm tài liệu gốc.
```

- [ ] **Step 3: Verify + commit**

Run: `grep -c '\[x\]' docs/DESIGN_PLAN.en.md` — expected ≥ 6.

```bash
git add docs/DESIGN_PLAN.en.md docs/DESIGN_PLAN.md
git commit -m "docs: DESIGN_PLAN v1.2 — annotated replay, contract v0.2, Phase 1 DoD v2, Pages deploy resolved"
```

---

### Task 15: GitHub repo, Pages deploy, bundle budget

**Files:**
- Modify: `.github/workflows/ci.yml` (build + budget in `test`; new `deploy` job)

**Interfaces:**
- Consumes: `test` job (Task 4), `npm run build` (Task 5), `BASE_PATH` env in `vite.config.ts`.
- Produces: live site at `https://<owner>.github.io/ddia-visualized/`.

- [ ] **Step 1: USER CONFIRMATION GATE**

Creating and pushing a public repo is outward-facing. Ask the user to confirm repo name/visibility before running:

```bash
gh repo create ddia-visualized --public --source=. --remote=origin --push
```

- [ ] **Step 2: Extend the workflow**

Replace `.github/workflows/ci.yml` with:

```yaml
name: CI
on:
  push:
    branches: [master]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm run coverage
      - run: npm run build
      - name: Bundle budget (app shell + engine ≤ 500 KB gzip)
        run: |
          size=$(cat dist/assets/*.js | gzip -c | wc -c)
          echo "gzipped JS bytes: $size"
          test "$size" -le 512000

  deploy:
    if: github.ref == 'refs/heads/master'
    needs: test
    runs-on: ubuntu-latest
    permissions:
      pages: write
      id-token: write
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: BASE_PATH=/ddia-visualized/ npm run build
      - uses: actions/configure-pages@v5
        with:
          enablement: true
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 3: Local budget pre-check**

Run: `npm run build && size=$(cat dist/assets/*.js | gzip -c | wc -c) && echo "gzipped: $size bytes" && test "$size" -le 512000 && echo OK`
Expected: `OK`. If over budget: lazy-load Recharts (`React.lazy` around MetricsPanel) before pushing.

- [ ] **Step 4: Commit + push + verify**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: Pages deploy job + bundle budget gate"
git push -u origin master
```

Then: `gh run watch` until both jobs green; open `https://<owner>.github.io/ddia-visualized/` — replication lab loads, challenge winnable. This closes the DoD items "CI green", "Bundle ≤ 500 KB gzip", "Site live on GitHub Pages".

---

## Self-Review (done at authoring time)

- **Spec coverage:** every spec section maps to a task — scope→1-13, architecture→5-8, engine v0.2→1-3, replication→9-10, challenge/pedagogy→12, debrief/journal/export→13, doc sync→14, CI/Pages/budget→4+15. Deferred items (Story, worker, share URLs, RNG split) correctly absent.
- **Placeholder scan:** none — all steps carry code/commands.
- **Type consistency:** `InFlightMessage`, `deadNodes()`, `metrics(states, time)`, `PublishedView`, `SimDriver` option names, `RepState`/`RepPayload`/`detectStaleRead` cross-checked across tasks 1-13.
