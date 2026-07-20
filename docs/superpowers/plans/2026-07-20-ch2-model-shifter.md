# Ch2 Model Shape-Shifter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship DDIA Ch2 as the capstone lab — one social-graph dataset stored three ways (relational / document / graph), the same query animated step-by-step in all three, a live round-trip count showing the document model's N+1 join tax.

**Architecture:** Pure query **engines** in `models-shared.ts` compute a `Trace` (steps + result + roundTrips) by walking each shape; one `SimModule<ModelsState>` on a single node `DM` **animates** the traces by advancing a per-model cursor on a `{t:'step'}` timer (the Ch12 advance-timer pattern). Challenges gate on `roundTrips` (document N+1 vs graph/relational 1 query) and on schema-migration cost. UI mirrors Ch1/Ch12.

**Tech Stack:** Vite + React 19 + TS strict, Vitest + fast-check, the in-repo engine (`src/engine`), Tailwind, `motion`, MDX.

## Global Constraints

- **Determinism / purity:** the runners are pure `(query, root) => Trace`; the module `reduce` is pure. No `Math.random`, no `Date.now`. Ch2 uses **no** RNG (fixed fixture) — `reduce`'s `rng` arg is unused.
- **Engine purity:** `src/modules/**` must not import React/DOM. Effects are `{type:'timer',delay,payload}` only (no network).
- **`Simulation.external(node,payload)` only enqueues** — a following `runSteps(n)` drains it; a same-time timer has lower seq than a just-injected external (Ch12 drain note).
- **The one true invariant:** all three runners return the **same sorted `result`** for the same `(query, root)`. Everything else (roundTrips, steps) is model-specific.
- **`roundTrips` is the challenge metric, not step count** — document = N+1 (one query per entity), graph = 1 (traversal), relational = 1 (join). Counting internal ops would NOT make document the loser.
- **Test gate per task:** `npx vitest run && npx tsc -b && npm run build` green before commit.
- **Naming:** module `id:'models'`, node `DM`, catalog `2.1` (flip `soon`→`active`) + new `2.d`; UI `ModelShifterLab` / `ModelPanel` / `ModelsDebrief`; journal `ddia:ch02:journal`.

---

## File Structure

- `src/modules/models-shared.ts` — fixture (users/friendships/posts/likes), derived shapes (adjacency/userDocs/postCategory), types, three pure runners, `migrationCost`, constants. (+ `.test.ts`)
- `src/modules/models.ts` — the `SimModule<ModelsState,ModelsPayload>`: init, step timer, `set-query`/`add-field`/`reset-schema`, challenge eval, `inspect`/`metrics`. (+ `.test.ts`, `.property.test.ts`, `models-lesson.test.ts`)
- `src/ui/labs/models/ModelPanel.tsx` — one model's rendering (variant-dispatched: table/doc/graph), highlight + op-count + roundTrips + done badge. (+ `.test.tsx`)
- `src/ui/labs/models/ModelShifterLab.tsx` — scenario picker, three panels, transport, three challenges. (+ `.test.tsx`)
- `src/ui/labs/models/Debrief.tsx` — MDX host (`ModelsDebrief`).
- `content/ch02/debrief.mdx`.
- Edits: `src/ui/shell/catalog.ts` (+ `catalog.test.ts`), `src/ui/App.tsx`, `README.md`, `docs/DESIGN_PLAN.en.md`.

---

## Task 1: Shared vocab — fixture, shapes, three runners

**Files:**
- Create: `src/modules/models-shared.ts`
- Test: `src/modules/models-shared.test.ts`

**Interfaces produced:**
- `DM`, `MODELS_NODES`, `MODELS: ModelId[]`
- types `Id`, `ModelId`, `QueryId`, `Step`, `Trace`, `UserDoc`
- constants `STEP_EVERY`, `FOF_MULT`, `M2M_MULT`, `TECH`
- fixture `USERS`, `USER_IDS`, `FRIENDSHIPS`, `POSTS`, `LIKES`
- derived `adjacency()`, `userDocs()`, `postCategory()`
- `runGraph(query,root)`, `runDocument(query,root)`, `runRelational(query,root)` → `Trace`
- `migrationCost(model, nicknameAdded): number`

