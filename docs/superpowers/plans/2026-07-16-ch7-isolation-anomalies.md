# Ch7 Isolation Anomaly Lab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship DDIA Ch7 as lab `7.1` — the same preset transaction schedule replayed under four isolation levels (RU / RC / SI / SER) in four lockstep panels, with three anomaly challenges (dirty read, lost update, write skew) — plus debrief `7.d`.

**Architecture:** One `Simulation<TxnState>` with `nodeIds: ['RU','RC','SI','SER']`; one pure `SimModule` (`src/modules/txn.ts`) whose reducer interprets schedule steps under the node's isolation level. Zero effects (no `send`, no `timer`) — every transition is synchronous on an injected `external` event. The UI injects each schedule step to all four nodes and drains the sim, so panels advance in lockstep and diverge only by semantics. Spec: `docs/superpowers/specs/2026-07-16-ch7-isolation-anomalies-design.md`.

**Tech Stack:** TypeScript, React, zustand bridge (`SimDriver`/`useSimStore`), Tailwind theme tokens, vitest, fast-check, MDX.

## Global Constraints

- Modules are pure: reducer returns new state (use `structuredClone(prev)` then mutate the clone), no `Date.now`/`Math.random`.
- UI tests: `// @vitest-environment jsdom` pragma at top, `afterEach(cleanup)`, query via `container.querySelector`/data attributes — **no jest-dom** (`toBeInTheDocument` does not exist here).
- Import `type ReactNode` — never `React.ReactNode`.
- Theme tokens only: `ink` (bg), `panel`, `line`, `dim`, `fg`, `set` (teal = win/good), `sign` (coral = lost/bad), `warn` (amber). Shared button/input classes from `src/ui/kit/classes.ts` (`btn`, `btnPrimary`, `inputBox`).
- Commit specific files (never `git add -A`). Conventional commits.
- Content dir is zero-padded: `content/ch07/`. Storage keys: `ddia:ch07:*`.
- Run tests with `npx vitest run <file>` (non-watch). Typecheck: `npx tsc -b` (or `npm run typecheck` if defined — check `package.json` once and use the repo's script).

---

### Task 1: Shared types + the three preset schedules

**Files:**
- Create: `src/modules/txn-shared.ts`
- Test: `src/modules/txn-shared.test.ts`

**Interfaces:**
- Produces: `Level`, `TxnId`, `WriteValue`, `Op`, `ScheduleStep`, `Preset`, `PresetId`, `TxnPayload`, `TXN_TOPOLOGY`, `TXN_IDS`, `CREDOS`, `PRESETS`, `presetById(id)`, `opLabel(step)`. Later tasks import exactly these names.

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/txn-shared.test.ts
import { expect, test } from 'vitest';
import { PRESETS, TXN_IDS, TXN_TOPOLOGY, opLabel, presetById } from './txn-shared';

test('topology is the four-level ladder in order', () => {
  expect(TXN_TOPOLOGY).toEqual(['RU', 'RC', 'SI', 'SER']);
});

test('three presets, one per anomaly, in ladder order', () => {
  expect(PRESETS.map((p) => p.id)).toEqual(['dirty-read', 'lost-update', 'write-skew']);
});

test('every preset is well-formed: begin first, exactly one commit/abort last per txn', () => {
  for (const p of PRESETS) {
    for (const txn of TXN_IDS) {
      const ops = p.steps.filter((s) => s.txn === txn).map((s) => s.op.op);
      if (ops.length === 0) continue;
      expect(ops[0]).toBe('begin');
      expect(['commit', 'abort']).toContain(ops[ops.length - 1]);
      expect(ops.slice(0, -1).filter((o) => o === 'commit' || o === 'abort')).toEqual([]);
    }
  }
});

test('presets only touch keys seeded in their initial store', () => {
  for (const p of PRESETS) {
    const keys = new Set(Object.keys(p.initial));
    for (const s of p.steps) {
      if (s.op.op === 'read' || s.op.op === 'write') expect(keys.has(s.op.key)).toBe(true);
      if (s.op.op === 'ensure') for (const k of s.op.keys) expect(keys.has(k)).toBe(true);
    }
  }
});

test('opLabel renders every op shape', () => {
  expect(opLabel({ txn: 'T1', op: { op: 'begin' } })).toBe('T1 begin');
  expect(opLabel({ txn: 'T1', op: { op: 'write', key: 'x', value: 99 } })).toBe('T1 write x=99');
  expect(opLabel({ txn: 'T2', op: { op: 'write', key: 'counter', value: { inc: 1 } } })).toBe('T2 write counter+=1');
  expect(opLabel({ txn: 'T2', op: { op: 'read', key: 'x' } })).toBe('T2 read x');
  expect(opLabel({ txn: 'T1', op: { op: 'ensure', keys: ['alice', 'bob'], atLeast: 2 } })).toBe('T1 ensure alice+bob ≥ 2');
  expect(opLabel({ txn: 'T2', op: { op: 'commit' } })).toBe('T2 commit');
  expect(opLabel({ txn: 'T1', op: { op: 'abort' } })).toBe('T1 abort');
});

test('presetById finds each preset', () => {
  expect(presetById('write-skew').initial).toEqual({ alice: 1, bob: 1 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/txn-shared.test.ts`
Expected: FAIL — cannot resolve `./txn-shared`.

- [ ] **Step 3: Write the implementation**

```ts
// src/modules/txn-shared.ts
// Ch7 Isolation Anomaly Lab — shared vocabulary: levels, schedule ops, presets.
// Four nodes = four isolation levels interpreting the same schedule.

export type Level = 'RU' | 'RC' | 'SI' | 'SER';
export type TxnId = 'T1' | 'T2';

export const TXN_TOPOLOGY: Level[] = ['RU', 'RC', 'SI', 'SER'];
export const TXN_IDS: TxnId[] = ['T1', 'T2'];

/** One-line semantics shown at the top of each panel. */
export const CREDOS: Record<Level, string> = {
  RU: 'reads may see uncommitted data',
  RC: 'reads see the last committed value',
  SI: 'reads from a begin-time snapshot; first committer wins',
  SER: 'one transaction at a time',
};

/** {inc:n} = the value this txn last read for the key, plus n (read-modify-write). */
export type WriteValue = number | { inc: number };

export type Op =
  | { op: 'begin' }
  | { op: 'read'; key: string }
  | { op: 'write'; key: string; value: WriteValue }
  /** App-level check-then-act: read all keys; abort the txn if their sum < atLeast. */
  | { op: 'ensure'; keys: string[]; atLeast: number }
  | { op: 'commit' }
  | { op: 'abort' };

export interface ScheduleStep {
  txn: TxnId;
  op: Op;
}

export type PresetId = 'dirty-read' | 'lost-update' | 'write-skew';

export interface Preset {
  id: PresetId;
  title: string;
  blurb: string;
  initial: Record<string, number>;
  steps: ScheduleStep[];
}

export type TxnPayload = { schedule: ScheduleStep };

export const PRESETS: Preset[] = [
  {
    id: 'dirty-read',
    title: 'Dirty read',
    blurb: 'T2 reads T1’s unfinished write — then T1 aborts.',
    initial: { x: 10 },
    steps: [
      { txn: 'T1', op: { op: 'begin' } },
      { txn: 'T1', op: { op: 'write', key: 'x', value: 99 } },
      { txn: 'T2', op: { op: 'begin' } },
      { txn: 'T2', op: { op: 'read', key: 'x' } },
      { txn: 'T2', op: { op: 'commit' } },
      { txn: 'T1', op: { op: 'abort' } },
    ],
  },
  {
    id: 'lost-update',
    title: 'Lost update',
    blurb: 'Two read-modify-write increments race on one counter.',
    initial: { counter: 10 },
    steps: [
      { txn: 'T1', op: { op: 'begin' } },
      { txn: 'T2', op: { op: 'begin' } },
      { txn: 'T1', op: { op: 'read', key: 'counter' } },
      { txn: 'T2', op: { op: 'read', key: 'counter' } },
      { txn: 'T1', op: { op: 'write', key: 'counter', value: { inc: 1 } } },
      { txn: 'T1', op: { op: 'commit' } },
      { txn: 'T2', op: { op: 'write', key: 'counter', value: { inc: 1 } } },
      { txn: 'T2', op: { op: 'commit' } },
    ],
  },
  {
    id: 'write-skew',
    title: 'Write skew — doctors on call',
    blurb: 'Both doctors check the rota, then both go off call.',
    initial: { alice: 1, bob: 1 },
    steps: [
      { txn: 'T1', op: { op: 'begin' } },
      { txn: 'T2', op: { op: 'begin' } },
      { txn: 'T1', op: { op: 'ensure', keys: ['alice', 'bob'], atLeast: 2 } },
      { txn: 'T2', op: { op: 'ensure', keys: ['alice', 'bob'], atLeast: 2 } },
      { txn: 'T1', op: { op: 'write', key: 'alice', value: 0 } },
      { txn: 'T1', op: { op: 'commit' } },
      { txn: 'T2', op: { op: 'write', key: 'bob', value: 0 } },
      { txn: 'T2', op: { op: 'commit' } },
    ],
  },
];

export function presetById(id: PresetId): Preset {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown preset: ${id}`);
  return p;
}

/** Monospace row label for the schedule list, e.g. "T1 write x=99". */
export function opLabel(step: ScheduleStep): string {
  const { txn, op } = step;
  switch (op.op) {
    case 'begin':
    case 'commit':
    case 'abort':
      return `${txn} ${op.op}`;
    case 'read':
      return `${txn} read ${op.key}`;
    case 'write':
      return typeof op.value === 'number'
        ? `${txn} write ${op.key}=${op.value}`
        : `${txn} write ${op.key}+=${op.value.inc}`;
    case 'ensure':
      return `${txn} ensure ${op.keys.join('+')} ≥ ${op.atLeast}`;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/txn-shared.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/txn-shared.ts src/modules/txn-shared.test.ts
git commit -m "feat(modules): Ch7 txn vocabulary — levels, schedule ops, 3 anomaly presets"
```

---

### Task 2: Engine core — version store, RU/RC semantics, dirty-read detector

**Files:**
- Create: `src/modules/txn.ts`
- Test: `src/modules/txn.test.ts`

**Interfaces:**
- Consumes: everything from `txn-shared` (Task 1).
- Produces: `TxnState`, `Version`, `ReadRecord`, `TxnInfo`, `TxnStatus`, `Anomaly`, `txnInit(level, config)`, `applyStep(prev, step, time)`, and the `txn: SimModule<TxnState, TxnPayload>` object. Tasks 3–7 replace/extend named functions inside `txn.ts`; UI tasks import `txn`, `TxnState`.
- Note: in this task SER intentionally behaves like RC (no queue yet — Task 4) and SI commit has no conflict check yet (Task 3). `metrics`/`inspect` are minimal stubs until Task 7.

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/txn.test.ts
import { expect, test } from 'vitest';
import { Simulation } from '../engine';
import { txn, type TxnState } from './txn';
import { TXN_TOPOLOGY, type Level, type ScheduleStep, type TxnPayload } from './txn-shared';

export function fresh(initial: Record<string, number>, seed = 7000) {
  const sim = new Simulation<TxnState, TxnPayload>({
    module: txn,
    config: { nodeIds: TXN_TOPOLOGY, params: { initial } },
    seed,
  });
  sim.runSteps(TXN_TOPOLOGY.length); // deliver the four inits
  return sim;
}

export function play(sim: ReturnType<typeof fresh>, steps: ScheduleStep[], nodes: Level[] = TXN_TOPOLOGY) {
  for (const s of steps) {
    for (const id of nodes) sim.external(id, { schedule: s });
    sim.runSteps(nodes.length);
  }
}

const st = (sim: ReturnType<typeof fresh>, id: Level) => sim.getState(id);

test('init seeds every level with the same committed store', () => {
  const sim = fresh({ x: 10 });
  for (const id of TXN_TOPOLOGY) {
    expect(st(sim, id).level).toBe(id);
    expect(st(sim, id).store.x).toEqual([{ value: 10, txn: null, committedAt: 0 }]);
  }
});

test('RU reads a foreign uncommitted version and flags dirty-read; RC reads last committed', () => {
  const sim = fresh({ x: 10 });
  play(sim, [
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'write', key: 'x', value: 99 } },
    { txn: 'T2', op: { op: 'begin' } },
    { txn: 'T2', op: { op: 'read', key: 'x' } },
  ]);
  const ru = st(sim, 'RU');
  const rc = st(sim, 'RC');
  expect(ru.txns.T2.reads[0].value).toBe(99);
  expect(ru.anomalies.map((a) => a.type)).toEqual(['dirty-read']);
  expect(rc.txns.T2.reads[0].value).toBe(10);
  expect(rc.anomalies).toEqual([]);
});

test('a txn always reads its own uncommitted writes, at every level', () => {
  const sim = fresh({ x: 10 });
  play(sim, [
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'write', key: 'x', value: 5 } },
    { txn: 'T1', op: { op: 'read', key: 'x' } },
  ]);
  for (const id of TXN_TOPOLOGY) {
    expect(st(sim, id).txns.T1.reads.at(-1)?.value).toBe(5);
    // reading your own write is not a dirty read
    expect(st(sim, id).anomalies).toEqual([]);
  }
});

test('commit publishes: RC readers see the value only after commit', () => {
  const sim = fresh({ x: 10 });
  play(sim, [
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'write', key: 'x', value: 42 } },
    { txn: 'T2', op: { op: 'begin' } },
    { txn: 'T2', op: { op: 'read', key: 'x' } },
    { txn: 'T1', op: { op: 'commit' } },
    { txn: 'T2', op: { op: 'read', key: 'x' } },
  ]);
  const rc = st(sim, 'RC');
  expect(rc.txns.T2.reads.map((r) => r.value)).toEqual([10, 42]);
  expect(rc.commits).toBe(1);
});

test('abort discards uncommitted versions', () => {
  const sim = fresh({ x: 10 });
  play(sim, [
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'write', key: 'x', value: 99 } },
    { txn: 'T1', op: { op: 'abort' } },
    { txn: 'T2', op: { op: 'begin' } },
    { txn: 'T2', op: { op: 'read', key: 'x' } },
  ]);
  for (const id of TXN_TOPOLOGY) {
    expect(st(sim, id).store.x).toHaveLength(1);
    expect(st(sim, id).txns.T2.reads[0].value).toBe(10);
    expect(st(sim, id).txns.T1.status).toBe('aborted');
    expect(st(sim, id).aborts).toBe(1);
  }
});

test('ops after commit/abort are swallowed and counted as skipped', () => {
  const sim = fresh({ x: 10 });
  play(sim, [
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'commit' } },
    { txn: 'T1', op: { op: 'write', key: 'x', value: 1 } },
  ]);
  const rc = st(sim, 'RC');
  expect(rc.skippedOps).toBe(1);
  expect(rc.store.x).toHaveLength(1);
});

test('reduce ignores non-schedule payloads and non-external events', () => {
  const sim = fresh({ x: 10 });
  sim.external('RC', { nonsense: true } as unknown as TxnPayload);
  sim.runSteps(1);
  expect(st(sim, 'RC').skippedOps).toBe(0);
  expect(st(sim, 'RC').store.x).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/txn.test.ts`
Expected: FAIL — cannot resolve `./txn`.

- [ ] **Step 3: Write the implementation**

```ts
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

function doRead(s: TxnState, txnId: TxnId, key: string, time: number): void {
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
      at: time,
    });
  }
}