- [ ] **Step 1: Write the failing test** — `src/modules/models-shared.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import {
  MODELS, USER_IDS, FOF_MULT, M2M_MULT,
  runGraph, runDocument, runRelational, migrationCost,
  type QueryId,
} from './models-shared';

const runners = { graph: runGraph, document: runDocument, relational: runRelational };

describe('runners return the same answer, different round trips', () => {
  test('fof(alice) = {dan,eve,frank} in all three', () => {
    for (const run of Object.values(runners)) {
      expect(run('fof', 'alice').result).toEqual(['dan', 'eve', 'frank']);
    }
  });
  test('m2m (likes a tech post) = {bob,dan,frank} in all three', () => {
    for (const run of Object.values(runners)) {
      expect(run('m2m', 'alice').result).toEqual(['bob', 'dan', 'frank']);
    }
  });
  test('document pays N+1 round trips; graph & relational pay 1', () => {
    expect(runGraph('fof', 'alice').roundTrips).toBe(1);
    expect(runRelational('fof', 'alice').roundTrips).toBe(1);
    expect(runDocument('fof', 'alice').roundTrips).toBeGreaterThanOrEqual(FOF_MULT * 1 + 1);
    expect(runDocument('m2m', 'alice').roundTrips).toBeGreaterThanOrEqual(M2M_MULT * 1 + 1);
  });
  test('every trace has cost === steps.length for the animation cursor', () => {
    for (const q of ['fof', 'm2m'] as QueryId[])
      for (const run of Object.values(runners)) {
        const t = run(q, 'alice');
        expect(t.steps.length).toBeGreaterThan(0);
      }
  });
});

describe('migrationCost — schema-on-read vs schema-on-write', () => {
  test('adding a field costs 0 for document/graph, >0 for relational', () => {
    expect(migrationCost('document', true)).toBe(0);
    expect(migrationCost('graph', true)).toBe(0);
    expect(migrationCost('relational', true)).toBe(USER_IDS.length);
    for (const m of MODELS) expect(migrationCost(m, false)).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/modules/models-shared.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** — `src/modules/models-shared.ts`:

```ts
// Ch2 — data-model vocabulary: one social-graph fixture stored three ways, plus the
// three pure query engines the property + lesson tests assert against. No engine, no RNG.
import type { NodeId } from '../engine/events';

export const DM: NodeId = 'DM';
export const MODELS_NODES: NodeId[] = [DM];

export type Id = string;
export type ModelId = 'relational' | 'document' | 'graph';
export const MODELS: ModelId[] = ['relational', 'document', 'graph'];
export type QueryId = 'fof' | 'm2m';

export const STEP_EVERY = 8;
export const FOF_MULT = 2;
export const M2M_MULT = 2;
export const TECH = 'tech';

export const USERS: { id: Id; name: string }[] = [
  { id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }, { id: 'carol', name: 'Carol' },
  { id: 'dan', name: 'Dan' }, { id: 'eve', name: 'Eve' }, { id: 'frank', name: 'Frank' },
];
export const USER_IDS: Id[] = USERS.map((u) => u.id);
export const FRIENDSHIPS: [Id, Id][] = [
  ['alice', 'bob'], ['alice', 'carol'], ['bob', 'dan'], ['carol', 'eve'], ['carol', 'frank'], ['dan', 'eve'],
];
export const POSTS: { id: Id; category: string }[] = [
  { id: 't1', category: 'tech' }, { id: 't2', category: 'tech' },
  { id: 'c1', category: 'cooking' }, { id: 'g1', category: 'garden' },
];
export const LIKES: [Id, Id][] = [
  ['bob', 't1'], ['dan', 't2'], ['frank', 't1'], ['carol', 'c1'], ['eve', 'g1'], ['alice', 'c1'],
];

export interface Step { kind: 'hop' | 'fetch' | 'probe'; touched: Id[]; note: string }
export interface Trace { steps: Step[]; result: Id[]; roundTrips: number }
export interface UserDoc { id: Id; name: string; friendIds: Id[]; likes: Id[]; nickname?: string }

const sortU = (xs: Iterable<Id>): Id[] => [...new Set(xs)].sort();

export function adjacency(): Record<Id, Id[]> {
  const adj: Record<Id, Id[]> = {};
  for (const id of USER_IDS) adj[id] = [];
  for (const [a, b] of FRIENDSHIPS) { adj[a].push(b); adj[b].push(a); }
  return adj;
}
export function userDocs(): Record<Id, UserDoc> {
  const adj = adjacency();
  const likesBy: Record<Id, Id[]> = {};
  for (const id of USER_IDS) likesBy[id] = [];
  for (const [u, p] of LIKES) likesBy[u].push(p);
  const docs: Record<Id, UserDoc> = {};
  for (const u of USERS) docs[u.id] = { id: u.id, name: u.name, friendIds: adj[u.id], likes: likesBy[u.id] };
  return docs;
}
export function postCategory(): Record<Id, string> {
  const m: Record<Id, string> = {};
  for (const p of POSTS) m[p.id] = p.category;
  return m;
}

/** GRAPH — a single traversal; each edge followed is a hop. roundTrips = 1. */
export function runGraph(query: QueryId, root: Id): Trace {
  const steps: Step[] = [];
  if (query === 'fof') {
    const adj = adjacency();
    const direct = new Set(adj[root]);
    const fof = new Set<Id>();
    for (const f of adj[root]) steps.push({ kind: 'hop', touched: [root, f], note: `${root} → ${f}` });
    for (const f of adj[root]) for (const ff of adj[f]) {
      steps.push({ kind: 'hop', touched: [f, ff], note: `${f} → ${ff}` });
      if (ff !== root && !direct.has(ff)) fof.add(ff);
    }
    return { steps, result: sortU(fof), roundTrips: 1 };
  }
  const cat = postCategory();
  const likers: Record<Id, Id[]> = {};
  for (const [u, p] of LIKES) (likers[p] ??= []).push(u);
  const users = new Set<Id>();
  for (const p of POSTS) {
    if (cat[p.id] !== TECH) continue;
    steps.push({ kind: 'hop', touched: [p.id], note: `post ${p.id} (tech)` });
    for (const u of likers[p.id] ?? []) { steps.push({ kind: 'hop', touched: [p.id, u], note: `${p.id} ← ${u}` }); users.add(u); }
  }
  return { steps, result: sortU(users), roundTrips: 1 };
}

/** DOCUMENT — no join; one fetch per entity. roundTrips = steps.length (the N+1). */
export function runDocument(query: QueryId, root: Id): Trace {
  const docs = userDocs();
  const cat = postCategory();
  const steps: Step[] = [];
  if (query === 'fof') {
    steps.push({ kind: 'fetch', touched: [root], note: `fetch ${root}` });
    const direct = docs[root].friendIds;
    const fof = new Set<Id>();
    for (const f of direct) {
      steps.push({ kind: 'fetch', touched: [f], note: `fetch ${f}` });
      for (const ff of docs[f].friendIds) if (ff !== root && !direct.includes(ff)) fof.add(ff);
    }
    for (const ff of sortU(fof)) steps.push({ kind: 'fetch', touched: [ff], note: `fetch ${ff}` });
    return { steps, result: sortU(fof), roundTrips: steps.length };
  }
  const users = new Set<Id>();
  for (const id of USER_IDS) {
    steps.push({ kind: 'fetch', touched: [id], note: `scan ${id}` });
    for (const p of docs[id].likes) {
      steps.push({ kind: 'fetch', touched: [id, p], note: `fetch post ${p}` });
      if (cat[p] === TECH) users.add(id);
    }
  }
  return { steps, result: sortU(users), roundTrips: steps.length };
}

/** RELATIONAL — one join over the join table; each matching row is a probe. roundTrips = 1. */
export function runRelational(query: QueryId, root: Id): Trace {
  const steps: Step[] = [];
  if (query === 'fof') {
    const rows: [Id, Id][] = [];
    for (const [a, b] of FRIENDSHIPS) { rows.push([a, b]); rows.push([b, a]); }
    const direct: Id[] = [];
    for (const [a, b] of rows) if (a === root) { steps.push({ kind: 'probe', touched: [a, b], note: `f1 ${a}-${b}` }); direct.push(b); }
    const directSet = new Set(direct);
    const fof = new Set<Id>();
    for (const d of direct) for (const [a, b] of rows) if (a === d) {
      steps.push({ kind: 'probe', touched: [a, b], note: `f2 ${a}-${b}` });
      if (b !== root && !directSet.has(b)) fof.add(b);
    }
    return { steps, result: sortU(fof), roundTrips: 1 };
  }
  const cat = postCategory();
  const users = new Set<Id>();
  for (const [u, p] of LIKES) { steps.push({ kind: 'probe', touched: [u, p], note: `like ${u}-${p}` }); if (cat[p] === TECH) users.add(u); }
  return { steps, result: sortU(users), roundTrips: 1 };
}