function doWrite(s: TxnState, txnId: TxnId, key: string, value: WriteValue, time: number): void {
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
      doRead(s, txnId, key, time);
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

function doAbort(s: TxnState, txnId: TxnId, time: number, reason: string): void {
  const t = s.txns[txnId];
  dropUncommitted(s, txnId);
  t.status = 'aborted';
  t.endedAt = time;
  t.abortReason = reason;
  s.aborts += 1;
}

function doCommit(s: TxnState, txnId: TxnId, time: number): void {
  const t = s.txns[txnId];
  for (const key of Object.keys(s.store)) {
    for (const v of s.store[key]) if (v.txn === txnId && v.committedAt === null) v.committedAt = time;
  }
  t.status = 'committed';
  t.endedAt = time;
  s.commits += 1;
}

function apply(s: TxnState, txnId: TxnId, op: Op, time: number): void {
  const t = s.txns[txnId];
  switch (op.op) {
    case 'begin':
      t.status = 'active';
      t.beganAt = time;
      if (s.level === 'SI') t.snapshotAt = time;
      break;
    case 'read':
      doRead(s, txnId, op.key, time);
      break;
    case 'write':
      doWrite(s, txnId, op.key, op.value, time);
      break;
    case 'ensure':
      break; // Task 5
    case 'commit':
      doCommit(s, txnId, time);
      break;
    case 'abort':
      doAbort(s, txnId, time, 'rolled back by the schedule');
      break;
  }
}

function runStep(s: TxnState, step: ScheduleStep, time: number): void {
  const t = s.txns[step.txn];
  // finished txns swallow their remaining ops — the schedule always runs to the end
  if (t.status === 'committed' || t.status === 'aborted') {
    s.skippedOps += 1;
    return;
  }
  apply(s, step.txn, step.op, time);
}

export function applyStep(prev: TxnState, step: ScheduleStep, time: number): TxnState {
  const s = structuredClone(prev);
  runStep(s, step, time);
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
    return [applyStep(state, p.schedule, event.time), []];
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/txn.test.ts src/modules/txn-shared.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/txn.ts src/modules/txn.test.ts
git commit -m "feat(modules): Ch7 txn engine core — version chains, RU/RC reads, dirty-read detector"
```

---

### Task 3: Snapshot Isolation — snapshot reads + first-committer-wins

**Files:**
- Modify: `src/modules/txn.ts` (replace `doCommit`)
- Test: `src/modules/txn.test.ts` (append)

**Interfaces:**
- Consumes: `fresh`/`play` helpers exported from `txn.test.ts` (Task 2).
- Produces: SI abort reason contains the literal substring `first committer wins` — Task 9's matrix and Task 13's challenge verifier grep for it.

- [ ] **Step 1: Append the failing tests**

```ts
// append to src/modules/txn.test.ts
test('SI: reads are stable against commits after the snapshot', () => {
  const sim = fresh({ x: 10 });
  play(sim, [
    { txn: 'T2', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'write', key: 'x', value: 42 } },
    { txn: 'T1', op: { op: 'commit' } },
    { txn: 'T2', op: { op: 'read', key: 'x' } },
  ]);
  expect(st(sim, 'SI').txns.T2.reads[0].value).toBe(10); // snapshot predates T1's commit
  expect(st(sim, 'RC').txns.T2.reads[0].value).toBe(42); // RC sees the newest committed
});

test('SI: first committer wins — the second writer of the same key aborts', () => {
  const sim = fresh({ counter: 10 });
  play(sim, [
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T2', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'write', key: 'counter', value: 11 } },
    { txn: 'T2', op: { op: 'write', key: 'counter', value: 17 } },
    { txn: 'T1', op: { op: 'commit' } },
    { txn: 'T2', op: { op: 'commit' } },
  ]);
  const si = st(sim, 'SI');
  expect(si.txns.T1.status).toBe('committed');
  expect(si.txns.T2.status).toBe('aborted');
  expect(si.txns.T2.abortReason).toContain('first committer wins');
  // the loser's version is gone; the winner's value stands
  expect(si.store.counter.filter((v) => v.committedAt !== null).at(-1)?.value).toBe(11);
  // RC (no conflict check) let both commit
  expect(st(sim, 'RC').txns.T2.status).toBe('committed');
});

test('SI: disjoint writes both commit (no false conflict)', () => {
  const sim = fresh({ a: 1, b: 2 });
  play(sim, [
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T2', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'write', key: 'a', value: 5 } },
    { txn: 'T2', op: { op: 'write', key: 'b', value: 6 } },
    { txn: 'T1', op: { op: 'commit' } },
    { txn: 'T2', op: { op: 'commit' } },
  ]);
  expect(st(sim, 'SI').txns.T1.status).toBe('committed');
  expect(st(sim, 'SI').txns.T2.status).toBe('committed');
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run src/modules/txn.test.ts`
Expected: the two SI conflict/stability tests FAIL (T2 commits instead of aborting; SI read sees 42).

- [ ] **Step 3: Replace `doCommit` in `src/modules/txn.ts`**

```ts
function doCommit(s: TxnState, txnId: TxnId, time: number): void {
  const t = s.txns[txnId];
  if (s.level === 'SI') {
    const snap = t.snapshotAt ?? 0;
    for (const key of t.writes) {
      const conflict = (s.store[key] ?? []).some(
        (v) => v.txn !== txnId && v.committedAt !== null && v.committedAt > snap,
      );
      if (conflict) {
        doAbort(s, txnId, time, `write-write conflict on ${key} — first committer wins`);
        return;
      }
    }
  }
  for (const key of Object.keys(s.store)) {
    for (const v of s.store[key]) if (v.txn === txnId && v.committedAt === null) v.committedAt = time;
  }
  t.status = 'committed';
  t.endedAt = time;
  s.commits += 1;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/txn.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/txn.ts src/modules/txn.test.ts
git commit -m "feat(modules): SI semantics — snapshot reads + first-committer-wins abort"
```

---

### Task 4: Serializable — serial execution with an op queue

**Files:**
- Modify: `src/modules/txn.ts` (replace `runStep` and `apply`; add `drainQueue`)
- Test: `src/modules/txn.test.ts` (append)

**Interfaces:**
- Produces: `TxnState.queue` (steps parked at SER), `TxnState.activeSer`, statuses `waiting`. UI renders `queue` via `opLabel`.

- [ ] **Step 1: Append the failing tests**

```ts
// append to src/modules/txn.test.ts
test('SER: a second txn queues while the first is active, then drains on commit', () => {
  const sim = fresh({ x: 10 });
  play(sim, [
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T2', op: { op: 'begin' } },
    { txn: 'T2', op: { op: 'read', key: 'x' } },
    { txn: 'T1', op: { op: 'write', key: 'x', value: 42 } },
  ]);
  let ser = st(sim, 'SER');
  expect(ser.txns.T2.status).toBe('waiting');
  expect(ser.queue).toHaveLength(2);
  expect(ser.queuedOps).toBe(2);
  expect(ser.txns.T2.reads).toEqual([]); // nothing ran yet

  play(sim, [{ txn: 'T1', op: { op: 'commit' } }]);
  ser = st(sim, 'SER');
  expect(ser.queue).toEqual([]);
  expect(ser.txns.T2.status).toBe('active');
  // the drained read ran AFTER T1's commit, so it saw 42 — serial order, not schedule order
  expect(ser.txns.T2.reads[0].value).toBe(42);
});

test('SER: drains on abort too, and the drained txn sees pre-abort state', () => {
  const sim = fresh({ x: 10 });
  play(sim, [
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'write', key: 'x', value: 99 } },
    { txn: 'T2', op: { op: 'begin' } },
    { txn: 'T2', op: { op: 'read', key: 'x' } },
    { txn: 'T2', op: { op: 'commit' } },
    { txn: 'T1', op: { op: 'abort' } },
  ]);
  const ser = st(sim, 'SER');
  expect(ser.txns.T2.status).toBe('committed');
  expect(ser.txns.T2.reads[0].value).toBe(10); // T1's write was rolled back first
  expect(ser.anomalies).toEqual([]);
});

test('SER: never dirty-reads, never loses the schedule tail', () => {
  const sim = fresh({ counter: 10 });
  play(sim, [
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T2', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'read', key: 'counter' } },
    { txn: 'T2', op: { op: 'read', key: 'counter' } },
    { txn: 'T1', op: { op: 'write', key: 'counter', value: { inc: 1 } } },
    { txn: 'T1', op: { op: 'commit' } },
    { txn: 'T2', op: { op: 'write', key: 'counter', value: { inc: 1 } } },
    { txn: 'T2', op: { op: 'commit' } },
  ]);
  const ser = st(sim, 'SER');
  expect(ser.txns.T1.status).toBe('committed');
  expect(ser.txns.T2.status).toBe('committed');
  // both increments landed: T2 ran serially after T1
  expect(ser.store.counter.filter((v) => v.committedAt !== null).at(-1)?.value).toBe(12);
  expect(ser.anomalies).toEqual([]);
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run src/modules/txn.test.ts`
Expected: the three SER tests FAIL (no queueing — T2 runs interleaved, final counter 11).

- [ ] **Step 3: Replace `runStep`/`apply` and add `drainQueue` in `src/modules/txn.ts`**

```ts
function apply(s: TxnState, txnId: TxnId, op: Op, time: number): void {
  const t = s.txns[txnId];
  switch (op.op) {
    case 'begin':
      t.status = 'active';
      t.beganAt = time;
      if (s.level === 'SI') t.snapshotAt = time;
      if (s.level === 'SER') s.activeSer = txnId;
      break;
    case 'read':
      doRead(s, txnId, op.key, time);
      break;
    case 'write':
      doWrite(s, txnId, op.key, op.value, time);
      break;
    case 'ensure':
      break; // Task 5
    case 'commit':
      doCommit(s, txnId, time);
      break;
    case 'abort':
      doAbort(s, txnId, time, 'rolled back by the schedule');
      break;
  }
  if (s.level === 'SER' && s.activeSer === txnId && (t.status === 'committed' || t.status === 'aborted')) {
    s.activeSer = null;
  }
}

/** SER: replay parked steps once the engine frees up. Runs after every applied step. */
function drainQueue(s: TxnState, time: number): void {
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
    apply(s, head.txn, head.op, time);
  }
}

function runStep(s: TxnState, step: ScheduleStep, time: number): void {
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
    apply(s, step.txn, step.op, time);
    drainQueue(s, time);
    return;
  }
  apply(s, step.txn, step.op, time);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/txn.test.ts`
Expected: PASS (all prior tests still green — RU/RC/SI paths untouched).

- [ ] **Step 5: Commit**

```bash
git add src/modules/txn.ts src/modules/txn.test.ts
git commit -m "feat(modules): SER semantics — serial execution via an op queue"
```

---

### Task 5: `ensure` (check-then-act) — the write-skew guard

**Files:**
- Modify: `src/modules/txn.ts` (add `doEnsure`, wire the `ensure` case in `apply`)
- Test: `src/modules/txn.test.ts` (append)

**Interfaces:**
- Produces: abort reason contains the literal substring `ensure failed` — Task 9 and Task 13's challenge 3 verifier grep for it.

- [ ] **Step 1: Append the failing tests**

```ts
// append to src/modules/txn.test.ts
test('ensure: passes at/above the threshold, records its reads', () => {
  const sim = fresh({ alice: 1, bob: 1 });
  play(sim, [
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'ensure', keys: ['alice', 'bob'], atLeast: 2 } },
  ]);
  const rc = st(sim, 'RC');
  expect(rc.txns.T1.status).toBe('active');
  expect(rc.txns.T1.reads.map((r) => r.key)).toEqual(['alice', 'bob']);
});

test('ensure: below the threshold the txn aborts itself', () => {
  const sim = fresh({ alice: 0, bob: 1 });
  play(sim, [
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'ensure', keys: ['alice', 'bob'], atLeast: 2 } },
    { txn: 'T1', op: { op: 'write', key: 'bob', value: 0 } },
  ]);
  const rc = st(sim, 'RC');
  expect(rc.txns.T1.status).toBe('aborted');
  expect(rc.txns.T1.abortReason).toContain('ensure failed');
  expect(rc.skippedOps).toBe(1); // the write after the self-abort was swallowed
  expect(rc.store.bob.at(-1)?.value).toBe(1);
});

test('{inc} with no prior read records the dependency read at write time', () => {
  const sim = fresh({ counter: 10 });
  play(sim, [
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'write', key: 'counter', value: { inc: 5 } } },
  ]);
  const rc = st(sim, 'RC');
  expect(rc.store.counter.at(-1)?.value).toBe(15);
  expect(rc.txns.T1.reads.map((r) => r.key)).toEqual(['counter']);
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run src/modules/txn.test.ts`
Expected: the two ensure tests FAIL (`ensure` is a no-op). The `{inc}` test already passes (Task 2 wired it) — that is fine; it pins the behavior here where `ensure`/`inc` semantics land.

- [ ] **Step 3: Add `doEnsure` and wire it in `apply`**

```ts
function doEnsure(s: TxnState, txnId: TxnId, keys: string[], atLeast: number, time: number): void {
  const t = s.txns[txnId];
  let sum = 0;
  for (const key of keys) {
    doRead(s, txnId, key, time);
    sum += t.reads[t.reads.length - 1].value;
  }
  if (sum < atLeast) {
    doAbort(s, txnId, time, `ensure failed: ${keys.join('+')}=${sum} < ${atLeast}`);
  }
}
```

In `apply`, replace the `ensure` case:

```ts
    case 'ensure':
      doEnsure(s, txnId, op.keys, op.atLeast, time);
      break;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/txn.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/txn.ts src/modules/txn.test.ts
git commit -m "feat(modules): ensure op — app-level check-then-act that self-aborts below threshold"
```

---

### Task 6: Lost-update and write-skew detectors

**Files:**
- Modify: `src/modules/txn.ts` (add `detectLostUpdate`, `detectWriteSkew`; call both at the end of a successful `doCommit`)
- Test: `src/modules/txn.test.ts` (append)

**Interfaces:**
- Produces: `Anomaly.type` values `'lost-update'` and `'write-skew'` — consumed by Task 9's matrix and Task 13's verifiers. Detectors are level-blind observations of the actual history.

- [ ] **Step 1: Append the failing tests**

```ts
// append to src/modules/txn.test.ts
test('lost update: a committed overwrite based on a stale read is flagged (RC), not at SER', () => {
  const sim = fresh({ counter: 10 });
  play(sim, [
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T2', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'read', key: 'counter' } },
    { txn: 'T2', op: { op: 'read', key: 'counter' } },
    { txn: 'T1', op: { op: 'write', key: 'counter', value: { inc: 1 } } },
    { txn: 'T1', op: { op: 'commit' } },
    { txn: 'T2', op: { op: 'write', key: 'counter', value: { inc: 1 } } },
    { txn: 'T2', op: { op: 'commit' } },
  ]);
  expect(st(sim, 'RC').anomalies.map((a) => a.type)).toEqual(['lost-update']);
  expect(st(sim, 'RU').anomalies.map((a) => a.type)).toEqual(['lost-update']);
  expect(st(sim, 'SER').anomalies).toEqual([]);
});

test('lost update: NOT flagged when the second writer read the first write (sequential updates)', () => {
  const sim = fresh({ counter: 10 });
  play(sim, [
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'write', key: 'counter', value: { inc: 1 } } },
    { txn: 'T1', op: { op: 'commit' } },
    { txn: 'T2', op: { op: 'begin' } },
    { txn: 'T2', op: { op: 'read', key: 'counter' } },
    { txn: 'T2', op: { op: 'write', key: 'counter', value: { inc: 1 } } },
    { txn: 'T2', op: { op: 'commit' } },
  ]);
  expect(st(sim, 'RC').anomalies).toEqual([]);
  expect(st(sim, 'RC').store.counter.filter((v) => v.committedAt !== null).at(-1)?.value).toBe(12);
});

test('write skew: disjoint writes over cross-read keys, both committed → flagged (RC and SI)', () => {
  const sim = fresh({ alice: 1, bob: 1 });
  play(sim, [
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T2', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'ensure', keys: ['alice', 'bob'], atLeast: 2 } },
    { txn: 'T2', op: { op: 'ensure', keys: ['alice', 'bob'], atLeast: 2 } },
    { txn: 'T1', op: { op: 'write', key: 'alice', value: 0 } },
    { txn: 'T1', op: { op: 'commit' } },
    { txn: 'T2', op: { op: 'write', key: 'bob', value: 0 } },
    { txn: 'T2', op: { op: 'commit' } },
  ]);
  expect(st(sim, 'RC').anomalies.map((a) => a.type)).toEqual(['write-skew']);
  expect(st(sim, 'SI').anomalies.map((a) => a.type)).toEqual(['write-skew']); // SI does NOT stop skew
  const ser = st(sim, 'SER');
  expect(ser.anomalies).toEqual([]);
  expect(ser.txns.T2.status).toBe('aborted'); // its drained ensure saw alice already off call
  expect(ser.txns.T2.abortReason).toContain('ensure failed');
});

test('write skew: NOT flagged for disjoint writes without cross-reads', () => {
  const sim = fresh({ a: 1, b: 2 });
  play(sim, [
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T2', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'write', key: 'a', value: 5 } },
    { txn: 'T2', op: { op: 'write', key: 'b', value: 6 } },
    { txn: 'T1', op: { op: 'commit' } },
    { txn: 'T2', op: { op: 'commit' } },
  ]);
  expect(st(sim, 'RC').anomalies).toEqual([]);
});

test('write skew: NOT flagged when the txns did not overlap in time', () => {
  const sim = fresh({ alice: 1, bob: 1 });
  play(sim, [
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'ensure', keys: ['alice', 'bob'], atLeast: 2 } },
    { txn: 'T1', op: { op: 'write', key: 'alice', value: 0 } },
    { txn: 'T1', op: { op: 'commit' } },
    { txn: 'T2', op: { op: 'begin' } },
    { txn: 'T2', op: { op: 'ensure', keys: ['alice', 'bob'], atLeast: 2 } },
    { txn: 'T2', op: { op: 'write', key: 'bob', value: 0 } },
    { txn: 'T2', op: { op: 'commit' } },
  ]);
  // T2's ensure saw alice=0 and self-aborted at every level — and even if it had
  // committed, the windows are disjoint, so no skew flag either way.
  expect(st(sim, 'RC').anomalies).toEqual([]);
  expect(st(sim, 'RC').txns.T2.abortReason).toContain('ensure failed');
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run src/modules/txn.test.ts`
Expected: the two “flagged” tests FAIL (no detectors yet); the NOT-flagged tests pass vacuously.

- [ ] **Step 3: Add the detectors and call them from `doCommit`**

Add after `doAbort`:

```ts
/**
 * Lost update: this txn committed a write to a key it last read at a stale
 * version — some other txn committed a newer version in between, and that
 * update is now clobbered. Level-blind: it observes the actual history.
 */
function detectLostUpdate(s: TxnState, txnId: TxnId, time: number): void {
  const t = s.txns[txnId];
  for (const key of t.writes) {
    const lastRead = [...t.reads].reverse().find((r) => r.key === key);
    if (!lastRead) continue; // blind write — not a read-modify-write clobber
    const readStamp = lastRead.versionCommittedAt ?? -1;
    const clobbered = (s.store[key] ?? []).some(
      (v) => v.txn !== txnId && v.committedAt !== null && v.committedAt > readStamp && v.committedAt < time,
    );
    if (clobbered) {
      s.anomalies.push({
        type: 'lost-update',
        detail: `${txnId} overwrote ${key} from a stale read — a concurrent committed update vanished`,
        at: time,
      });
    }
  }
}

/**
 * Write skew: both txns committed, their active windows overlapped, they wrote
 * DISJOINT key sets but each read a key the other wrote. The doctors shape.
 */
function detectWriteSkew(s: TxnState, me: TxnId, time: number): void {
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
      at: time,
    });
  }
}
```

At the end of `doCommit` (after `s.commits += 1;`), add:

```ts
  detectLostUpdate(s, txnId, time);
  detectWriteSkew(s, txnId, time);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/txn.test.ts`
Expected: PASS (including all earlier tasks' tests — the detectors must not fire on any of them).

- [ ] **Step 5: Commit**

```bash
git add src/modules/txn.ts src/modules/txn.test.ts
git commit -m "feat(modules): lost-update + write-skew detectors — level-blind history checks"
```

---

### Task 7: `inspect` + `committedValue` — the panel data contract

**Files:**
- Modify: `src/modules/txn.ts` (add `TxnInspect`, `txnInspect`, `committedValue`; replace the module's `inspect`)
- Test: `src/modules/txn.test.ts` (append)

**Interfaces:**
- Produces (UI tasks consume exactly this):

```ts
export interface TxnInspect {
  level: Level;
  credo: string;
  txns: Record<TxnId, TxnInfo>;
  committed: Record<string, number>; // latest committed value per key
  pending: Record<string, { txn: TxnId; value: number }[]>; // uncommitted overlay
  queue: string[]; // SER's parked ops, pre-rendered via opLabel
  anomalies: Anomaly[];
  counters: { commits: number; aborts: number; queuedOps: number; skippedOps: number };
}
export function committedValue(s: TxnState, key: string): number | undefined;
```

- [ ] **Step 1: Append the failing tests**

```ts
// append to src/modules/txn.test.ts — also add to the top imports:
// import { txn, committedValue, type TxnState, type TxnInspect } from './txn';
test('committedValue picks the version with the newest commit stamp, not append order', () => {
  const sim = fresh({ x: 10 });
  play(sim, [
    { txn: 'T2', op: { op: 'begin' } },
    { txn: 'T2', op: { op: 'write', key: 'x', value: 7 } }, // appended first...
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'write', key: 'x', value: 5 } },
    { txn: 'T1', op: { op: 'commit' } }, // ...but T1 commits first
    { txn: 'T2', op: { op: 'commit' } }, // T2 commits later → newest
  ]);
  expect(committedValue(st(sim, 'RC'), 'x')).toBe(7);
});

test('inspect exposes the full panel contract', () => {
  const sim = fresh({ x: 10 });
  play(sim, [
    { txn: 'T1', op: { op: 'begin' } },
    { txn: 'T1', op: { op: 'write', key: 'x', value: 99 } },
    { txn: 'T2', op: { op: 'begin' } },
    { txn: 'T2', op: { op: 'read', key: 'x' } },
  ]);
  const ru = txn.inspect(st(sim, 'RU')) as unknown as TxnInspect;
  expect(ru.level).toBe('RU');
  expect(ru.credo).toContain('uncommitted');
  expect(ru.committed).toEqual({ x: 10 });
  expect(ru.pending).toEqual({ x: [{ txn: 'T1', value: 99 }] });
  expect(ru.anomalies).toHaveLength(1);
  expect(ru.counters.commits).toBe(0);

  const ser = txn.inspect(st(sim, 'SER')) as unknown as TxnInspect;
  expect(ser.queue).toEqual(['T2 begin', 'T2 read x']);
});

test('metrics are namespaced per level', () => {
  const sim = fresh({ x: 10 });
  const states = new Map(TXN_TOPOLOGY.map((id) => [id, st(sim, id)] as const));
  const names = txn.metrics(states, sim.time).map((m) => m.name);
  for (const l of ['ru', 'rc', 'si', 'ser']) {
    expect(names).toContain(`${l}/commits`);
    expect(names).toContain(`${l}/anomalies`);
  }
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run src/modules/txn.test.ts`
Expected: FAIL — `committedValue` not exported; inspect lacks the contract fields.

- [ ] **Step 3: Implement**

Add `opLabel` to the `txn-shared` import list in `txn.ts`. Then add above the module object:

```ts
/** Latest committed value per key — newest commit stamp wins, not append order. */
export function committedValue(s: TxnState, key: string): number | undefined {
  let best: Version | undefined;
  for (const v of s.store[key] ?? []) {
    if (v.committedAt === null) continue;
    if (!best || v.committedAt >= (best.committedAt as number)) best = v;
  }
  return best?.value;
}

export interface TxnInspect {
  level: Level;
  credo: string;
  txns: Record<TxnId, TxnInfo>;
  committed: Record<string, number>;
  pending: Record<string, { txn: TxnId; value: number }[]>;
  queue: string[];
  anomalies: Anomaly[];
  counters: { commits: number; aborts: number; queuedOps: number; skippedOps: number };
}

export function txnInspect(s: TxnState): TxnInspect {
  const committed: Record<string, number> = {};
  const pending: Record<string, { txn: TxnId; value: number }[]> = {};
  for (const key of Object.keys(s.store)) {
    const c = committedValue(s, key);
    if (c !== undefined) committed[key] = c;
    const u = s.store[key]
      .filter((v) => v.committedAt === null && v.txn !== null)
      .map((v) => ({ txn: v.txn as TxnId, value: v.value }));
    if (u.length > 0) pending[key] = u;
  }
  return {
    level: s.level,
    credo: CREDOS[s.level],
    txns: s.txns,
    committed,
    pending,
    queue: s.queue.map(opLabel),
    anomalies: s.anomalies,
    counters: { commits: s.commits, aborts: s.aborts, queuedOps: s.queuedOps, skippedOps: s.skippedOps },
  };
}
```

Replace the module's `inspect` with:

```ts
  inspect(state) {
    return txnInspect(state) as unknown as InspectorTree;
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/txn.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/txn.ts src/modules/txn.test.ts
git commit -m "feat(modules): txn inspect contract — committed view, pending overlay, SER queue"
```

---

### Task 8: Property tests

**Files:**
- Test: `src/modules/txn.property.test.ts`

**Interfaces:**
- Consumes: `txn`, `TxnState` from `txn.ts`; types from `txn-shared`. Mirrors the fast-check idiom of `src/modules/leaderless.property.test.ts` (imports `fc` from `fast-check`).

- [ ] **Step 1: Write the tests**

```ts
// src/modules/txn.property.test.ts
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { Simulation } from '../engine';
import { txn, type TxnState } from './txn';
import { TXN_TOPOLOGY, type Op, type ScheduleStep, type TxnId, type TxnPayload } from './txn-shared';

const KEYS = ['a', 'b'];
const INITIAL = { a: 1, b: 1 };

/** Body ops for one txn (no begin/commit/abort — those are added around it). */
const bodyOp: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ op: fc.constant<'read'>('read'), key: fc.constantFrom(...KEYS) }),
  fc.record({
    op: fc.constant<'write'>('write'),
    key: fc.constantFrom(...KEYS),
    value: fc.oneof(fc.integer({ min: 0, max: 9 }), fc.record({ inc: fc.integer({ min: 1, max: 3 }) })),
  }),
  fc.record({
    op: fc.constant<'ensure'>('ensure'),
    keys: fc.constant(KEYS),
    atLeast: fc.integer({ min: 0, max: 3 }),
  }),
);