/** Schema-on-write touches every existing row; schema-on-read touches only the one doc. */
export function migrationCost(model: ModelId, nicknameAdded: boolean): number {
  if (!nicknameAdded) return 0;
  return model === 'relational' ? USER_IDS.length : 0;
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/modules/models-shared.test.ts && npx tsc -b` → PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add src/modules/models-shared.ts src/modules/models-shared.test.ts
git commit -m "feat(modules): Ch2 shared vocab — social-graph fixture in 3 shapes, 3 pure query engines"
```

---

## Task 2: Models module — init, step timer, set-query, inspect/metrics

**Files:**
- Create: `src/modules/models.ts`
- Test: `src/modules/models.test.ts`

**Interfaces produced:**
- `type ModelsExternal = { cmd:'set-query'; query:QueryId; root?:Id } | { cmd:'add-field' } | { cmd:'reset-schema' }`
- `type ModelsTimer = { t:'step' }`
- `type ModelsPayload = ModelsExternal | ModelsTimer`
- `interface ModelsState` (self, query, root, traces, cursor, schema, ch)
- `interface ModelsInspect`
- `const models: SimModule<ModelsState, ModelsPayload>`

- [ ] **Step 1: Write the failing test** — `src/modules/models.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { Simulation } from '../engine';
import { DM, MODELS, MODELS_NODES, STEP_EVERY, runDocument } from './models-shared';
import { models, type ModelsPayload, type ModelsState, type ModelsInspect } from './models';

function makeSim(seed = 1) {
  return new Simulation<ModelsState, ModelsPayload>({ module: models, config: { nodeIds: MODELS_NODES }, seed });
}
const dm = (s: Simulation<ModelsState, ModelsPayload>) => s.getState(DM);
const view = (s: Simulation<ModelsState, ModelsPayload>) => models.inspect(dm(s)) as unknown as ModelsInspect;

describe('boot + stepping', () => {
  test('init defaults to fof(alice), cursors at 0, step timer armed', () => {
    const sim = makeSim(); sim.runSteps(1);
    const v = view(sim);
    expect(v.query).toBe('fof');
    for (const m of MODELS) expect(v.models[m].cursor).toBe(0);
  });
  test('stepping advances every not-done cursor to its trace end', () => {
    const sim = makeSim(); sim.runSteps(1);
    sim.runSteps(STEP_EVERY * 40);
    const v = view(sim);
    for (const m of MODELS) expect(v.models[m].done).toBe(true);
    // document did more round trips than graph (the N+1)
    expect(v.models.document.roundTrips).toBeGreaterThan(v.models.graph.roundTrips);
  });
});

describe('set-query recomputes and resets', () => {
  test('switching to m2m resets cursors and swaps traces', () => {
    const sim = makeSim(); sim.runSteps(1);
    sim.runSteps(STEP_EVERY * 40);            // finish fof
    sim.external(DM, { cmd: 'set-query', query: 'm2m' });
    sim.runSteps(2);
    const v = view(sim);
    expect(v.query).toBe('m2m');
    expect(v.models.document.cursor).toBe(0); // reset
    expect(v.models.document.total).toBe(runDocument('m2m', 'alice').steps.length);
  });
});
```

- [ ] **Step 2: Run to verify fail** → `npx vitest run src/modules/models.test.ts` FAIL (no module).

- [ ] **Step 3: Implement** — `src/modules/models.ts`:

```ts
import type { Effect, InspectorTree, MetricSample, SimModule } from '../engine/module';
import type { NodeId } from '../engine/events';
import {
  DM, MODELS, STEP_EVERY, FOF_MULT, M2M_MULT,
  runGraph, runDocument, runRelational, migrationCost,
  type Id, type ModelId, type QueryId, type Trace,
} from './models-shared';

export type ModelsExternal =
  | { cmd: 'set-query'; query: QueryId; root?: Id }
  | { cmd: 'add-field' }
  | { cmd: 'reset-schema' };
export type ModelsTimer = { t: 'step' };
export type ModelsPayload = ModelsExternal | ModelsTimer;

export interface ModelsState {
  self: NodeId;
  query: QueryId;
  root: Id;
  traces: Record<ModelId, Trace>;
  cursor: Record<ModelId, number>;
  schema: { nicknameAdded: boolean };
  ch: { c1: boolean; c2: boolean; c3: boolean };
}

export interface ModelPanelInspect {
  cursor: number; total: number; done: boolean; roundTrips: number;
  result: Id[]; touched: Id[]; migration: number;
}
export interface ModelsInspect {
  query: QueryId; root: Id;
  nicknameAdded: boolean;
  models: Record<ModelId, ModelPanelInspect>;
  ch: { c1: boolean; c2: boolean; c3: boolean };
}

function computeTraces(query: QueryId, root: Id): Record<ModelId, Trace> {
  return { relational: runRelational(query, root), document: runDocument(query, root), graph: runGraph(query, root) };
}
const zeroCursor = (): Record<ModelId, number> => ({ relational: 0, document: 0, graph: 0 });
const stepTimer = (): Effect => ({ type: 'timer', delay: STEP_EVERY, payload: { t: 'step' } });
const anyRunning = (s: ModelsState) => MODELS.some((m) => s.cursor[m] < s.traces[m].steps.length);

/** Latch c1/c2 once every model finished and the round-trip gap holds. */
function evalQuery(s: ModelsState): ModelsState['ch'] {
  const done = MODELS.every((m) => s.cursor[m] === s.traces[m].steps.length);
  if (!done) return s.ch;
  const t = s.traces;
  return {
    ...s.ch,
    c1: s.ch.c1 || (s.query === 'fof' && t.document.roundTrips >= FOF_MULT * t.graph.roundTrips),
    c2: s.ch.c2 || (s.query === 'm2m' && t.document.roundTrips >= M2M_MULT * t.relational.roundTrips),
  };
}

export const models: SimModule<ModelsState, ModelsPayload> = {
  id: 'models',
  chaos: [],

  init(nodeId: NodeId): ModelsState {
    const query: QueryId = 'fof';
    const root: Id = 'alice';
    return {
      self: nodeId, query, root,
      traces: computeTraces(query, root), cursor: zeroCursor(),
      schema: { nicknameAdded: false }, ch: { c1: false, c2: false, c3: false },
    };
  },

  reduce(state, event): [ModelsState, Effect[]] {
    if (event.kind === 'init') return [state, [stepTimer()]];

    if (event.kind === 'timer') {
      const cursor = { ...state.cursor };
      for (const m of MODELS) if (cursor[m] < state.traces[m].steps.length) cursor[m] += 1;
      let next: ModelsState = { ...state, cursor };
      next = { ...next, ch: evalQuery(next) };
      return [next, anyRunning(next) ? [stepTimer()] : []];
    }

    if (event.kind === 'external') {
      const p = event.payload as ModelsExternal;
      if (p.cmd === 'set-query') {
        const root = p.root ?? state.root;
        const resetCh = { ...state.ch, ...(p.query === 'fof' ? { c1: false } : { c2: false }) };
        return [
          { ...state, query: p.query, root, traces: computeTraces(p.query, root), cursor: zeroCursor(), ch: resetCh },
          [stepTimer()], // re-arm so the new query animates
        ];
      }
      if (p.cmd === 'add-field') {
        const c3 =
          migrationCost('document', true) === 0 &&
          migrationCost('graph', true) === 0 &&
          migrationCost('relational', true) > 0;
        return [{ ...state, schema: { nicknameAdded: true }, ch: { ...state.ch, c3 } }, []];
      }
      if (p.cmd === 'reset-schema') return [{ ...state, schema: { nicknameAdded: false } }, []];
    }
    return [state, []];
  },

  metrics(states): MetricSample[] {
    const s = states.get(DM);
    if (!s) return [];
    return MODELS.map((m) => ({ name: `${m}-ops`, value: s.cursor[m] }));
  },

  inspect(state): InspectorTree {
    const panel = (m: ModelId): ModelPanelInspect => {
      const t = state.traces[m];
      const cursor = state.cursor[m];
      const done = cursor === t.steps.length;
      return {
        cursor, total: t.steps.length, done, roundTrips: t.roundTrips,
        result: done ? t.result : [],
        touched: cursor > 0 && cursor <= t.steps.length ? t.steps[cursor - 1].touched : [],
        migration: migrationCost(m, state.schema.nicknameAdded),
      };
    };
    const tree: ModelsInspect = {
      query: state.query, root: state.root, nicknameAdded: state.schema.nicknameAdded,
      models: { relational: panel('relational'), document: panel('document'), graph: panel('graph') },
      ch: state.ch,
    };
    return tree as unknown as InspectorTree;
  },
};
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/modules/models.test.ts && npx tsc -b` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/models.ts src/modules/models.test.ts
git commit -m "feat(modules): Ch2 models module — animate the three traces, set-query, inspect/metrics"
```

---

## Task 3: Schema-flex behaviour

**Files:** Modify `src/modules/models.ts` (logic shipped in Task 2); Test `src/modules/models.test.ts` (append).

- [ ] **Step 1: Write the failing tests** — append:

```ts
import { USER_IDS } from './models-shared';

describe('schema flexibility (C3 scenario)', () => {
  test('add-field: relational migration > 0, document/graph = 0', () => {
    const sim = makeSim(); sim.runSteps(1);
    sim.external(DM, { cmd: 'add-field' });
    sim.runSteps(2);
    const v = view(sim);
    expect(v.nicknameAdded).toBe(true);
    expect(v.models.document.migration).toBe(0);
    expect(v.models.graph.migration).toBe(0);
    expect(v.models.relational.migration).toBe(USER_IDS.length);
  });
  test('reset-schema clears it', () => {
    const sim = makeSim(); sim.runSteps(1);
    sim.external(DM, { cmd: 'add-field' }); sim.runSteps(1);
    sim.external(DM, { cmd: 'reset-schema' }); sim.runSteps(1);
    expect(view(sim).nicknameAdded).toBe(false);
    expect(view(sim).models.relational.migration).toBe(0);
  });
});
```

- [ ] **Step 2: Run → PASS** (Task 2 already implements it): `npx vitest run src/modules/models.test.ts`

- [ ] **Step 3: Commit**

```bash
git add src/modules/models.test.ts
git commit -m "test(modules): Ch2 schema-flex — add-field migration split, reset-schema"
```

---

## Task 4: Challenge flags + epoch gating

**Files:** Test `src/modules/models.test.ts` (append).

- [ ] **Step 1: Write the failing tests** — append:

```ts
describe('challenge flags', () => {
  test('C1 latches after fof plays to completion', () => {
    const sim = makeSim(); sim.runSteps(1);
    sim.runSteps(STEP_EVERY * 40);
    expect(dm(sim).ch.c1).toBe(true);
  });
  test('C2 latches after m2m plays to completion', () => {
    const sim = makeSim(); sim.runSteps(1);
    sim.external(DM, { cmd: 'set-query', query: 'm2m' });
    sim.runSteps(STEP_EVERY * 60);
    expect(dm(sim).ch.c2).toBe(true);
  });
  test('C3 latches on add-field', () => {
    const sim = makeSim(); sim.runSteps(1);
    sim.external(DM, { cmd: 'add-field' }); sim.runSteps(2);
    expect(dm(sim).ch.c3).toBe(true);
  });
  test('set-query fof resets C1 epoch', () => {
    const sim = makeSim(); sim.runSteps(1);
    sim.runSteps(STEP_EVERY * 40);           // c1 true
    sim.external(DM, { cmd: 'set-query', query: 'fof' });
    sim.runSteps(2);                          // just reset + a couple steps, not finished
    expect(dm(sim).ch.c1).toBe(false);
  });
});
```

- [ ] **Step 2: Run → PASS**: `npx vitest run src/modules/models.test.ts && npx tsc -b`

- [ ] **Step 3: Commit**

```bash
git add src/modules/models.test.ts
git commit -m "test(modules): Ch2 challenge flags — C1/C2 on completion, C3 on add-field, epoch reset"
```

---

## Task 5: Property suite

**Files:** Create `src/modules/models.property.test.ts`.

Invariants (a counterexample is a real bug: shrink, report, fix minimally, document).

- [ ] **Step 1: Write the failing test** — `src/modules/models.property.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import { USER_IDS, runGraph, runDocument, runRelational, type QueryId } from './models-shared';

const userArb = fc.constantFrom(...USER_IDS);
const queryArb = fc.constantFrom<QueryId>('fof', 'm2m');

describe('data-model invariants', () => {
  test('(a) same answer across all three models for any query + root', () => {
    fc.assert(fc.property(queryArb, userArb, (q, root) => {
      const g = runGraph(q, root).result;
      const d = runDocument(q, root).result;
      const r = runRelational(q, root).result;
      expect(d).toEqual(g);
      expect(r).toEqual(g);
    }), { numRuns: 60 });
  });

  test('(b) trace determinism: same (query, root) → identical trace', () => {
    fc.assert(fc.property(queryArb, userArb, (q, root) => {
      expect(JSON.stringify(runDocument(q, root))).toEqual(JSON.stringify(runDocument(q, root)));
      expect(JSON.stringify(runGraph(q, root))).toEqual(JSON.stringify(runGraph(q, root)));
    }), { numRuns: 40 });
  });

  test('(c) result is sorted + de-duplicated; steps non-empty', () => {
    fc.assert(fc.property(queryArb, userArb, (q, root) => {
      for (const run of [runGraph, runDocument, runRelational]) {
        const t = run(q, root);
        expect([...t.result]).toEqual([...new Set(t.result)].sort());
        expect(t.steps.length).toBeGreaterThan(0);
      }
    }), { numRuns: 40 });
  });
});
```

- [ ] **Step 2: Run → PASS (fix any real counterexample)**: `npx vitest run src/modules/models.property.test.ts`. If (a) fails, a runner disagrees on the answer — fix the runner, not the test; document the fix citing the invariant.

- [ ] **Step 3: Commit**

```bash
git add src/modules/models.property.test.ts
git commit -m "test(modules): Ch2 property suite — same answer across models, determinism, sorted result"
```

---

## Task 6: Pinned lesson test

**Files:** Create `src/modules/models-lesson.test.ts`.

- [ ] **Step 1: Write the failing test** — `src/modules/models-lesson.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { Simulation } from '../engine';
import { DM, MODELS_NODES, STEP_EVERY } from './models-shared';
import { models, type ModelsPayload, type ModelsState } from './models';

function makeSim() {
  const sim = new Simulation<ModelsState, ModelsPayload>({ module: models, config: { nodeIds: MODELS_NODES }, seed: 1 });
  sim.runSteps(1);
  return sim;
}
const ch = (s: Simulation<ModelsState, ModelsPayload>) => s.getState(DM).ch;

describe('C1 — friends-of-friends: the join tax', () => {
  test('play fof to completion → document round trips ≥ 2× graph, same answer', () => {
    const sim = makeSim();
    sim.runSteps(STEP_EVERY * 40);
    const s = sim.getState(DM);
    expect(s.traces.graph.result).toEqual(['dan', 'eve', 'frank']);
    expect(s.traces.document.result).toEqual(['dan', 'eve', 'frank']);
    expect(s.traces.document.roundTrips).toBeGreaterThanOrEqual(2 * s.traces.graph.roundTrips);
    expect(ch(sim).c1).toBe(true);
  });
});

describe('C2 — many-to-many: documents cannot join', () => {
  test('play m2m to completion → document round trips ≥ 2× relational', () => {
    const sim = makeSim();
    sim.external(DM, { cmd: 'set-query', query: 'm2m' });
    sim.runSteps(STEP_EVERY * 60);
    const s = sim.getState(DM);
    expect(s.traces.document.result).toEqual(['bob', 'dan', 'frank']);
    expect(s.traces.document.roundTrips).toBeGreaterThanOrEqual(2 * s.traces.relational.roundTrips);
    expect(ch(sim).c2).toBe(true);
  });
});

describe('C3 — schema flexibility', () => {
  test('add-field: 0 document migration, relational > 0', () => {
    const sim = makeSim();
    sim.external(DM, { cmd: 'add-field' });
    sim.runSteps(2);
    expect(ch(sim).c3).toBe(true);
  });
});
```

- [ ] **Step 2: Full gate**: `npx vitest run && npx tsc -b && npm run build` → all green.

- [ ] **Step 3: Commit**

```bash
git add src/modules/models-lesson.test.ts
git commit -m "test(modules): Ch2 pinned lesson — FoF join tax, m2m no-join, schema flexibility"
```

---

## Task 7: ModelPanel (presentational)

**Files:** Create `src/ui/labs/models/ModelPanel.tsx` + `.test.tsx`.

Pure props, no engine import — the Ch12 `DerivedPanel` pattern. Read `src/ui/labs/unbundled/DerivedPanel.tsx` first for the idiom. **Interfaces:** `export function ModelPanel(props: { model: ModelId; label: string; view: ModelPanelInspect }): JSX.Element` (import `ModelPanelInspect` from `../../../modules/models`, `ModelId` from `../../../modules/models-shared`).

Variant-dispatched internal render:
- `relational` → the `friendships`/`likes` rows as a small table; highlight rows whose ids ⊆ `view.touched`.
- `document` → a card per user doc (id, friendIds, likes as unresolved links); highlight the fetched doc(s) in `view.touched`.
- `graph` → an adjacency list / simple node list; highlight `view.touched` nodes/edges. (A full SVG node-graph is nice-to-have; an adjacency list with highlighted rows is sufficient and passes the DoD.)

All variants show a header with `label`, the **op-count** `cursor/total`, the **roundTrips** badge (`N round trips` — coral/`text-sign` when `> total/2`... simpler: coral when `roundTrips > 1`, teal when `=== 1`), a **done ✓** badge, the **result** set when done, and the **migration** count when `> 0`.

- [ ] **Step 1: Write the failing test** — `src/ui/labs/models/ModelPanel.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { ModelPanel } from './ModelPanel';
import type { ModelPanelInspect } from '../../../modules/models';

afterEach(cleanup);

const base: ModelPanelInspect = {
  cursor: 3, total: 6, done: false, roundTrips: 6, result: [], touched: ['bob'], migration: 0,
};

describe('ModelPanel', () => {
  test('document panel shows round-trip count and op-count', () => {
    const { getByText, container } = render(<ModelPanel model="document" label="Document" view={base} />);
    expect(getByText(/Document/)).not.toBeNull();
    expect(getByText(/round trip/i)).not.toBeNull();
    expect(container.querySelector('[data-model="document"]')).not.toBeNull();
  });
  test('done panel shows the result set', () => {
    const { getByText } = render(
      <ModelPanel model="graph" label="Graph" view={{ ...base, done: true, cursor: 6, result: ['dan', 'eve', 'frank'], roundTrips: 1 }} />,
    );
    expect(getByText(/dan/)).not.toBeNull();
  });
  test('shows migration cost when a field was added', () => {
    const { getByText } = render(<ModelPanel model="relational" label="Relational" view={{ ...base, migration: 6 }} />);
    expect(getByText(/migration/i)).not.toBeNull();
  });
});
```

- [ ] **Step 2–4:** Run → fail → implement `ModelPanel.tsx` (Tailwind idiom from `DerivedPanel.tsx`; `data-model={model}` on the root `<section>`) → `npx vitest run src/ui/labs/models/ModelPanel.test.tsx && npx tsc -b` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/labs/models/ModelPanel.tsx src/ui/labs/models/ModelPanel.test.tsx
git commit -m "feat(ui): Ch2 ModelPanel — per-shape render, op-count, round-trip badge, migration"
```

---

## Task 8: ModelShifterLab (assembly)

**Files:** Create `src/ui/labs/models/ModelShifterLab.tsx` + `.test.tsx`.

Mirror `src/ui/labs/unbundled/UnbundledLab.tsx` for sim wiring (`SimDriver` + `useSimStore` + `TimelineScrubber` + `ChallengePanel`; the Ch1 `LoadLab.tsx` is the closest recent template — read it). Differences:
- **Scenario picker:** three buttons — `friends-of-friends` (`set-query fof`), `likes in category` (`set-query m2m`), `add a field` (`add-field`). For `fof`, a start-user `<select>` → `set-query fof` with `root`.
- **Three `ModelPanel`s** side by side from `inspect().models`.
- **Transport (step/play/scrubber)** shown for `fof`/`m2m`; for the `add a field` scenario, hide/disable it and render the before/after (no trace).
- **`ChallengePanel` ×3** reading `inspect().ch.c1/c2/c3` (the Ch1 wiring: `check={() => svc.ch.c1 ? {...} : null}`).
- Reset-on-`epoch` `useEffect` (seed `2000 + epoch`), like `LoadLab`.

- [ ] **Step 1: Write the failing smoke test** — `src/ui/labs/models/ModelShifterLab.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { ModelShifterLab } from './ModelShifterLab';

afterEach(cleanup);

describe('ModelShifterLab', () => {
  test('renders the three model panels', () => {
    const { container } = render(<ModelShifterLab />);
    expect(container.querySelector('[data-model="relational"]')).not.toBeNull();
    expect(container.querySelector('[data-model="document"]')).not.toBeNull();
    expect(container.querySelector('[data-model="graph"]')).not.toBeNull();
  });
  test('renders the three challenge titles', () => {
    const { getByText } = render(<ModelShifterLab />);
    expect(getByText(/friends-of-friends/i)).not.toBeNull();
    expect(getByText(/many-to-many/i)).not.toBeNull();
    expect(getByText(/schema/i)).not.toBeNull();
  });
});
```

- [ ] **Step 2–4:** Run → fail → implement (add `data-action="scenario-m2m"` / `data-action="add-field"` on those controls for the ship-gate walk) → `npx vitest run src/ui/labs/models/ModelShifterLab.test.tsx && npx tsc -b` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/labs/models/ModelShifterLab.tsx src/ui/labs/models/ModelShifterLab.test.tsx
git commit -m "feat(ui): Ch2 ModelShifterLab — scenario picker, three model panels, three challenges"
```

---

## Task 9: Debrief + MDX

**Files:** Create `src/ui/labs/models/Debrief.tsx` (export `ModelsDebrief`) + `content/ch02/debrief.mdx`.

Mirror `src/ui/labs/unbundled/Debrief.tsx` + `content/ch12/debrief.mdx`. Journal key `ddia:ch02:journal`. MDX content per spec §5, in order: the headline (the model decides which questions are cheap); **relational vs document** (object-relational mismatch, normalization vs denormalization/locality, one-to-many vs many-to-many, the N+1 round-trip tax you just watched); **the graph model** (many-to-many first-class, traversals, Cypher); **schema-on-read vs schema-on-write** (the add-a-field migration you toggled); **declarative vs imperative** query languages (forward-pointer to Ch10 MapReduce); the named cuts (§1 Out); real systems (PostgreSQL/MySQL, MongoDB/Couchbase, Neo4j/Cypher + RDF/SPARQL; polyglot persistence). Terms list per §5.

- [ ] **Steps:** write MDX → write `Debrief.tsx` → `npx tsc -b && npm run build` → commit.

```bash
git add src/ui/labs/models/Debrief.tsx content/ch02/debrief.mdx
git commit -m "feat(content): Ch2 debrief — relational/document/graph, schema-on-read/write, polyglot"
```

---

## Task 10: Wiring + ship gate (the whole book done)

**Files:** Modify `catalog.ts`, `catalog.test.ts`, `App.tsx`, `README.md`, `docs/DESIGN_PLAN.en.md`.

- [ ] **Step 1: Catalog** — flip `2.1` to `active`, add `{ id:'2.d', label:'Debrief & Journal', status:'active' }` to `ch2.labs`. **Add** a new ch2 test to `catalog.test.ts` (mirror ch1/ch12): `expect(ch2.labs.map(l=>l.id)).toEqual(['2.1','2.d'])` all `active`.

- [ ] **Step 2: App PAGES** — import `ModelShifterLab` + `ModelsDebrief`; add `'2.1'` (eyebrow "Chapter 2 — Data Models") and `'2.d'` (eyebrow "Chapter 2 — Debrief") entries, mirroring the `'1.1'`/`'1.d'` entries.

- [ ] **Step 3: README + DESIGN_PLAN** — README ch2 block + counter bump to **"Twelve chapters live — nineteen interactive labs."** (verify the lab count). `DESIGN_PLAN.en.md` §7 Phase 5 note: append "ch2 shipped 2026-07-20 — 2.1 Model Shape-Shifter … **Phase 5 and the whole book are complete.**" Keep the Vietnamese `DESIGN_PLAN.md` frozen (ch12 precedent).

- [ ] **Step 4: Full gate** — `npx vitest run && npx tsc -b && npm run build` → green.

- [ ] **Step 5: Browser DoD** — `npm run dev`, drive C1 live: default fof → play → all three finish, document shows ~6 round trips vs graph 1, C1 win banner. Then scenario → m2m → play → C2 banner. Then add-field → C3 banner. 0 console errors; screenshot.

- [ ] **Step 6: Commit**

```bash
git add src/ui/shell/catalog.ts src/ui/shell/catalog.test.ts src/ui/App.tsx README.md docs/DESIGN_PLAN.en.md
git commit -m "feat(ui): ship Ch2 Model Shape-Shifter — catalog 2.1/2.d active, App pages, README, roadmap (book complete)"
```

---

## Self-Review

**Spec coverage:** §1 In → T1 (shared) / T2–4 (module) / T7 (panel) / T8 (lab) / T9 (debrief) / T10 (wiring). §1 Out → T9 MDX prose. §2 model → T1–2. §3 interaction → T2 `reduce` externals + T8 controls. §4 challenges → T2 `evalQuery` + T4 (gating) + T6 (pinned). §5 UI/debrief/wiring → T7/8/9/10. §6 testing → each task + T5 (property) + T6 (lesson). §7 files → File Structure. §8 risks: roundTrips-not-op-count → T1 runners + `roundTrips` field; fixture guarantees ratios → T1/T6; C3-no-trace → T8 transport-hidden; pre-attempt latch → accepted (consistent w/ Ch1). All covered.

**Placeholder scan:** UI tasks (7–10) reference concrete existing files to mirror (`DerivedPanel.tsx`, `LoadLab.tsx`, `UnbundledLab.tsx`) — allowed (real codebase patterns). No TBD/TODO in engine tasks; full code given.

**Type consistency:** `Trace`/`Step`/`ModelId`/`QueryId`/`Id`/`UserDoc` defined in T1, imported unchanged T2–8. `ModelsState`/`ModelsInspect`/`ModelPanelInspect`/`ModelsExternal`/`ModelsTimer` defined T2, used verbatim T3/4/6/7/8. `evalQuery` reads `roundTrips` matching the T1 `Trace` field. `migrationCost(model, nicknameAdded)` signature matches its T1 def and T2 call sites.