/** A well-formed 2-txn schedule: per-txn begin → body → commit|abort, fairly interleaved. */
const schedule: fc.Arbitrary<ScheduleStep[]> = fc
  .tuple(
    fc.array(bodyOp, { minLength: 0, maxLength: 4 }),
    fc.array(bodyOp, { minLength: 0, maxLength: 4 }),
    fc.constantFrom<'commit' | 'abort'>('commit', 'abort'),
    fc.constantFrom<'commit' | 'abort'>('commit', 'abort'),
    fc.array(fc.boolean(), { minLength: 20, maxLength: 20 }),
  )
  .map(([body1, body2, end1, end2, coin]) => {
    const t1: ScheduleStep[] = [
      { txn: 'T1' as TxnId, op: { op: 'begin' } as Op },
      ...body1.map((op) => ({ txn: 'T1' as TxnId, op })),
      { txn: 'T1' as TxnId, op: { op: end1 } as Op },
    ];
    const t2: ScheduleStep[] = [
      { txn: 'T2' as TxnId, op: { op: 'begin' } as Op },
      ...body2.map((op) => ({ txn: 'T2' as TxnId, op })),
      { txn: 'T2' as TxnId, op: { op: end2 } as Op },
    ];
    const out: ScheduleStep[] = [];
    let i = 0;
    let j = 0;
    let c = 0;
    while (i < t1.length || j < t2.length) {
      const takeT1 = j >= t2.length || (i < t1.length && coin[c++ % coin.length]);
      if (takeT1) out.push(t1[i++]);
      else out.push(t2[j++]);
    }
    return out;
  });

function runSchedule(steps: ScheduleStep[], seed: number): Map<string, TxnState> {
  const sim = new Simulation<TxnState, TxnPayload>({
    module: txn,
    config: { nodeIds: TXN_TOPOLOGY, params: { initial: INITIAL } },
    seed,
  });
  sim.runSteps(TXN_TOPOLOGY.length);
  for (const s of steps) {
    for (const id of TXN_TOPOLOGY) sim.external(id, { schedule: s });
    sim.runSteps(TXN_TOPOLOGY.length);
  }
  return new Map(TXN_TOPOLOGY.map((id) => [id, sim.getState(id)]));
}

test('determinism: the same schedule twice yields byte-identical states', () => {
  fc.assert(
    fc.property(schedule, (steps) => {
      const a = runSchedule(steps, 7100);
      const b = runSchedule(steps, 7100);
      for (const id of TXN_TOPOLOGY) {
        expect(JSON.stringify(a.get(id))).toBe(JSON.stringify(b.get(id)));
      }
    }),
    { numRuns: 30 },
  );
});

test('SER never exhibits any anomaly, for any well-formed schedule', () => {
  fc.assert(
    fc.property(schedule, (steps) => {
      const states = runSchedule(steps, 7200);
      expect(states.get('SER')!.anomalies).toEqual([]);
    }),
    { numRuns: 60 },
  );
});

test('RC, SI and SER never dirty-read, for any well-formed schedule', () => {
  fc.assert(
    fc.property(schedule, (steps) => {
      const states = runSchedule(steps, 7300);
      for (const id of ['RC', 'SI', 'SER'] as const) {
        expect(states.get(id)!.anomalies.filter((a) => a.type === 'dirty-read')).toEqual([]);
      }
    }),
    { numRuns: 60 },
  );
});

test('SI: every foreign read comes from a version committed at or before the snapshot', () => {
  fc.assert(
    fc.property(schedule, (steps) => {
      const si = runSchedule(steps, 7400).get('SI')!;
      for (const t of ['T1', 'T2'] as const) {
        const info = si.txns[t];
        for (const r of info.reads) {
          if (r.from === t) continue; // own writes are always visible
          if (r.from === null && r.versionCommittedAt === null) continue; // missing key
          expect(r.versionCommittedAt).not.toBeNull();
          if (info.snapshotAt !== null) {
            expect(r.versionCommittedAt as number).toBeLessThanOrEqual(info.snapshotAt);
          }
        }
      }
    }),
    { numRuns: 60 },
  );
});

test('the schedule always runs dry: every op is applied, queued-then-drained, or skipped', () => {
  fc.assert(
    fc.property(schedule, (steps) => {
      const states = runSchedule(steps, 7500);
      for (const id of TXN_TOPOLOGY) {
        const s = states.get(id)!;
        // both txns reached a terminal state
        expect(['committed', 'aborted']).toContain(s.txns.T1.status);
        expect(['committed', 'aborted']).toContain(s.txns.T2.status);
        // SER's queue fully drained
        expect(s.queue).toEqual([]);
      }
    }),
    { numRuns: 60 },
  );
});
```

- [ ] **Step 2: Run the property tests**

Run: `npx vitest run src/modules/txn.property.test.ts`
Expected: PASS. If a property finds a counterexample, that is a real engine bug — shrink output shows the schedule; fix the engine (not the test) and note the deviation in the ledger.

- [ ] **Step 3: Commit**

```bash
git add src/modules/txn.property.test.ts
git commit -m "test(modules): txn property suite — determinism, SER-clean, snapshot bounds"
```

---

### Task 9: The pinned lesson matrix

**Files:**
- Test: `src/modules/txn-lesson.test.ts`

**Interfaces:**
- Consumes: `PRESETS`, `presetById`; `txn`, `committedValue`. This is the headline guard: the exact 3-preset × 4-level outcome table from the spec (§6). A refactor that weakens any level breaks this test.

- [ ] **Step 1: Write the test**

```ts
// src/modules/txn-lesson.test.ts
// The Ch7 lesson, pinned: which anomaly appears at which rung of the ladder.
import { expect, test } from 'vitest';
import { Simulation } from '../engine';
import { txn, committedValue, type TxnState } from './txn';
import { presetById, TXN_TOPOLOGY, type PresetId, type TxnPayload } from './txn-shared';

function runPreset(id: PresetId): Map<string, TxnState> {
  const p = presetById(id);
  const sim = new Simulation<TxnState, TxnPayload>({
    module: txn,
    config: { nodeIds: TXN_TOPOLOGY, params: { initial: p.initial } },
    seed: 7000,
  });
  sim.runSteps(TXN_TOPOLOGY.length);
  for (const s of p.steps) {
    for (const nid of TXN_TOPOLOGY) sim.external(nid, { schedule: s });
    sim.runSteps(TXN_TOPOLOGY.length);
  }
  return new Map(TXN_TOPOLOGY.map((nid) => [nid, sim.getState(nid)]));
}

const flags = (s: TxnState) => s.anomalies.map((a) => a.type);

test('pinned matrix — dirty read exists only below Read Committed', () => {
  const m = runPreset('dirty-read');
  expect(flags(m.get('RU')!)).toEqual(['dirty-read']);
  for (const id of ['RC', 'SI', 'SER'] as const) expect(flags(m.get(id)!)).toEqual([]);
  for (const id of TXN_TOPOLOGY) {
    const s = m.get(id)!;
    expect(committedValue(s, 'x')).toBe(10); // T1 aborted everywhere; x never really changed
    expect(s.txns.T1.status).toBe('aborted');
    expect(s.txns.T2.status).toBe('committed');
  }
});

test('pinned matrix — lost update survives RC, dies at SI (abort) and SER (serial 12)', () => {
  const m = runPreset('lost-update');
  expect(flags(m.get('RU')!)).toEqual(['lost-update']);
  expect(flags(m.get('RC')!)).toEqual(['lost-update']);
  expect(committedValue(m.get('RU')!, 'counter')).toBe(11);
  expect(committedValue(m.get('RC')!, 'counter')).toBe(11);

  const si = m.get('SI')!;
  expect(flags(si)).toEqual([]);
  expect(si.txns.T2.status).toBe('aborted');
  expect(si.txns.T2.abortReason).toContain('first committer wins');
  expect(committedValue(si, 'counter')).toBe(11);

  const ser = m.get('SER')!;
  expect(flags(ser)).toEqual([]);
  expect(ser.txns.T2.status).toBe('committed');
  expect(committedValue(ser, 'counter')).toBe(12); // both increments landed
});

test('pinned matrix — write skew survives even SI; only SER holds the invariant', () => {
  const m = runPreset('write-skew');
  for (const id of ['RU', 'RC', 'SI'] as const) {
    const s = m.get(id)!;
    expect(flags(s)).toEqual(['write-skew']);
    expect((committedValue(s, 'alice') ?? 0) + (committedValue(s, 'bob') ?? 0)).toBe(0); // nobody on call
  }
  const ser = m.get('SER')!;
  expect(flags(ser)).toEqual([]);
  expect(ser.txns.T2.status).toBe('aborted');
  expect(ser.txns.T2.abortReason).toContain('ensure failed');
  expect((committedValue(ser, 'alice') ?? 0) + (committedValue(ser, 'bob') ?? 0)).toBe(1); // invariant held
});
```

- [ ] **Step 2: Run the matrix**

Run: `npx vitest run src/modules/txn-lesson.test.ts`
Expected: PASS. Any failure is an engine bug — trace the failing cell against spec §5 before touching anything.

- [ ] **Step 3: Commit**

```bash
git add src/modules/txn-lesson.test.ts
git commit -m "test(modules): pin the Ch7 lesson matrix — 3 presets x 4 levels, exact flags and finals"
```

---

### Task 10: SchedulePanel

**Files:**
- Create: `src/ui/labs/txn/SchedulePanel.tsx`
- Test: `src/ui/labs/txn/SchedulePanel.test.tsx`

**Interfaces:**
- Produces (Task 13 consumes):

```ts
export function SchedulePanel(props: {
  presets: Preset[];
  activeId: PresetId;
  cursor: number; // index of the NEXT step to run; === steps.length when done
  onPick: (id: PresetId) => void;
  onStep: () => void;
  onRunAll: () => void;
  onReset: () => void;
}): JSX element
```

- Purely presentational — cursor state lives in `TxnLab`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/ui/labs/txn/SchedulePanel.test.tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { PRESETS } from '../../../modules/txn-shared';
import { SchedulePanel } from './SchedulePanel';

afterEach(cleanup);

const noop = () => {};
const base = {
  presets: PRESETS,
  activeId: 'dirty-read' as const,
  cursor: 1,
  onPick: noop,
  onStep: noop,
  onRunAll: noop,
  onReset: noop,
};

test('renders one row per step with the cursor on the next op', () => {
  const { container } = render(<SchedulePanel {...base} />);
  const rows = container.querySelectorAll('[data-step]');
  expect(rows).toHaveLength(PRESETS[0].steps.length);
  expect(rows[0].getAttribute('data-state')).toBe('done');
  expect(rows[1].getAttribute('data-state')).toBe('next');
  expect(rows[2].getAttribute('data-state')).toBe('todo');
  expect(rows[0].textContent).toContain('T1 begin');
});

test('one picker button per preset; picking calls onPick', () => {
  const onPick = vi.fn();
  const { container } = render(<SchedulePanel {...base} onPick={onPick} />);
  const pickers = container.querySelectorAll('[data-preset]');
  expect(pickers).toHaveLength(3);
  fireEvent.click(pickers[2]);
  expect(onPick).toHaveBeenCalledWith('write-skew');
});

test('step and run-all disabled once the schedule is consumed; reset always live', () => {
  const onStep = vi.fn();
  const { container } = render(
    <SchedulePanel {...base} cursor={PRESETS[0].steps.length} onStep={onStep} />,
  );
  const step = container.querySelector('[data-action="step"]') as HTMLButtonElement;
  const runAll = container.querySelector('[data-action="run-all"]') as HTMLButtonElement;
  const reset = container.querySelector('[data-action="reset"]') as HTMLButtonElement;
  expect(step.disabled).toBe(true);
  expect(runAll.disabled).toBe(true);
  expect(reset.disabled).toBe(false);
  fireEvent.click(step);
  expect(onStep).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/labs/txn/SchedulePanel.test.tsx`
Expected: FAIL — cannot resolve `./SchedulePanel`.

- [ ] **Step 3: Write the implementation**

```tsx
// src/ui/labs/txn/SchedulePanel.tsx
import { opLabel, type Preset, type PresetId } from '../../../modules/txn-shared';
import { btn, btnPrimary } from '../../kit/classes';

/**
 * The schedule is the experiment: pick an anomaly preset, then step the same
 * op into all four isolation panels at once. Presentational — TxnLab owns
 * the cursor and the sim.
 */
export function SchedulePanel({
  presets,
  activeId,
  cursor,
  onPick,
  onStep,
  onRunAll,
  onReset,
}: {
  presets: Preset[];
  activeId: PresetId;
  cursor: number;
  onPick: (id: PresetId) => void;
  onStep: () => void;
  onRunAll: () => void;
  onReset: () => void;
}) {
  const active = presets.find((p) => p.id === activeId) ?? presets[0];
  const done = cursor >= active.steps.length;
  return (
    <section className="border border-line bg-panel rounded p-3 space-y-2 font-mono text-xs max-w-xl">
      <div className="flex flex-wrap gap-2">
        {presets.map((p) => (
          <button
            key={p.id}
            data-preset={p.id}
            className={p.id === activeId ? btnPrimary : btn}
            onClick={() => onPick(p.id)}
          >
            {p.title}
          </button>
        ))}
      </div>
      <p className="text-dim">{active.blurb}</p>
      <ol className="space-y-0.5">
        {active.steps.map((s, i) => {
          const state = i < cursor ? 'done' : i === cursor ? 'next' : 'todo';
          return (
            <li
              key={i}
              data-step={i}
              data-state={state}
              className={
                state === 'next'
                  ? 'text-fg bg-ink border border-line rounded px-1'
                  : state === 'done'
                    ? 'text-dim px-1'
                    : 'text-dim/60 px-1'
              }
            >
              {state === 'next' ? '→ ' : '  '}
              {opLabel(s)}
            </li>
          );
        })}
      </ol>
      <div className="flex gap-2">
        <button data-action="step" className={btnPrimary} disabled={done} onClick={() => !done && onStep()}>
          step
        </button>
        <button data-action="run-all" className={btn} disabled={done} onClick={() => !done && onRunAll()}>
          run to end
        </button>
        <button data-action="reset" className={btn} onClick={onReset}>
          reset
        </button>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/labs/txn/SchedulePanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/labs/txn/SchedulePanel.tsx src/ui/labs/txn/SchedulePanel.test.tsx
git commit -m "feat(ui): SchedulePanel — preset picker + lockstep op cursor"
```

---

### Task 11: IsolationPanel

**Files:**
- Create: `src/ui/labs/txn/IsolationPanel.tsx`
- Test: `src/ui/labs/txn/IsolationPanel.test.tsx`

**Interfaces:**
- Consumes: `TxnInspect` (Task 7).
- Produces: `IsolationPanel({ inspect }: { inspect: TxnInspect })` — Task 13 renders four of these.

- [ ] **Step 1: Write the failing test**

```tsx
// src/ui/labs/txn/IsolationPanel.test.tsx
// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import type { TxnInspect } from '../../../modules/txn';
import { IsolationPanel } from './IsolationPanel';

afterEach(cleanup);

const baseTxn = {
  status: 'idle' as const,
  beganAt: null,
  endedAt: null,
  snapshotAt: null,
  reads: [],
  writes: [],
  abortReason: null,
};

const fixture: TxnInspect = {
  level: 'RU',
  credo: 'reads may see uncommitted data',
  txns: {
    T1: { ...baseTxn, status: 'active', beganAt: 1 },
    T2: { ...baseTxn, status: 'aborted', abortReason: 'ensure failed: alice+bob=1 < 2' },
  },
  committed: { alice: 1, bob: 1 },
  pending: { alice: [{ txn: 'T1', value: 0 }] },
  queue: [],
  anomalies: [{ type: 'dirty-read', detail: 'T2 read x=99 — uncommitted data from T1', at: 4 }],
  counters: { commits: 0, aborts: 1, queuedOps: 0, skippedOps: 0 },
};

test('renders level, credo, txn statuses and abort reason', () => {
  const { container } = render(<IsolationPanel inspect={fixture} />);
  expect(container.textContent).toContain('RU');
  expect(container.textContent).toContain('reads may see uncommitted data');
  expect(container.querySelector('[data-txn="T1"]')?.getAttribute('data-status')).toBe('active');
  expect(container.querySelector('[data-txn="T2"]')?.getAttribute('data-status')).toBe('aborted');
  expect(container.textContent).toContain('ensure failed');
});

test('renders committed values with an uncommitted overlay', () => {
  const { container } = render(<IsolationPanel inspect={fixture} />);
  const alice = container.querySelector('[data-key="alice"]');
  expect(alice?.textContent).toContain('1');
  expect(alice?.textContent).toContain('T1: 0'); // pending overlay
});

test('renders anomaly badges', () => {
  const { container } = render(<IsolationPanel inspect={fixture} />);
  const badges = container.querySelectorAll('[data-anomaly]');
  expect(badges).toHaveLength(1);
  expect(badges[0].getAttribute('data-anomaly')).toBe('dirty-read');
});

test('renders the SER queue when present', () => {
  const { container } = render(
    <IsolationPanel inspect={{ ...fixture, level: 'SER', queue: ['T2 begin', 'T2 read x'] }} />,
  );
  const q = container.querySelectorAll('[data-queued]');
  expect(q).toHaveLength(2);
  expect(q[1].textContent).toContain('T2 read x');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/labs/txn/IsolationPanel.test.tsx`
Expected: FAIL — cannot resolve `./IsolationPanel`.

- [ ] **Step 3: Write the implementation**

```tsx
// src/ui/labs/txn/IsolationPanel.tsx
import type { TxnInspect } from '../../../modules/txn';
import { TXN_IDS } from '../../../modules/txn-shared';

const STATUS_CLASS: Record<string, string> = {
  idle: 'text-dim border-line',
  active: 'text-warn border-warn',
  waiting: 'text-dim border-line border-dashed',
  committed: 'text-set border-set',
  aborted: 'text-sign border-sign',
};

/** One isolation level's world: its txns, its store as it sees it, its sins. */
export function IsolationPanel({ inspect }: { inspect: TxnInspect }) {
  return (
    <section className="border border-line bg-panel rounded p-3 space-y-2 font-mono text-xs w-56">
      <header>
        <h3 className="font-bold text-fg">{inspect.level}</h3>
        <p className="text-dim">{inspect.credo}</p>
      </header>

      <div className="flex gap-2">
        {TXN_IDS.map((id) => (
          <span
            key={id}
            data-txn={id}
            data-status={inspect.txns[id].status}
            className={`border rounded px-1 ${STATUS_CLASS[inspect.txns[id].status]}`}
          >
            {id} {inspect.txns[id].status}
          </span>
        ))}
      </div>
      {TXN_IDS.map(
        (id) =>
          inspect.txns[id].abortReason && (
            <p key={id} className="text-sign">
              {id}: {inspect.txns[id].abortReason}
            </p>
          ),
      )}

      <div className="space-y-0.5">
        {Object.entries(inspect.committed).map(([key, value]) => (
          <div key={key} data-key={key} className="flex flex-wrap gap-1 items-baseline">
            <span className="text-dim">{key}=</span>
            <span className="text-fg">{value}</span>
            {(inspect.pending[key] ?? []).map((p, i) => (
              <span key={i} className="text-warn">
                ({p.txn}: {p.value} uncommitted)
              </span>
            ))}
          </div>
        ))}
      </div>

      {inspect.queue.length > 0 && (
        <div>
          <p className="text-dim">waiting (one txn at a time):</p>
          {inspect.queue.map((label, i) => (
            <p key={i} data-queued={i} className="text-dim/80 pl-2">
              {label}
            </p>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-1">
        {inspect.anomalies.map((a, i) => (
          <span key={i} data-anomaly={a.type} title={a.detail} className="border border-sign text-sign rounded px-1">
            {a.type}
          </span>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/labs/txn/IsolationPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/labs/txn/IsolationPanel.tsx src/ui/labs/txn/IsolationPanel.test.tsx
git commit -m "feat(ui): IsolationPanel — one level's txns, store view, and anomaly badges"
```

---

### Task 12: TxnScoreboard

**Files:**
- Create: `src/ui/labs/txn/TxnScoreboard.tsx`
- Test: `src/ui/labs/txn/TxnScoreboard.test.tsx`

**Interfaces:**
- Consumes: `TxnInspect` (Task 7).
- Produces: `TxnScoreboard({ panels }: { panels: TxnInspect[] })` — panels ordered RU → SER.

- [ ] **Step 1: Write the failing test**

```tsx
// src/ui/labs/txn/TxnScoreboard.test.tsx
// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import type { TxnInspect } from '../../../modules/txn';
import { TxnScoreboard } from './TxnScoreboard';

afterEach(cleanup);

const mk = (level: TxnInspect['level'], anomalies: TxnInspect['anomalies']): TxnInspect => ({
  level,
  credo: '',
  txns: {
    T1: { status: 'committed', beganAt: 1, endedAt: 5, snapshotAt: null, reads: [], writes: [], abortReason: null },
    T2: { status: 'committed', beganAt: 2, endedAt: 8, snapshotAt: null, reads: [], writes: [], abortReason: null },
  },
  committed: { x: 1 },
  pending: {},
  queue: [],
  anomalies,
  counters: { commits: 2, aborts: 0, queuedOps: 0, skippedOps: 0 },
});

const panels = [
  mk('RU', [{ type: 'dirty-read', detail: '', at: 1 }]),
  mk('RC', []),
  mk('SI', []),
  mk('SER', []),
];

test('one column per level, rows for counters and each anomaly type', () => {
  const { container } = render(<TxnScoreboard panels={panels} />);
  const headers = [...container.querySelectorAll('th')].map((h) => h.textContent);
  expect(headers).toEqual(['', 'RU', 'RC', 'SI', 'SER']);
  expect(container.querySelector('[data-cell="RU:dirty reads"]')?.textContent).toBe('1');
  expect(container.querySelector('[data-cell="RC:dirty reads"]')?.textContent).toBe('0');
  expect(container.querySelector('[data-cell="RU:commits"]')?.textContent).toBe('2');
});

test('non-zero anomaly cells are marked bad; zero cells are not', () => {
  const { container } = render(<TxnScoreboard panels={panels} />);
  expect(container.querySelector('[data-cell="RU:dirty reads"]')?.getAttribute('data-bad')).toBe('true');
  expect(container.querySelector('[data-cell="RC:dirty reads"]')?.getAttribute('data-bad')).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/labs/txn/TxnScoreboard.test.tsx`
Expected: FAIL — cannot resolve `./TxnScoreboard`.

- [ ] **Step 3: Write the implementation**

```tsx
// src/ui/labs/txn/TxnScoreboard.tsx
import type { TxnInspect } from '../../../modules/txn';

const ROWS: { label: string; bad: boolean; value: (p: TxnInspect) => number }[] = [
  { label: 'commits', bad: false, value: (p) => p.counters.commits },
  { label: 'aborts', bad: false, value: (p) => p.counters.aborts },
  { label: 'dirty reads', bad: true, value: (p) => p.anomalies.filter((a) => a.type === 'dirty-read').length },
  { label: 'lost updates', bad: true, value: (p) => p.anomalies.filter((a) => a.type === 'lost-update').length },
  { label: 'write skews', bad: true, value: (p) => p.anomalies.filter((a) => a.type === 'write-skew').length },
  { label: 'queued ops', bad: false, value: (p) => p.counters.queuedOps },
];

/** The countable outcome: same schedule, four verdicts. Coral = an anomaly happened here. */
export function TxnScoreboard({ panels }: { panels: TxnInspect[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="font-mono text-xs border border-line bg-panel rounded">
        <thead>
          <tr>
            <th className="px-2 py-1 text-left text-dim" />
            {panels.map((p) => (
              <th key={p.level} className="px-2 py-1 text-fg">
                {p.level}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={row.label} className="border-t border-line">
              <td className="px-2 py-1 text-dim text-left">{row.label}</td>
              {panels.map((p) => {
                const v = row.value(p);
                const bad = row.bad && v > 0;
                return (
                  <td
                    key={p.level}
                    data-cell={`${p.level}:${row.label}`}
                    {...(bad ? { 'data-bad': 'true' } : {})}
                    className={`px-2 py-1 text-center ${bad ? 'text-sign font-bold' : 'text-fg'}`}
                  >
                    {v}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/labs/txn/TxnScoreboard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/labs/txn/TxnScoreboard.tsx src/ui/labs/txn/TxnScoreboard.test.tsx
git commit -m "feat(ui): TxnScoreboard — anomaly counts per isolation level"
```

---

### Task 13: TxnLab — assembly + the three challenges

**Files:**
- Create: `src/ui/labs/txn/TxnLab.tsx`
- Test: `src/ui/labs/txn/TxnLab.test.tsx`

**Interfaces:**
- Consumes: everything above, plus `SimDriver`, `useSimStore`, `ChallengePanel`, `TimelineScrubber` from the kit.
- Produces: `TxnLab()` — wired into `App.tsx` in Task 14.

Key mechanics (copy exactly):
- Driver-in-effect (PR#2 lesson): build `Simulation` + `SimDriver` inside `useEffect` keyed on `[presetId, epoch]`, `useSimStore.getState().reset()` first, return `() => d.pause()`.
- `step()` injects the cursor step to all four nodes, then drains the sim synchronously with `while (driver.sim.pending > 0) driver.stepOnce();` — this also drains the four init events on the first step. Lockstep + deterministic; no rAF needed.
- Challenge verifiers read module state via `driver.sim.getState(...)` and only fire when their preset is active AND the schedule is fully consumed.

- [ ] **Step 1: Write the failing test**

```tsx
// src/ui/labs/txn/TxnLab.test.tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { PRESETS } from '../../../modules/txn-shared';
import { TxnLab } from './TxnLab';

afterEach(cleanup);

test('renders four isolation panels and the schedule', () => {
  const { container } = render(<TxnLab />);
  expect(container.querySelectorAll('[data-txn="T1"]')).toHaveLength(4);
  expect(container.querySelectorAll('[data-preset]')).toHaveLength(3);
});

test('run-to-end on the dirty-read preset: RU flags it, RC does not', () => {
  const { container } = render(<TxnLab />);
  fireEvent.click(container.querySelector('[data-action="run-all"]') as HTMLButtonElement);
  const badges = [...container.querySelectorAll('[data-anomaly="dirty-read"]')];
  expect(badges).toHaveLength(1); // exactly one panel sinned
  expect(container.querySelector('[data-cell="RU:dirty reads"]')?.textContent).toBe('1');
  expect(container.querySelector('[data-cell="RC:dirty reads"]')?.textContent).toBe('0');
});

test('switching preset resets the cursor and the panels', () => {
  const { container } = render(<TxnLab />);
  fireEvent.click(container.querySelector('[data-action="run-all"]') as HTMLButtonElement);
  fireEvent.click(container.querySelector('[data-preset="write-skew"]') as HTMLButtonElement);
  const rows = container.querySelectorAll('[data-step]');
  expect(rows).toHaveLength(PRESETS[2].steps.length);
  expect(rows[0].getAttribute('data-state')).toBe('next');
  expect(container.querySelectorAll('[data-anomaly]')).toHaveLength(0);
});

test('stepping advances all four panels in lockstep', () => {
  const { container } = render(<TxnLab />);
  const step = container.querySelector('[data-action="step"]') as HTMLButtonElement;
  fireEvent.click(step); // T1 begin
  fireEvent.click(step); // T1 write x=99
  const active = [...container.querySelectorAll('[data-txn="T1"]')].map((el) =>
    el.getAttribute('data-status'),
  );
  expect(active).toEqual(['active', 'active', 'active', 'active']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/labs/txn/TxnLab.test.tsx`
Expected: FAIL — cannot resolve `./TxnLab`.

- [ ] **Step 3: Write the implementation**

```tsx
// src/ui/labs/txn/TxnLab.tsx
import { useEffect, useState } from 'react';
import { Simulation } from '../../../engine';
import { committedValue, txn, type TxnInspect, type TxnState } from '../../../modules/txn';
import {
  PRESETS,
  presetById,
  TXN_TOPOLOGY,
  type Level,
  type PresetId,
} from '../../../modules/txn-shared';
import { SimDriver } from '../../bridge/SimDriver';
import { useSimStore } from '../../bridge/simStore';
import { ChallengePanel } from '../../kit/ChallengePanel';
import { TimelineScrubber } from '../../kit/TimelineScrubber';
import { IsolationPanel } from './IsolationPanel';
import { SchedulePanel } from './SchedulePanel';
import { TxnScoreboard } from './TxnScoreboard';

export function TxnLab() {
  const [presetId, setPresetId] = useState<PresetId>('dirty-read');
  const [epoch, setEpoch] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [driver, setDriver] = useState<SimDriver<TxnState> | null>(null);

  const preset = presetById(presetId);

  // Driver-in-effect pattern: build the sim in the commit phase, never during render.
  useEffect(() => {
    useSimStore.getState().reset();
    const seed = 7000 + epoch;
    const sim = new Simulation<TxnState>({
      module: txn,
      config: { nodeIds: TXN_TOPOLOGY, params: { initial: presetById(presetId).initial } },
      seed,
    });
    const d = new SimDriver({ sim, seed, publish: (v) => useSimStore.getState().publish(v) });
    while (d.sim.pending > 0) d.stepOnce(); // drain the four inits so panels render immediately
    setDriver(d);
    setCursor(0);
    return () => d.pause();
  }, [presetId, epoch]);

  const view = useSimStore();
  if (!driver) return null;

  const drain = () => {
    while (driver.sim.pending > 0) driver.stepOnce();
  };
  const inject = (i: number) => {
    for (const id of TXN_TOPOLOGY) driver.external(id, { schedule: preset.steps[i] });
    drain();
  };
  const step = () => {
    if (cursor >= preset.steps.length) return;
    inject(cursor);
    setCursor((c) => c + 1);
  };
  const runAll = () => {
    for (let i = cursor; i < preset.steps.length; i++) inject(i);
    setCursor(preset.steps.length);
  };
  const reset = () => setEpoch((e) => e + 1); // rebuilds the sim, cursor back to 0

  const done = cursor >= preset.steps.length;
  const stateOf = (id: Level) => driver.sim.getState(id);
  const panels = TXN_TOPOLOGY.map(
    (id) => view.nodes.find((n) => n.id === id)?.inspect as unknown as TxnInspect | undefined,
  ).filter((p): p is TxnInspect => p !== undefined && p.txns !== undefined);

  const anomaliesOf = (id: Level) => stateOf(id).anomalies.map((a) => a.type);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <SchedulePanel
          presets={PRESETS}
          activeId={presetId}
          cursor={cursor}
          onPick={(id) => {
            setPresetId(id);
            setEpoch((e) => e + 1);
          }}
          onStep={step}
          onRunAll={runAll}
          onReset={reset}
        />
        {panels.length === 4 && <TxnScoreboard panels={panels} />}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 items-start">
        {panels.map((p) => (
          <IsolationPanel key={p.level} inspect={p} />
        ))}
      </div>

      <TimelineScrubber
        processed={view.processed}
        pending={view.pending}
        running={view.running}
        onPlayPause={() => (view.running ? driver.pause() : driver.start())}
        onStep={() => driver.stepOnce()}
        onScrub={(i) => driver.scrubTo(i)}
      />

      <ChallengePanel
        title="Challenge: read a lie"
        storageKeyPrefix="ddia:ch07:dirty"
        prompt="Run the dirty-read schedule. Predict: which levels let T2 read a value that never existed?"
        runningHint="pick the 'Dirty read' preset and run it to the end."
        check={() => {
          if (presetId !== 'dirty-read' || !done) return null;
          const dirtyAtRuOnly =
            anomaliesOf('RU').includes('dirty-read') &&
            (['RC', 'SI', 'SER'] as const).every((id) => anomaliesOf(id).length === 0);
          return dirtyAtRuOnly ? { ok: true } : null;
        }}
        onWin={() => driver.pause()}
        renderWin={(_w, prediction) => (
          <>
            <p>
              only <code className="text-sign">RU</code> read T1's uncommitted 99 — a value that, after the
              abort, never existed. One rung up, Read Committed already refuses to serve unfinished writes.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />

      <ChallengePanel
        title="Challenge: the vanishing increment"
        storageKeyPrefix="ddia:ch07:lost"
        prompt="Run the lost-update schedule. Predict the final counter at each level (it started at 10)."
        runningHint="pick the 'Lost update' preset and run it to the end."
        check={() => {
          if (presetId !== 'lost-update' || !done) return null;
          const rcLost =
            anomaliesOf('RC').includes('lost-update') && committedValue(stateOf('RC'), 'counter') === 11;
          const siAborted = stateOf('SI').txns.T2.abortReason?.includes('first committer wins') ?? false;
          const serRight =
            committedValue(stateOf('SER'), 'counter') === 12 && anomaliesOf('SER').length === 0;
          return rcLost && siAborted && serRight ? { ok: true } : null;
        }}
        onWin={() => driver.pause()}
        renderWin={(_w, prediction) => (
          <>
            <p>
              RC quietly ate an increment (11). SI refused to be lied to — it aborted T2 instead
              (first committer wins). Only serial execution got <code className="text-set">12</code> with
              no casualties.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />

      <ChallengePanel
        title="Challenge: nobody's on call"
        storageKeyPrefix="ddia:ch07:skew"
        prompt="Run the write-skew schedule. Predict: which levels end with zero doctors on call?"
        runningHint="pick the 'Write skew' preset and run it to the end."
        check={() => {
          if (presetId !== 'write-skew' || !done) return null;
          const onCall = (id: Level) =>
            (committedValue(stateOf(id), 'alice') ?? 0) + (committedValue(stateOf(id), 'bob') ?? 0);
          const weakBroke = (['RU', 'RC', 'SI'] as const).every(
            (id) => anomaliesOf(id).includes('write-skew') && onCall(id) === 0,
          );
          const serHeld =
            onCall('SER') >= 1 && (stateOf('SER').txns.T2.abortReason?.includes('ensure failed') ?? false);
          return weakBroke && serHeld ? { ok: true } : null;
        }}
        onWin={() => driver.pause()}
        renderWin={(_w, prediction) => (
          <>
            <p>
              even <code className="text-sign">SI</code> let both doctors leave — each snapshot showed two on
              call, the writes touched different keys, no conflict was detected. Kleppmann's point exactly:
              write skew is the anomaly snapshot isolation cannot see. Serial execution made T2 re-check —
              and its <code>ensure</code> said no.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/labs/txn/TxnLab.test.tsx`
Expected: PASS. If `view.nodes` inspects are stale-shaped (missing `txns`) on first render, the `panels` filter guards it — panels appear after the first publish.

- [ ] **Step 5: Run the whole txn suite**

Run: `npx vitest run src/modules/txn.test.ts src/modules/txn-lesson.test.ts src/ui/labs/txn`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/labs/txn/TxnLab.tsx src/ui/labs/txn/TxnLab.test.tsx
git commit -m "feat(ui): TxnLab — 4-level lockstep panels + 3 anomaly challenges"
```

---

### Task 14: Debrief, catalog, routing, docs

**Files:**
- Create: `content/ch07/debrief.mdx`
- Create: `src/ui/labs/txn/Debrief.tsx`
- Modify: `src/ui/shell/catalog.ts` (ch7 labs → `active`)
- Modify: `src/ui/App.tsx` (PAGES `'7.1'`, `'7.d'` + imports)
- Modify: `README.md` (Ch7 section, after the Ch6 entry, matching the Ch3/Ch6 entry style)
- Modify: `docs/DESIGN_PLAN.en.md` (Phase 4 shipped note)

**Interfaces:**
- Consumes: `TxnLab` (Task 13). Follows the exact `3.1`/`3.d` patterns shown below.

- [ ] **Step 1: Write the debrief content**

```mdx
// content/ch07/debrief.mdx  (plain MDX — mirror the heading style of content/ch03/debrief.mdx)
# Chapter 7 — Transactions: Debrief

## One schedule, four verdicts

You replayed the exact same interleaving of two transactions under four isolation levels
and got four different histories. Nothing about the schedule changed — only the rules for
what a read may see and what a commit must check.

## The ladder you climbed

**Read Uncommitted** let T2 read a value T1 later rolled back — a **dirty read**: acting
on data that, officially, never existed.

**Read Committed** refuses to serve unfinished writes. But both increments still read the
same starting value and the second commit silently clobbered the first — a **lost
update**. Seeing only committed data is not the same as seeing *current* data.

**Snapshot Isolation** gives every transaction a frozen, consistent view, and aborts the
second writer of the same key (*first committer wins*) — the lost update became an
explicit abort. But when two doctors each checked the rota and went off call, SI saw no
conflict: the writes touched *different* keys. **Write skew** is the anomaly a snapshot
cannot see, because the problem lives in what was *read*, not what was written.

**Serializable** (here: actual serial execution, one transaction at a time) ends the
argument. T2's re-check ran after T1 finished, saw one doctor left, and refused. The
price was waiting — you watched T2's ops queue up. Serializability always costs
something: throughput, aborts, or latency.

## What real databases do

Real engines rarely run serially (though Redis and VoltDB do). PostgreSQL's
`SERIALIZABLE` uses **SSI** — it lets snapshot transactions run and aborts the ones whose
read/write dependencies form a dangerous cycle. The older road is **two-phase locking**:
reads block writes, writes block readers, and write skew dies as a deadlock instead.
Also worth knowing: in PostgreSQL, `REPEATABLE READ` *is* snapshot isolation — and the
default is `READ COMMITTED`, one rung below the level that stops a lost update.

## The takeaway

"Use transactions" is where the conversation starts, not where it ends. Ask: which
anomaly can my access pattern produce, and which is the *weakest* level (cheapest) that
provably blocks it? You now have the lab to answer that by experiment.
```

Note: strip the `// content/...` path comment line when writing the real file — MDX has no `//` comments; the first line must be the `#` heading.

- [ ] **Step 2: Write the debrief page**

```tsx
// src/ui/labs/txn/Debrief.tsx
import DebriefContent from '../../../../content/ch07/debrief.mdx';
import { DebriefArticle } from '../../kit/DebriefArticle';
import { SurpriseJournal } from '../../kit/SurpriseJournal';

export function TxnDebrief() {
  return (
    <DebriefArticle>
      <DebriefContent />
      <SurpriseJournal storageKey="ddia:ch07:journal" />
    </DebriefArticle>
  );
}
```

- [ ] **Step 3: Catalog — replace the ch7 entry in `src/ui/shell/catalog.ts`**

Replace:

```ts
    id: 'ch7',
    title: 'Ch.7 — Transactions',
    labs: [{ id: '7.1', label: 'Isolation Anomaly Lab', status: 'soon' }],
```

with:

```ts
    id: 'ch7',
    title: 'Ch.7 — Transactions',
    labs: [
      { id: '7.1', label: 'Isolation Anomaly Lab', status: 'active' },
      { id: '7.d', label: 'Debrief & Journal', status: 'active' },
    ],
```

- [ ] **Step 4: App — add imports and PAGES entries in `src/ui/App.tsx`**

Add imports next to the storage lab imports:

```ts
import { TxnLab } from './labs/txn/TxnLab';
import { TxnDebrief } from './labs/txn/Debrief';
```

Add to `PAGES` after the `'6.d'` entry (keep numeric book order in the object):

```ts
  '7.1': {
    eyebrow: 'Chapter 7 — Transactions',
    title: 'Isolation Anomaly Lab',
    thesis:
      'The same two-transaction schedule replays under four isolation levels at once. Watch a dirty read die at Read Committed, a lost update die at Snapshot Isolation, and write skew — the doctors-on-call problem — survive everything but serial execution.',
    Component: TxnLab,
  },
  '7.d': {
    eyebrow: 'Chapter 7 — Debrief',
    title: 'The isolation ladder',
    thesis:
      'Each level buys off exactly one class of race, and each rung costs more — aborts, queueing, throughput. Why "use transactions" is the start of the conversation, not the end.',
    Component: TxnDebrief,
  },
```

- [ ] **Step 5: README — add the Ch7 section after Ch6**

Match the existing entry style (bold chapter line + one bullet per lab):

```markdown
**Ch.7 — Transactions:**
- **7.1 Isolation Anomaly Lab** — one preset schedule, four isolation levels running side-by-side (Read Uncommitted / Read Committed / Snapshot Isolation / Serializable-as-serial-execution); step the interleaving op-by-op and watch each anomaly die at a successive rung. Challenges: *read a lie (dirty read)*, *the vanishing increment (lost update)*, *nobody's on call (write skew under SI — Kleppmann's doctors)*.
```

- [ ] **Step 6: DESIGN_PLAN — mark Phase 4 shipped**

In `docs/DESIGN_PLAN.en.md`, append to the Phase 4 line (mirroring the Phase 2 shipped-note style):

```markdown
**Phase 4 — Transactions: Chapter 7 (2–3 weeks).** The isolation anomaly lab with the drag-and-drop timeline. *(shipped 2026-07-16 — 7.1 four-level lockstep panels [RU/RC/SI/SER-serial] over three preset anomaly schedules + 7.d debrief; the write-skew-under-SI win condition is met via the doctors preset. Deviation: drag-and-drop free-form scheduling deferred — presets + step-through ship the same lesson at a fraction of the surface; see the Ch7 spec §1 Out.)*
```

- [ ] **Step 7: Run the full test suite and typecheck**

Run: `npx vitest run && npx tsc -b`
Expected: all suites PASS (catalog test picks up the new active labs automatically — if it asserts an explicit active-page list, add `'7.1'`/`'7.d'` there), typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add content/ch07/debrief.mdx src/ui/labs/txn/Debrief.tsx src/ui/shell/catalog.ts src/ui/App.tsx README.md docs/DESIGN_PLAN.en.md
git commit -m "feat(ui): ship Ch7 transactions lab — debrief, catalog 7.1/7.d active, roadmap"
```

---

### Task 15: Full gate — suite, typecheck, build

**Files:**
- None new. Fix-forward anything the gate catches.

- [ ] **Step 1: Full verification**

Run: `npx vitest run && npx tsc -b && npm run build`
Expected: every suite green, typecheck clean, production build succeeds (MDX import of `content/ch07/debrief.mdx` must resolve — the ch03 debrief proves the pipeline).

- [ ] **Step 2: If anything fails**

Fix the root cause, re-run the full gate, and commit the fix with a conventional message scoped to the file touched (`fix(modules): ...` / `fix(ui): ...`). Do not weaken a pinned test to pass the gate.

- [ ] **Step 3: Final commit (only if fixes were made)**

```bash
git add <specific files>
git commit -m "fix: <what the gate caught>"
```

---

## Post-plan (main thread, not the executor)

Ship: push `master` → GitHub Pages CI deploys. Verify the workflow goes green (`gh run watch`), then spot-check `7.1` and `7.d` on the live site. Update the memory ledger.
