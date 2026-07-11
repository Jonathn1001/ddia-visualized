# Ch5 Completion — Multi-Leader + Leaderless Quorum Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete DDIA Chapter 5 — ship the Multi-Leader (LWW conflicts) and Leaderless Quorum (w/r, read repair, sloppy + hinted handoff) labs with two new engine-verified chaos challenges.

**Architecture:** Two new pure SimModules (`multileader.ts`, `leaderless.ts`) on contract v0.2 — zero engine changes; timeouts are module timers, LWW timestamps derive from `event.time` with a Lamport-style bump. The lab-specific `ChallengePanel` and `ClientControls` generalize into the kit; labs 5.2/5.3 are thin assemblies. Spec: `docs/superpowers/specs/2026-07-10-ch5-completion-design.md`.

**Tech Stack:** Existing only — TypeScript strict, Vitest, fast-check, React 19 + kit components, Tailwind theme tokens. No new dependencies.

## Global Constraints

- Working directory: `/home/elgnas/Projects/Personal/ddia-visualized`.
- `src/modules/**` stays pure: no React/DOM/UI imports, no `Math.random`/`Date.now` (ESLint-enforced); all time from `event.time`, all state plain JSON.
- Zero engine changes (spec "In" scope). Modules use contract v0.2 as-is.
- Coverage gate ≥ 80% on `src/engine/**` + `src/modules/**` must hold.
- Theme tokens only in UI (`ink/panel/line/dim/fg/set/sign/warn`, `kit/classes.ts`) — no hardcoded slate/sky classes.
- localStorage key scheme: `<prefix>:attempt`, `<prefix>:prediction:<n>`. 5.1 keeps prefix `ddia:ch05:stale-read` so stored attempts survive the refactor.
- Every task leaves a deployable state (master auto-deploys via CI).
- Conventional commit messages.

**Spec DoD → task mapping:**

| DoD item | Task |
|---|---|
| 5.2 + 5.3 live, sidebar active | 4, 7, 8 |
| Both challenges engine-verified with predict-before-run | 1, 4, 7 |
| ≥ 3 live metrics per lab | 2, 5 |
| 4 property tests green | 3, 6 |
| Coverage ≥ 80% holds; CI green | every task; verified 8 |
| Debrief 5.d extended | 8 |

---

### Task 1: Generalize ChallengePanel + KVControls into the kit; migrate 5.1

**Files:**
- Create: `src/ui/kit/ChallengePanel.tsx`, `src/ui/kit/KVControls.tsx`
- Delete: `src/ui/labs/replication/ChallengePanel.tsx`, `src/ui/labs/replication/ClientControls.tsx`
- Modify: `src/ui/labs/replication/ReplicationLab.tsx`
- Test: `src/ui/labs/replication/ChallengePanel.test.tsx` (rewrite against the kit panel wired with `detectStaleRead`)

**Interfaces:**
- Consumes: `useSimStore` (`processed` as re-check trigger), `btn`/`btnPrimary` from `kit/classes.ts`, `detectStaleRead` from `src/modules/replication.ts`.
- Produces (Tasks 4 and 7 rely on these exact signatures):

```tsx
// kit/ChallengePanel.tsx
export function ChallengePanel<R>(props: {
  title: string;
  storageKeyPrefix: string;      // e.g. 'ddia:ch05:stale-read'
  prompt: string;                // textarea placeholder
  runningHint: string;           // shown while attempt runs
  check: () => R | null;         // engine verifier; re-run on every store publish
  onWin?: () => void;            // e.g. driver.pause
  renderWin: (result: R, prediction: string) => ReactNode;
}): ReactNode;

// kit/KVControls.tsx
export function KVControls(props: {
  writeTargets: NodeId[];
  readTargets: NodeId[];
  onWrite: (node: NodeId, key: string, value: string) => void;
  onRead: (node: NodeId, key: string) => void;
}): ReactNode;
```

- [ ] **Step 1: Rewrite the challenge test against the kit panel**

Replace the full contents of `src/ui/labs/replication/ChallengePanel.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { Simulation, type NodeId } from '../../../engine';
import {
  detectStaleRead,
  replication,
  type RepPayload,
  type RepState,
} from '../../../modules/replication';
import { SimDriver } from '../../bridge/SimDriver';
import { useSimStore } from '../../bridge/simStore';
import { ChallengePanel } from '../../kit/ChallengePanel';

afterEach(cleanup);

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

function statesOf(driver: ReturnType<typeof makeDriver>) {
  return new Map<NodeId, RepState>(
    driver.sim.config.nodeIds.map((id) => [id, driver.sim.getState(id)] as const),
  );
}

function renderPanel(driver: ReturnType<typeof makeDriver>) {
  return render(
    <ChallengePanel
      title="Chaos Challenge: produce a stale read"
      storageKeyPrefix="ddia:ch05:stale-read"
      prompt="Predict first: how will you cause a stale read? (skippable)"
      runningHint="make a read return older data than an acknowledged write."
      check={() => detectStaleRead(statesOf(driver))}
      onWin={() => driver.pause()}
      renderWin={(win, prediction) => (
        <>
          <p>
            read {win.read.key} @ {win.read.node} returned seq {win.read.returnedSeq}
          </p>
          <p>your prediction: “{prediction}”</p>
        </>
      )}
    />,
  );
}

beforeEach(() => {
  localStorage.clear();
  useSimStore.getState().reset();
});

test('prediction stored on attempt start; win detected and rendered with prediction', () => {
  const driver = makeDriver();
  renderPanel(driver);
  fireEvent.change(screen.getByPlaceholderText(/how will you cause/i), {
    target: { value: 'read follower before append arrives' },
  });
  fireEvent.click(screen.getByText('start attempt'));
  expect(localStorage.getItem('ddia:ch05:stale-read:prediction:1')).toBe(
    'read follower before append arrives',
  );

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

test('attempt counter increments in localStorage', () => {
  const driver = makeDriver();
  renderPanel(driver);
  fireEvent.click(screen.getByText('start attempt'));
  expect(localStorage.getItem('ddia:ch05:stale-read:attempt')).toBe('1');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/labs/replication/ChallengePanel.test.tsx`
Expected: FAIL — `../../kit/ChallengePanel` not found.

- [ ] **Step 3: Implement the generic kit ChallengePanel**

```tsx
// src/ui/kit/ChallengePanel.tsx
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useSimStore } from '../bridge/simStore';
import { btnPrimary } from './classes';

/**
 * Generic chaos-challenge lifecycle (DESIGN_PLAN §3): predict-before-run,
 * engine-verified win, prediction-vs-reality reveal. Each lab supplies its
 * verifier (`check`) and win renderer; persistence keys derive from
 * `storageKeyPrefix` (`<prefix>:attempt`, `<prefix>:prediction:<n>`).
 */
export function ChallengePanel<R>({
  title,
  storageKeyPrefix,
  prompt,
  runningHint,
  check,
  onWin,
  renderWin,
}: {
  title: string;
  storageKeyPrefix: string;
  prompt: string;
  runningHint: string;
  check: () => R | null;
  onWin?: () => void;
  renderWin: (result: R, prediction: string) => ReactNode;
}) {
  const processed = useSimStore((s) => s.processed);
  const [attempt, setAttempt] = useState<number | null>(null);
  const [prediction, setPrediction] = useState('');
  const [win, setWin] = useState<R | null>(null);

  useEffect(() => {
    if (attempt === null || win) return;
    const result = check();
    if (result) {
      setWin(result);
      onWin?.();
    }
  }, [processed, attempt, win, check, onWin]);

  const start = () => {
    const n = Number(localStorage.getItem(`${storageKeyPrefix}:attempt`) ?? '0') + 1;
    localStorage.setItem(`${storageKeyPrefix}:attempt`, String(n));
    localStorage.setItem(`${storageKeyPrefix}:prediction:${n}`, prediction);
    setAttempt(n);
    setWin(null);
  };

  return (
    <section className="border border-line bg-panel rounded p-3 space-y-2 max-w-xl">
      <h2 className="font-bold text-sm text-fg">{title}</h2>
      {attempt === null && (
        <>
          <textarea
            className="w-full bg-ink border border-line rounded p-2 text-xs font-mono text-fg"
            rows={2}
            placeholder={prompt}
            value={prediction}
            onChange={(e) => setPrediction(e.target.value)}
          />
          <button className={btnPrimary} onClick={start}>
            start attempt
          </button>
        </>
      )}
      {attempt !== null && !win && (
        <p className="text-xs text-dim font-mono">
          attempt #{attempt} running — {runningHint}
        </p>
      )}
      {attempt !== null && win && (
        <div className="text-xs font-mono space-y-1 text-fg">
          <p className="text-set font-bold">✓ challenge complete — verified by the engine</p>
          {renderWin(
            win,
            localStorage.getItem(`${storageKeyPrefix}:prediction:${attempt}`) || '(skipped)',
          )}
          <button className="underline text-fg" onClick={() => setAttempt(null)}>
            try again
          </button>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Implement KVControls**

```tsx
// src/ui/kit/KVControls.tsx
import { useState } from 'react';
import type { NodeId } from '../../engine';
import { btn, inputBox } from './classes';

/** Key/value client controls: write and read buttons per declared target node. */
export function KVControls({
  writeTargets,
  readTargets,
  onWrite,
  onRead,
}: {
  writeTargets: NodeId[];
  readTargets: NodeId[];
  onWrite: (node: NodeId, key: string, value: string) => void;
  onRead: (node: NodeId, key: string) => void;
}) {
  const [key, setKey] = useState('x');
  const [value, setValue] = useState('1');
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
      <input
        className={`w-16 ${inputBox}`}
        value={key}
        onChange={(e) => setKey(e.target.value)}
        aria-label="key"
      />
      <input
        className={`w-16 ${inputBox}`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label="value"
      />
      {writeTargets.map((id) => (
        <button key={`w-${id}`} className={btn} onClick={() => onWrite(id, key, value)}>
          write @ {id}
        </button>
      ))}
      {readTargets.map((id) => (
        <button key={`r-${id}`} className={btn} onClick={() => onRead(id, key)}>
          read @ {id}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Migrate ReplicationLab; delete the lab-local components**

Delete `src/ui/labs/replication/ChallengePanel.tsx` and `src/ui/labs/replication/ClientControls.tsx`.

Replace the full contents of `src/ui/labs/replication/ReplicationLab.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { Simulation, type NodeId } from '../../../engine';
import {
  detectStaleRead,
  replication,
  type RepMode,
  type RepPayload,
  type RepState,
} from '../../../modules/replication';
import { SimDriver } from '../../bridge/SimDriver';
import { useSimStore } from '../../bridge/simStore';
import { ChaosToolbar } from '../../kit/ChaosToolbar';
import { ChallengePanel } from '../../kit/ChallengePanel';
import { ClusterView } from '../../kit/ClusterView';
import { KVControls } from '../../kit/KVControls';
import { MetricsPanel } from '../../kit/MetricsPanel';
import { TimelineScrubber } from '../../kit/TimelineScrubber';
import { btn } from '../../kit/classes';

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

  const statesOf = () =>
    new Map<NodeId, RepState>(
      driver.sim.config.nodeIds.map((id) => [id, driver.sim.getState(id)] as const),
    );

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
        <button className={btn} onClick={() => setEpoch((e) => e + 1)}>
          reset (new seed)
        </button>
        <button
          className={btn}
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
      <KVControls
        writeTargets={['L']}
        readTargets={NODE_IDS}
        onWrite={(node, key, value) => driver.external(node, { cmd: 'write', key, value })}
        onRead={(node, key) => driver.external(node, { cmd: 'read', key })}
      />
      <ChaosToolbar
        caps={replication.chaos}
        nodeIds={NODE_IDS}
        deadNodes={view.nodes.filter((n) => n.dead).map((n) => n.id)}
        onAction={(a) => driver.control(a)}
      />
      <ChallengePanel
        title="Chaos Challenge: produce a stale read"
        storageKeyPrefix="ddia:ch05:stale-read"
        prompt="Predict first: how will you cause a stale read? (skippable)"
        runningHint="make a read return older data than an acknowledged write."
        check={() => detectStaleRead(statesOf())}
        onWin={() => driver.pause()}
        renderWin={(win, prediction) => (
          <>
            <p>
              read <code className="text-warn">{win.read.key}</code> @ {win.read.node} returned seq{' '}
              {win.read.returnedSeq} at t={win.read.time}, after write seq {win.ack.seq} was acked at
              t={win.ack.time}.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />
    </div>
  );
}
```

- [ ] **Step 6: Run tests, gates**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green (79 tests; the rewritten challenge test passes; nothing else references the deleted files).

- [ ] **Step 7: Commit**

```bash
git add src/ui
git commit -m "refactor(ui): generalize ChallengePanel and KVControls into the kit"
```

---

### Task 2: Multi-leader module (TDD)

**Files:**
- Create: `src/modules/multileader.ts`
- Test: `src/modules/multileader.test.ts`

**Interfaces:**
- Consumes: `SimModule` v0.2 (`event.time`), engine types.
- Produces (Tasks 3–4 rely on these exact names):

```ts
export type MLHistory =
  | { type: 'ack'; key: string; ts: number; origin: NodeId; time: number }
  | { type: 'discarded'; key: string; value: string; ts: number; origin: NodeId; time: number }
  | { type: 'read'; node: NodeId; key: string; returnedTs: number; time: number };
export interface MLState {
  self: NodeId; peer: NodeId;
  data: Record<string, { value: string; ts: number; origin: NodeId }>;
  history: MLHistory[];
}
export type MLPayload =
  | { cmd: 'write'; key: string; value: string }
  | { cmd: 'read'; key: string }
  | { rep: 'update'; key: string; value: string; ts: number; origin: NodeId }
  | null;
export interface LostWriteResult {
  discarded: Extract<MLHistory, { type: 'discarded' }>;
  ack: Extract<MLHistory, { type: 'ack' }>;
}
export function detectLostWrite(states: Map<NodeId, MLState>): LostWriteResult | null;
export const multiLeader: SimModule<MLState, MLPayload>; // id 'multi-leader-lww'
```

- Semantics: writes accepted at either node; local apply with Lamport-bumped
  timestamp `ts = max(event.time, current.ts + 1)`; immediate ack; async
  fire-and-forget replication (no retransmit — a dropped update diverges
  forever); LWW `(ts, origin)` lexicographic on incoming updates; losers
  recorded as `discarded`.
- Metrics: `conflicts-detected`, `acked-writes`, `divergent-keys`, `writes-per-sec`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/modules/multileader.test.ts
import { expect, test } from 'vitest';
import { Simulation, type NodeId } from '../engine';
import { detectLostWrite, multiLeader, type MLPayload, type MLState } from './multileader';

const NODES = ['DC1', 'DC2'];

function makeSim(network?: { latency?: [number, number]; dropRate?: number }) {
  return new Simulation<MLState, MLPayload>({
    module: multiLeader,
    config: { nodeIds: NODES },
    seed: 21,
    network: { latency: [5, 20], ...network },
  });
}

function statesOf(sim: Simulation<MLState, MLPayload>) {
  return new Map<NodeId, MLState>(NODES.map((id) => [id, sim.getState(id)] as const));
}

test('write acks immediately and replicates to the peer', () => {
  const sim = makeSim();
  sim.runSteps(2); // inits
  sim.external('DC1', { cmd: 'write', key: 'x', value: 'a' });
  sim.runSteps(1);
  expect(sim.getState('DC1').history).toEqual([
    { type: 'ack', key: 'x', ts: 1, origin: 'DC1', time: 0 }, // Lamport bump: max(0, 0+1)
  ]);
  sim.runUntil(500);
  expect(sim.getState('DC2').data['x']).toEqual({ value: 'a', ts: 1, origin: 'DC1' });
});

test('concurrent writes converge; the loser is discarded and detected as a lost acked write', () => {
  const sim = makeSim();
  sim.runSteps(2);
  sim.external('DC1', { cmd: 'write', key: 'x', value: 'from-dc1' });
  sim.external('DC2', { cmd: 'write', key: 'x', value: 'from-dc2' });
  sim.runUntil(500);
  // Same Lamport ts (1,DC1) vs (1,DC2) -> DC2 wins the origin tiebreak everywhere.
  expect(sim.getState('DC1').data['x']).toEqual({ value: 'from-dc2', ts: 1, origin: 'DC2' });
  expect(sim.getState('DC2').data['x']).toEqual({ value: 'from-dc2', ts: 1, origin: 'DC2' });
  const lost = detectLostWrite(statesOf(sim));
  expect(lost).not.toBeNull();
  expect(lost!.discarded).toMatchObject({ key: 'x', value: 'from-dc1', origin: 'DC1' });
  expect(lost!.ack).toMatchObject({ key: 'x', origin: 'DC1' });
});

test('Lamport bump: a write issued after seeing a newer update wins everywhere', () => {
  const sim = makeSim({ latency: [1, 1] });
  sim.runSteps(2);
  sim.external('DC2', { cmd: 'write', key: 'x', value: 'old' });
  sim.runUntil(50); // DC1 has (1, DC2)
  sim.external('DC1', { cmd: 'write', key: 'x', value: 'new' }); // ts = max(50, 1+1) = 50
  sim.runUntil(200);
  expect(sim.getState('DC1').data['x']!.value).toBe('new');
  expect(sim.getState('DC2').data['x']!.value).toBe('new');
  expect(detectLostWrite(statesOf(sim))).toBeNull(); // causal overwrite is not a conflict
});

test('reads record the returned timestamp', () => {
  const sim = makeSim();
  sim.runSteps(2);
  sim.external('DC2', { cmd: 'read', key: 'x' });
  sim.runSteps(1);
  expect(sim.getState('DC2').history).toEqual([
    { type: 'read', node: 'DC2', key: 'x', returnedTs: 0, time: 0 },
  ]);
});

test('metrics: divergent-keys counts a permanently dropped update', () => {
  const sim = makeSim({ dropRate: 1 });
  sim.runSteps(2);
  sim.external('DC1', { cmd: 'write', key: 'x', value: 'a' }); // update to DC2 dropped
  sim.runUntil(500);
  const m = Object.fromEntries(
    sim.module.metrics(statesOf(sim), sim.time).map((s) => [s.name, s.value]),
  );
  expect(m['divergent-keys']).toBe(1);
  expect(m['acked-writes']).toBe(1);
  expect(m['conflicts-detected']).toBe(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/modules/multileader.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

```ts
// src/modules/multileader.ts
import type { NodeId } from '../engine/events';
import type { Effect, InspectorTree, ModuleEvent, SimModule } from '../engine/module';

/**
 * Multi-leader replication with LWW conflict resolution (DDIA Ch5).
 * Both nodes accept writes, ack immediately (async by nature), and replicate
 * fire-and-forget — no retransmission, no anti-entropy: a dropped update
 * diverges forever (the debrief names this). Timestamps are Lamport-bumped
 * virtual time; LWW compares (ts, origin) lexicographically, so ties are
 * deterministic. The losing concurrent write is recorded as `discarded` —
 * that record IS the visible data loss.
 */
export type MLHistory =
  | { type: 'ack'; key: string; ts: number; origin: NodeId; time: number }
  | { type: 'discarded'; key: string; value: string; ts: number; origin: NodeId; time: number }
  | { type: 'read'; node: NodeId; key: string; returnedTs: number; time: number };

export interface MLState {
  self: NodeId;
  peer: NodeId;
  data: Record<string, { value: string; ts: number; origin: NodeId }>;
  history: MLHistory[];
}

export type MLPayload =
  | { cmd: 'write'; key: string; value: string }
  | { cmd: 'read'; key: string }
  | { rep: 'update'; key: string; value: string; ts: number; origin: NodeId }
  | null;

function wins(aTs: number, aOrigin: NodeId, bTs: number, bOrigin: NodeId): boolean {
  return aTs !== bTs ? aTs > bTs : aOrigin > bOrigin;
}

export interface LostWriteResult {
  discarded: Extract<MLHistory, { type: 'discarded' }>;
  ack: Extract<MLHistory, { type: 'ack' }>;
}

/** An acked write that LWW silently threw away at the other node. */
export function detectLostWrite(states: Map<NodeId, MLState>): LostWriteResult | null {
  const acks: Extract<MLHistory, { type: 'ack' }>[] = [];
  for (const s of states.values())
    for (const h of s.history) if (h.type === 'ack') acks.push(h);
  for (const s of states.values()) {
    for (const h of s.history) {
      if (h.type !== 'discarded') continue;
      const ack = acks.find((a) => a.key === h.key && a.ts === h.ts && a.origin === h.origin);
      if (ack) return { discarded: h, ack };
    }
  }
  return null;
}

export const multiLeader: SimModule<MLState, MLPayload> = {
  id: 'multi-leader-lww',
  chaos: ['kill-node', 'partition', 'delay', 'drop', 'duplicate'],

  init(nodeId, config) {
    const peer = config.nodeIds.find((n) => n !== nodeId)!;
    return { self: nodeId, peer, data: {}, history: [] };
  },

  reduce(state, event): [MLState, Effect[]] {
    const p = event.payload;
    if (event.kind === 'external' && p && 'cmd' in p) {
      if (p.cmd === 'read') {
        const returnedTs = state.data[p.key]?.ts ?? 0;
        return [
          {
            ...state,
            history: [
              ...state.history,
              { type: 'read', node: state.self, key: p.key, returnedTs, time: event.time },
            ],
          },
          [],
        ];
      }
      // write: Lamport bump guarantees a local write supersedes what this node has seen.
      const cur = state.data[p.key];
      const ts = Math.max(event.time, (cur?.ts ?? 0) + 1);
      const next: MLState = {
        ...state,
        data: { ...state.data, [p.key]: { value: p.value, ts, origin: state.self } },
        history: [
          ...state.history,
          { type: 'ack', key: p.key, ts, origin: state.self, time: event.time },
        ],
      };
      return [
        next,
        [{ type: 'send', to: state.peer, payload: { rep: 'update', key: p.key, value: p.value, ts, origin: state.self } }],
      ];
    }
    if (event.kind === 'message' && p && 'rep' in p) {
      const cur = state.data[p.key];
      if (!cur || wins(p.ts, p.origin, cur.ts, cur.origin)) {
        return [
          { ...state, data: { ...state.data, [p.key]: { value: p.value, ts: p.ts, origin: p.origin } } },
          [],
        ];
      }
      if (cur.ts === p.ts && cur.origin === p.origin) return [state, []]; // duplicate delivery
      return [
        {
          ...state,
          history: [
            ...state.history,
            { type: 'discarded', key: p.key, value: p.value, ts: p.ts, origin: p.origin, time: event.time },
          ],
        },
        [],
      ];
    }
    return [state, []];
  },

  metrics(states, time) {
    let conflicts = 0;
    const acks: Extract<MLHistory, { type: 'ack' }>[] = [];
    for (const s of states.values()) {
      for (const h of s.history) {
        if (h.type === 'discarded') conflicts++;
        if (h.type === 'ack') acks.push(h);
      }
    }
    const [a, b] = [...states.values()];
    let divergent = 0;
    if (a && b) {
      const keys = new Set([...Object.keys(a.data), ...Object.keys(b.data)]);
      for (const k of keys) {
        const va = a.data[k];
        const vb = b.data[k];
        if (!va || !vb || va.ts !== vb.ts || va.origin !== vb.origin) divergent++;
      }
    }
    return [
      { name: 'conflicts-detected', value: conflicts },
      { name: 'acked-writes', value: acks.length },
      { name: 'divergent-keys', value: divergent },
      { name: 'writes-per-sec', value: acks.filter((x) => x.time > time - 1000).length },
    ];
  },

  inspect(state) {
    return {
      role: 'leader',
      data: state.data,
      discarded: state.history.filter((h) => h.type === 'discarded').length,
    } as InspectorTree;
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/modules/multileader.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Full suite, gates, commit**

Run: `npm test && npm run lint && npm run typecheck && npm run coverage`
Expected: all green; coverage gate holds.

```bash
git add src/modules/multileader.ts src/modules/multileader.test.ts
git commit -m "feat(modules): multi-leader LWW replication with visible conflict loss"
```

---

### Task 3: Multi-leader property tests

**Files:**
- Create: `src/modules/multileader.property.test.ts`

**Interfaces:**
- Consumes: `multiLeader`, `detectLostWrite`, `MLState`, `MLPayload` (Task 2).

- [ ] **Step 1: Write the properties**

```ts
// src/modules/multileader.property.test.ts
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { Simulation, type NodeId } from '../engine';
import { detectLostWrite, multiLeader, type MLPayload, type MLState } from './multileader';

const NODES = ['DC1', 'DC2'];
const KEYS = ['a', 'b', 'c'];

interface WriteOp {
  node: string;
  key: string;
}

const writeArb: fc.Arbitrary<WriteOp> = fc.record({
  node: fc.constantFrom(...NODES),
  key: fc.constantFrom(...KEYS),
});

function run(seed: number, ops: WriteOp[], singleLeader: boolean) {
  const sim = new Simulation<MLState, MLPayload>({
    module: multiLeader,
    config: { nodeIds: NODES },
    seed,
    network: { latency: [1, 50] },
  });
  sim.runSteps(2);
  let t = 0;
  ops.forEach((op, i) => {
    t += 20;
    sim.runUntil(t);
    sim.external(singleLeader ? 'DC1' : op.node, { cmd: 'write', key: op.key, value: `v${i}` });
  });
  sim.runUntil(t + 2000);
  return sim;
}

test('property: with no drops, both leaders converge to identical data', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 2 ** 30 }),
      fc.array(writeArb, { minLength: 1, maxLength: 20 }),
      (seed, ops) => {
        const sim = run(seed, ops, false);
        expect(sim.getState('DC1').data).toEqual(sim.getState('DC2').data);
      },
    ),
    { numRuns: 50 },
  );
});

test('property: detectLostWrite never fires when all writes target one leader', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 2 ** 30 }),
      fc.array(writeArb, { minLength: 1, maxLength: 20 }),
      (seed, ops) => {
        const sim = run(seed, ops, true);
        const states = new Map<NodeId, MLState>(
          NODES.map((id) => [id, sim.getState(id)] as const),
        );
        expect(detectLostWrite(states)).toBeNull();
      },
    ),
    { numRuns: 50 },
  );
});
```

- [ ] **Step 2: Run, then full suite**

Run: `npx vitest run src/modules/multileader.property.test.ts && npm test`
Expected: PASS (2 properties × 50 runs); full suite green. On a property failure, fast-check prints the shrunken counterexample — fix the module, not the property.

- [ ] **Step 3: Commit**

```bash
git add src/modules/multileader.property.test.ts
git commit -m "test(modules): multi-leader properties — convergence, single-leader soundness"
```

---

### Task 4: MultiLeaderLab page + lost-write challenge + catalog 5.2

**Files:**
- Create: `src/ui/labs/multileader/MultiLeaderLab.tsx`
- Modify: `src/ui/shell/catalog.ts` (add 5.2 active), `src/ui/App.tsx` (PAGES entry)

**Interfaces:**
- Consumes: kit (`ChallengePanel`, `KVControls`, `ClusterView`, `MetricsPanel`, `TimelineScrubber`, `ChaosToolbar`, `classes`), bridge, `multiLeader` + `detectLostWrite` (Task 2).
- Produces: `MultiLeaderLab()` registered as PAGES `'5.2'`.

- [ ] **Step 1: Implement the lab page**

```tsx
// src/ui/labs/multileader/MultiLeaderLab.tsx
import { useEffect, useRef, useState } from 'react';
import { Simulation, type NodeId } from '../../../engine';
import {
  detectLostWrite,
  multiLeader,
  type MLPayload,
  type MLState,
} from '../../../modules/multileader';
import { SimDriver } from '../../bridge/SimDriver';
import { useSimStore } from '../../bridge/simStore';
import { ChaosToolbar } from '../../kit/ChaosToolbar';
import { ChallengePanel } from '../../kit/ChallengePanel';
import { ClusterView } from '../../kit/ClusterView';
import { KVControls } from '../../kit/KVControls';
import { MetricsPanel } from '../../kit/MetricsPanel';
import { TimelineScrubber } from '../../kit/TimelineScrubber';
import { btn } from '../../kit/classes';

const NODE_IDS = ['DC1', 'DC2'];

export function MultiLeaderLab() {
  const [epoch, setEpoch] = useState(0);
  const ref = useRef<{ driver: SimDriver<MLState, MLPayload>; key: string } | null>(null);
  const simKey = `${epoch}`;
  if (!ref.current || ref.current.key !== simKey) {
    ref.current?.driver.pause();
    useSimStore.getState().reset();
    const seed = 2000 + epoch;
    const sim = new Simulation<MLState, MLPayload>({
      module: multiLeader,
      config: { nodeIds: NODE_IDS },
      seed,
      network: { latency: [30, 120] }, // wide window: concurrent writes are easy to produce
    });
    ref.current = {
      driver: new SimDriver({ sim, seed, publish: (v) => useSimStore.getState().publish(v) }),
      key: simKey,
    };
  }
  const driver = ref.current.driver;
  useEffect(() => () => driver.pause(), [driver]);
  const view = useSimStore();

  const statesOf = () =>
    new Map<NodeId, MLState>(
      driver.sim.config.nodeIds.map((id) => [id, driver.sim.getState(id)] as const),
    );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 text-xs font-mono">
        <span>two leaders, async cross-replication, LWW</span>
        <button className={btn} onClick={() => setEpoch((e) => e + 1)}>
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
      <KVControls
        writeTargets={NODE_IDS}
        readTargets={NODE_IDS}
        onWrite={(node, key, value) => driver.external(node, { cmd: 'write', key, value })}
        onRead={(node, key) => driver.external(node, { cmd: 'read', key })}
      />
      <ChaosToolbar
        caps={multiLeader.chaos}
        nodeIds={NODE_IDS}
        deadNodes={view.nodes.filter((n) => n.dead).map((n) => n.id)}
        onAction={(a) => driver.control(a)}
      />
      <ChallengePanel
        title="Chaos Challenge: make an acked write silently disappear"
        storageKeyPrefix="ddia:ch05:lost-write"
        prompt="Predict first: how do two leaders lose an acknowledged write? (skippable)"
        runningHint="get a write acked at one leader, then have LWW throw it away."
        check={() => detectLostWrite(statesOf())}
        onWin={() => driver.pause()}
        renderWin={(win, prediction) => (
          <>
            <p>
              write <code className="text-warn">{win.discarded.key}={win.discarded.value}</code> was
              acked at {win.ack.origin} (t={win.ack.time}), then LWW discarded it — the concurrent
              write with the higher (ts, origin) won everywhere. No error was ever shown.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />
    </div>
  );
}
```

- [ ] **Step 2: Register catalog entry and page**

In `src/ui/shell/catalog.ts`, replace the `ch5` chapter entry with:

```ts
  {
    id: 'ch5',
    title: 'Ch.5 — Replication',
    labs: [
      { id: '5.1', label: 'Replication Theater', status: 'active' },
      { id: '5.2', label: 'Multi-Leader Conflicts', status: 'active' },
      { id: '5.d', label: 'Debrief & Journal', status: 'active' },
    ],
  },
```

In `src/ui/App.tsx`: add the import and a PAGES entry after `'5.1'`:

```tsx
import { MultiLeaderLab } from './labs/multileader/MultiLeaderLab';
```

```tsx
  '5.2': {
    eyebrow: 'Chapter 5 — Replication',
    title: 'Multi-Leader: Write Conflicts',
    thesis:
      'Two datacenters, both accepting writes, replicating to each other asynchronously. Concurrent writes to the same key conflict; last-write-wins resolves them by silently throwing one away — even one that was already acknowledged. Make it happen.',
    Component: MultiLeaderLab,
  },
```

- [ ] **Step 3: Gates + manual smoke**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: all green.
Manual (`npm run dev`): write same key at DC1 and DC2 quickly → `conflicts-detected` ticks; challenge winnable; `divergent-keys` rises with drop slider up.

- [ ] **Step 4: Commit + push (deploys 5.2)**

```bash
git add src/ui
git commit -m "feat(ui): multi-leader lab with lost-write chaos challenge (5.2)"
git push
```

---

### Task 5: Leaderless module (TDD)

**Files:**
- Create: `src/modules/leaderless.ts`
- Test: `src/modules/leaderless.test.ts`

**Interfaces:**
- Consumes: `SimModule` v0.2.
- Produces (Tasks 6–7 rely on these exact names):

```ts
export type LLHistory =
  | { type: 'ack'; key: string; ts: number; time: number }
  | { type: 'failed-write'; key: string; time: number }
  | { type: 'read'; node: NodeId; key: string; returnedTs: number; time: number }
  | { type: 'read-repair'; key: string; to: NodeId; time: number };
export interface LLState { /* full shape in Step 3 */ }
export type LLPayload = /* full union in Step 3 */;
export interface LostAckedWriteResult {
  ack: Extract<LLHistory, { type: 'ack' }>;
  coordinator: NodeId;
}
export function detectLostAckedWrite(
  states: Map<NodeId, LLState>,
  deadNodes: NodeId[],
): LostAckedWriteResult | null;
export const leaderless: SimModule<LLState, LLPayload>; // id 'leaderless-quorum'
```

- Topology: `config.nodeIds = ['A','B','C','D','E']`; home replicas = first 3; fallbacks = rest.
- Params: `config.params = { w, r, sloppy }` (defaults 2/2/false).
- Timing constants: op timeout `200` virtual ms; hinted-handoff retry every `100` virtual ms.
- Semantics: coordinator = whichever node receives the external op. Write fans `store` to the 3 home replicas; replica applies per-key LWW (ts only — single coordinator clock per op) and replies `storeAck`. At `w` acks → `ack` history entry. On timeout: strict → `failed-write`; sloppy → re-send as `storeHint` to fallbacks (fallback acks count toward w; value goes to the fallback's `hintBuffer`, not its `data`), one final timeout later → `failed-write` if still short. Fallbacks retry hint delivery on a timer; a `storeAck` carrying the hint id clears it. Read fans `get` to home replicas, waits `r` replies, returns max-ts; stale responders get read repair (`store` push).

- [ ] **Step 1: Write the failing tests**

```ts
// src/modules/leaderless.test.ts
import { expect, test } from 'vitest';
import { Simulation, type NodeId } from '../engine';
import { detectLostAckedWrite, leaderless, type LLPayload, type LLState } from './leaderless';

const NODES = ['A', 'B', 'C', 'D', 'E'];

function makeSim(params?: { w?: number; r?: number; sloppy?: boolean }) {
  return new Simulation<LLState, LLPayload>({
    module: leaderless,
    config: { nodeIds: NODES, params: { w: 2, r: 2, sloppy: false, ...params } },
    seed: 31,
    network: { latency: [5, 20] },
  });
}

function statesOf(sim: Simulation<LLState, LLPayload>) {
  return new Map<NodeId, LLState>(NODES.map((id) => [id, sim.getState(id)] as const));
}

function acksAt(sim: Simulation<LLState, LLPayload>, node: string) {
  return sim.getState(node).history.filter((h) => h.type === 'ack');
}

test('write acks after w replica acks; value lands on home replicas', () => {
  const sim = makeSim();
  sim.runSteps(5);
  sim.external('A', { cmd: 'write', key: 'x', value: '1' });
  sim.runSteps(1);
  expect(acksAt(sim, 'A')).toHaveLength(0); // not yet — needs w=2 storeAcks
  sim.runUntil(1000);
  expect(acksAt(sim, 'A')).toHaveLength(1);
  for (const id of ['A', 'B', 'C']) expect(sim.getState(id).data['x']?.value).toBe('1');
  expect(sim.getState('D').data['x']).toBeUndefined(); // fallbacks untouched
});

test('strict quorum: unreachable replicas fail the write after timeout', () => {
  const sim = makeSim({ sloppy: false });
  sim.runSteps(5);
  sim.control({ type: 'partition', groups: [['A', 'D', 'E'], ['B', 'C']] });
  sim.external('A', { cmd: 'write', key: 'x', value: '1' });
  sim.runUntil(2000);
  expect(acksAt(sim, 'A')).toHaveLength(0);
  expect(sim.getState('A').history.filter((h) => h.type === 'failed-write')).toHaveLength(1);
});

test('sloppy quorum: fallback hints count toward w; handoff completes after heal', () => {
  const sim = makeSim({ sloppy: true });
  sim.runSteps(5);
  sim.control({ type: 'partition', groups: [['A', 'D', 'E'], ['B', 'C']] });
  sim.external('A', { cmd: 'write', key: 'x', value: '1' });
  sim.runUntil(2000);
  expect(acksAt(sim, 'A')).toHaveLength(1); // A itself + a fallback hint = w=2
  const hintsHeld = ['D', 'E'].reduce(
    (n, id) => n + Object.keys(sim.getState(id).hintBuffer).length,
    0,
  );
  expect(hintsHeld).toBeGreaterThan(0);
  sim.control({ type: 'heal' });
  sim.runUntil(5000);
  // handoff delivered: some previously-cut home replica has the value, hints cleared
  expect(['B', 'C'].some((id) => sim.getState(id).data['x']?.value === '1')).toBe(true);
  const hintsAfter = ['D', 'E'].reduce(
    (n, id) => n + Object.keys(sim.getState(id).hintBuffer).length,
    0,
  );
  expect(hintsAfter).toBe(0);
});

test('read quorum returns the newest value and repairs stale replicas', () => {
  const sim = makeSim({ w: 2, r: 3 });
  sim.runSteps(5);
  sim.control({ type: 'partition', groups: [['A', 'B', 'D', 'E'], ['C']] }); // C misses the write
  sim.external('A', { cmd: 'write', key: 'x', value: '1' });
  sim.runUntil(1000);
  expect(acksAt(sim, 'A')).toHaveLength(1); // A+B = w=2
  sim.control({ type: 'heal' });
  sim.runUntil(1100);
  sim.external('B', { cmd: 'read', key: 'x' });
  sim.runUntil(3000);
  const reads = sim.getState('B').history.filter((h) => h.type === 'read');
  expect(reads).toHaveLength(1);
  expect(reads[0]).toMatchObject({ key: 'x', returnedTs: expect.any(Number) });
  expect(reads[0].returnedTs).toBeGreaterThan(0);
  expect(sim.getState('B').history.filter((h) => h.type === 'read-repair')).toHaveLength(1);
  expect(sim.getState('C').data['x']?.value).toBe('1'); // repaired
});

test('sloppy loss: acked write vanishes when fallbacks die before handoff', () => {
  const sim = makeSim({ sloppy: true });
  sim.runSteps(5);
  // Coordinator E is NOT a home replica: all home stores blocked -> pure hint ack.
  sim.control({ type: 'partition', groups: [['D', 'E'], ['A', 'B', 'C']] });
  sim.external('E', { cmd: 'write', key: 'x', value: 'doomed' });
  sim.runUntil(2000);
  expect(acksAt(sim, 'E')).toHaveLength(1); // acked purely via D+E hints
  expect(detectLostAckedWrite(statesOf(sim), sim.deadNodes())).toBeNull(); // hints still alive
  sim.control({ type: 'kill', node: 'D' });
  sim.control({ type: 'kill', node: 'E' });
  sim.runSteps(2);
  const lost = detectLostAckedWrite(statesOf(sim), sim.deadNodes());
  expect(lost).not.toBeNull();
  expect(lost!.ack.key).toBe('x');
  expect(lost!.coordinator).toBe('E');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/modules/leaderless.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

```ts
// src/modules/leaderless.ts
import type { NodeId } from '../engine/events';
import type { Effect, InspectorTree, ModuleEvent, SimModule } from '../engine/module';

/**
 * Leaderless (Dynamo-style) quorum replication (DDIA Ch5). Home replicas for
 * every key are the first 3 nodes; the rest are sloppy fallbacks. Any node
 * can coordinate a client op. Writes fan out to home replicas and ack the
 * client at w replica acks; reads fan out and return the newest of r replies,
 * read-repairing stale responders. With sloppy=true, a write timeout re-sends
 * to fallbacks as hints — fallback acks count toward w (sloppy quorum), and
 * fallbacks retry handoff to the home replica until it acks.
 */
export type LLHistory =
  | { type: 'ack'; key: string; ts: number; time: number }
  | { type: 'failed-write'; key: string; time: number }
  | { type: 'read'; node: NodeId; key: string; returnedTs: number; time: number }
  | { type: 'read-repair'; key: string; to: NodeId; time: number };

interface PendingWrite {
  kind: 'write';
  key: string;
  value: string;
  ts: number;
  acks: NodeId[];
  hinted: boolean;
  done: boolean;
}
interface PendingRead {
  kind: 'read';
  key: string;
  replies: { from: NodeId; ts: number; value: string | null }[];
  done: boolean;
}

export interface LLState {
  self: NodeId;
  home: NodeId[];
  fallbacks: NodeId[];
  w: number;
  r: number;
  sloppy: boolean;
  data: Record<string, { value: string; ts: number }>;
  /** Fallback-held writes awaiting handoff, keyed `${target}:${key}`. */
  hintBuffer: Record<string, { key: string; value: string; ts: number; target: NodeId }>;
  pending: Record<number, PendingWrite | PendingRead>;
  nextOp: number;
  history: LLHistory[];
}

export type LLPayload =
  | { cmd: 'write'; key: string; value: string }
  | { cmd: 'read'; key: string }
  | { msg: 'store'; opId?: number; key: string; value: string; ts: number; handoffOf?: string }
  | { msg: 'storeAck'; opId?: number; key: string; ts: number; handoffOf?: string }
  | { msg: 'storeHint'; opId: number; key: string; value: string; ts: number; target: NodeId }
  | { msg: 'get'; opId: number; key: string }
  | { msg: 'getReply'; opId: number; key: string; ts: number; value: string | null }
  | { timer: 'op-timeout'; opId: number }
  | { timer: 'handoff' }
  | null;

const OP_TIMEOUT_MS = 200;
const HANDOFF_RETRY_MS = 100;

function applyLww(s: LLState, key: string, value: string, ts: number): LLState {
  const cur = s.data[key];
  if (cur && cur.ts >= ts) return s;
  return { ...s, data: { ...s.data, [key]: { value, ts } } };
}

export interface LostAckedWriteResult {
  ack: Extract<LLHistory, { type: 'ack' }>;
  coordinator: NodeId;
}

/**
 * An acked write whose (key, ts) exists on no ALIVE node — neither applied
 * data nor a pending hint. Sound without quiescence: an ack implies >= w nodes
 * applied or hinted the value before acking, so a live copy always exists
 * unless every holder died.
 */
export function detectLostAckedWrite(
  states: Map<NodeId, LLState>,
  deadNodes: NodeId[],
): LostAckedWriteResult | null {
  const dead = new Set(deadNodes);
  for (const [coordinator, s] of states) {
    for (const h of s.history) {
      if (h.type !== 'ack') continue;
      let alive = false;
      for (const [id, t] of states) {
        if (dead.has(id)) continue;
        if ((t.data[h.key]?.ts ?? -1) >= h.ts) alive = true;
        for (const hint of Object.values(t.hintBuffer)) {
          if (hint.key === h.key && hint.ts >= h.ts) alive = true;
        }
      }
      if (!alive) return { ack: h, coordinator };
    }
  }
  return null;
}

function handleClient(s: LLState, ev: ModuleEvent<LLPayload>): [LLState, Effect[]] {
  const p = ev.payload as Extract<LLPayload, { cmd: string }>;
  const opId = s.nextOp;
  if (p.cmd === 'write') {
    const ts = ev.time;
    const op: PendingWrite = { kind: 'write', key: p.key, value: p.value, ts, acks: [], hinted: false, done: false };
    const effects: Effect[] = s.home.map((n) => ({
      type: 'send',
      to: n,
      payload: { msg: 'store', opId, key: p.key, value: p.value, ts },
    }));
    effects.push({ type: 'timer', delay: OP_TIMEOUT_MS, payload: { timer: 'op-timeout', opId } });
    return [{ ...s, nextOp: opId + 1, pending: { ...s.pending, [opId]: op } }, effects];
  }
  const op: PendingRead = { kind: 'read', key: p.key, replies: [], done: false };
  const effects: Effect[] = s.home.map((n) => ({
    type: 'send',
    to: n,
    payload: { msg: 'get', opId, key: p.key },
  }));
  return [{ ...s, nextOp: opId + 1, pending: { ...s.pending, [opId]: op } }, effects];
}

function handleMessage(s: LLState, ev: ModuleEvent<LLPayload>): [LLState, Effect[]] {
  const p = ev.payload as Extract<LLPayload, { msg: string }>;
  const from = ev.from!;
  switch (p.msg) {
    case 'store': {
      const next = applyLww(s, p.key, p.value, p.ts);
      return [
        next,
        [{ type: 'send', to: from, payload: { msg: 'storeAck', opId: p.opId, key: p.key, ts: p.ts, handoffOf: p.handoffOf } }],
      ];
    }
    case 'storeHint': {
      const hintKey = `${p.target}:${p.key}`;
      const cur = s.hintBuffer[hintKey];
      const next: LLState =
        cur && cur.ts >= p.ts
          ? s
          : { ...s, hintBuffer: { ...s.hintBuffer, [hintKey]: { key: p.key, value: p.value, ts: p.ts, target: p.target } } };
      return [
        next,
        [
          { type: 'send', to: from, payload: { msg: 'storeAck', opId: p.opId, key: p.key, ts: p.ts } },
          { type: 'timer', delay: HANDOFF_RETRY_MS, payload: { timer: 'handoff' } },
        ],
      ];
    }
    case 'storeAck': {
      // Handoff confirmation: clear the delivered hint.
      if (p.handoffOf !== undefined) {
        if (!s.hintBuffer[p.handoffOf]) return [s, []];
        const hintBuffer = { ...s.hintBuffer };
        delete hintBuffer[p.handoffOf];
        return [{ ...s, hintBuffer }, []];
      }
      if (p.opId === undefined) return [s, []]; // read-repair ack — nothing to track
      const op = s.pending[p.opId];
      if (!op || op.kind !== 'write' || op.done) return [s, []];
      if (op.acks.includes(from)) return [s, []]; // duplicate
      const acks = [...op.acks, from];
      if (acks.length < s.w) {
        return [{ ...s, pending: { ...s.pending, [p.opId]: { ...op, acks } } }, []];
      }
      return [
        {
          ...s,
          pending: { ...s.pending, [p.opId]: { ...op, acks, done: true } },
          history: [...s.history, { type: 'ack', key: op.key, ts: op.ts, time: ev.time }],
        },
        [],
      ];
    }
    case 'get': {
      const cur = s.data[p.key];
      return [
        s,
        [
          {
            type: 'send',
            to: from,
            payload: { msg: 'getReply', opId: p.opId, key: p.key, ts: cur?.ts ?? 0, value: cur?.value ?? null },
          },
        ],
      ];
    }
    case 'getReply': {
      const op = s.pending[p.opId];
      if (!op || op.kind !== 'read' || op.done) return [s, []];
      if (op.replies.some((x) => x.from === from)) return [s, []];
      const replies = [...op.replies, { from, ts: p.ts, value: p.value }];
      if (replies.length < s.r) {
        return [{ ...s, pending: { ...s.pending, [p.opId]: { ...op, replies } } }, []];
      }
      const newest = replies.reduce((a, b) => (b.ts > a.ts ? b : a));
      let next: LLState = {
        ...s,
        pending: { ...s.pending, [p.opId]: { ...op, replies, done: true } },
        history: [
          ...s.history,
          { type: 'read', node: s.self, key: op.key, returnedTs: newest.ts, time: ev.time },
        ],
      };
      const effects: Effect[] = [];
      if (newest.value !== null) {
        for (const rep of replies) {
          if (rep.ts < newest.ts) {
            effects.push({
              type: 'send',
              to: rep.from,
              payload: { msg: 'store', key: op.key, value: newest.value, ts: newest.ts },
            });
            next = { ...next, history: [...next.history, { type: 'read-repair', key: op.key, to: rep.from, time: ev.time }] };
          }
        }
      }
      return [next, effects];
    }
  }
}

function handleTimer(s: LLState, ev: ModuleEvent<LLPayload>): [LLState, Effect[]] {
  const p = ev.payload as Extract<LLPayload, { timer: string }>;
  if (p.timer === 'handoff') {
    const hints = Object.entries(s.hintBuffer);
    if (hints.length === 0) return [s, []];
    const effects: Effect[] = hints.map(([hintKey, h]) => ({
      type: 'send',
      to: h.target,
      payload: { msg: 'store', key: h.key, value: h.value, ts: h.ts, handoffOf: hintKey },
    }));
    effects.push({ type: 'timer', delay: HANDOFF_RETRY_MS, payload: { timer: 'handoff' } });
    return [s, effects];
  }
  // op-timeout
  const op = s.pending[p.opId];
  if (!op || op.kind !== 'write' || op.done) return [s, []];
  if (!s.sloppy || op.hinted) {
    return [
      {
        ...s,
        pending: { ...s.pending, [p.opId]: { ...op, done: true } },
        history: [...s.history, { type: 'failed-write', key: op.key, time: ev.time }],
      },
      [],
    ];
  }
  // Sloppy: hint the missing home replicas onto the fallbacks, then one final timeout.
  const missing = s.home.filter((n) => !op.acks.includes(n));
  const effects: Effect[] = missing.slice(0, s.fallbacks.length).map((target, i) => ({
    type: 'send',
    to: s.fallbacks[i],
    payload: { msg: 'storeHint', opId: p.opId, key: op.key, value: op.value, ts: op.ts, target },
  }));
  effects.push({ type: 'timer', delay: OP_TIMEOUT_MS, payload: { timer: 'op-timeout', opId: p.opId } });
  return [{ ...s, pending: { ...s.pending, [p.opId]: { ...op, hinted: true } } }, effects];
}

export const leaderless: SimModule<LLState, LLPayload> = {
  id: 'leaderless-quorum',
  chaos: ['kill-node', 'partition', 'delay', 'drop', 'duplicate'],

  init(nodeId, config) {
    const home = config.nodeIds.slice(0, 3);
    const fallbacks = config.nodeIds.slice(3);
    const params = (config.params ?? {}) as { w?: number; r?: number; sloppy?: boolean };
    return {
      self: nodeId,
      home,
      fallbacks,
      w: params.w ?? 2,
      r: params.r ?? 2,
      sloppy: params.sloppy ?? false,
      data: {},
      hintBuffer: {},
      pending: {},
      nextOp: 1,
      history: [],
    };
  },

  reduce(state, event): [LLState, Effect[]] {
    const p = event.payload;
    if (event.kind === 'external' && p && 'cmd' in p) return handleClient(state, event);
    if (event.kind === 'message' && p && 'msg' in p) return handleMessage(state, event);
    if (event.kind === 'timer' && p && 'timer' in p) return handleTimer(state, event);
    return [state, []];
  },

  metrics(states) {
    let acked = 0;
    let failed = 0;
    let repairs = 0;
    let hints = 0;
    for (const s of states.values()) {
      hints += Object.keys(s.hintBuffer).length;
      for (const h of s.history) {
        if (h.type === 'ack') acked++;
        else if (h.type === 'failed-write') failed++;
        else if (h.type === 'read-repair') repairs++;
      }
    }
    return [
      { name: 'acked-writes', value: acked },
      { name: 'failed-writes', value: failed },
      { name: 'read-repairs', value: repairs },
      { name: 'hints-outstanding', value: hints },
    ];
  },

  inspect(state) {
    return {
      role: state.fallbacks.includes(state.self) ? 'fallback' : 'home',
      data: state.data,
      hints: Object.keys(state.hintBuffer).length,
      pendingOps: Object.values(state.pending).filter((o) => !o.done).length,
    } as InspectorTree;
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/modules/leaderless.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Full suite, gates, commit**

Run: `npm test && npm run lint && npm run typecheck && npm run coverage`
Expected: all green; coverage holds.

```bash
git add src/modules/leaderless.ts src/modules/leaderless.test.ts
git commit -m "feat(modules): leaderless quorum with read repair, sloppy quorum, hinted handoff"
```

---

### Task 6: Leaderless property tests

**Files:**
- Create: `src/modules/leaderless.property.test.ts`

**Interfaces:**
- Consumes: `leaderless`, `detectLostAckedWrite`, `LLState`, `LLPayload` (Task 5).

- [ ] **Step 1: Write the properties**

```ts
// src/modules/leaderless.property.test.ts
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { Simulation, type NodeId } from '../engine';
import { detectLostAckedWrite, leaderless, type LLPayload, type LLState } from './leaderless';

const NODES = ['A', 'B', 'C', 'D', 'E'];
const KEYS = ['a', 'b'];

interface Op {
  kind: 'write' | 'read';
  key: string;
  coordinator: string;
}

const opArb: fc.Arbitrary<Op> = fc.record({
  kind: fc.constantFrom<'write' | 'read'>('write', 'read'),
  key: fc.constantFrom(...KEYS),
  coordinator: fc.constantFrom(...NODES),
});

function makeSim(seed: number, params: { w: number; r: number; sloppy: boolean }) {
  return new Simulation<LLState, LLPayload>({
    module: leaderless,
    config: { nodeIds: NODES, params },
    seed,
    network: { latency: [1, 40] },
  });
}

test('property: w+r>n, sequential ops, no chaos — every read returns the latest acked value', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 2 ** 30 }),
      fc.constantFrom<[number, number]>([2, 2], [3, 2], [2, 3], [3, 3], [1, 3], [3, 1]),
      fc.array(opArb, { minLength: 2, maxLength: 12 }),
      (seed, [w, r], ops) => {
        const sim = makeSim(seed, { w, r, sloppy: false });
        sim.runSteps(5);
        const lastAckedTs: Record<string, number> = {};
        let t = 0;
        for (const op of ops) {
          const before = countAcks(sim);
          sim.external(op.coordinator, op.kind === 'write' ? { cmd: 'write', key: op.key, value: `v${t}` } : { cmd: 'read', key: op.key });
          t += 1000;
          sim.runUntil(t); // sequential: quiesce between ops
          if (op.kind === 'write' && countAcks(sim) > before) {
            const acks = allAcks(sim).filter((a) => a.key === op.key);
            lastAckedTs[op.key] = Math.max(...acks.map((a) => a.ts));
          }
          if (op.kind === 'read') {
            const reads = sim.getState(op.coordinator).history.filter((h) => h.type === 'read');
            const latest = reads[reads.length - 1];
            if (latest && lastAckedTs[op.key] !== undefined) {
              expect(latest.returnedTs).toBeGreaterThanOrEqual(lastAckedTs[op.key]);
            }
          }
        }
      },
    ),
    { numRuns: 50 },
  );

  function allAcks(sim: Simulation<LLState, LLPayload>) {
    return NODES.flatMap((id) =>
      sim.getState(id).history.filter((h): h is Extract<LLState['history'][number], { type: 'ack' }> => h.type === 'ack'),
    );
  }
  function countAcks(sim: Simulation<LLState, LLPayload>) {
    return allAcks(sim).length;
  }
});

test('property: detectLostAckedWrite never fires without kills or partitions', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 2 ** 30 }),
      fc.boolean(),
      fc.array(opArb, { minLength: 1, maxLength: 12 }),
      (seed, sloppy, ops) => {
        const sim = makeSim(seed, { w: 2, r: 2, sloppy });
        sim.runSteps(5);
        let t = 0;
        for (const op of ops) {
          t += 50;
          sim.runUntil(t);
          sim.external(
            op.coordinator,
            op.kind === 'write' ? { cmd: 'write', key: op.key, value: `v${t}` } : { cmd: 'read', key: op.key },
          );
        }
        sim.runUntil(t + 3000);
        const states = new Map<NodeId, LLState>(NODES.map((id) => [id, sim.getState(id)] as const));
        expect(detectLostAckedWrite(states, sim.deadNodes())).toBeNull();
      },
    ),
    { numRuns: 50 },
  );
});
```

- [ ] **Step 2: Run, then full suite**

Run: `npx vitest run src/modules/leaderless.property.test.ts && npm test`
Expected: PASS (2 properties × 50 runs); full suite green.

- [ ] **Step 3: Commit**

```bash
git add src/modules/leaderless.property.test.ts
git commit -m "test(modules): leaderless properties — quorum overlap reads, loss-detector soundness"
```

---

### Task 7: LeaderlessLab page + sloppy-loss challenge + catalog 5.3

**Files:**
- Create: `src/ui/labs/leaderless/LeaderlessLab.tsx`
- Modify: `src/ui/shell/catalog.ts` (add 5.3 active), `src/ui/App.tsx` (PAGES entry)

**Interfaces:**
- Consumes: kit + bridge, `leaderless` + `detectLostAckedWrite` (Task 5).
- Produces: `LeaderlessLab()` registered as PAGES `'5.3'`.

- [ ] **Step 1: Implement the lab page**

```tsx
// src/ui/labs/leaderless/LeaderlessLab.tsx
import { useEffect, useRef, useState } from 'react';
import { Simulation, type NodeId } from '../../../engine';
import {
  detectLostAckedWrite,
  leaderless,
  type LLPayload,
  type LLState,
} from '../../../modules/leaderless';
import { SimDriver } from '../../bridge/SimDriver';
import { useSimStore } from '../../bridge/simStore';
import { ChaosToolbar } from '../../kit/ChaosToolbar';
import { ChallengePanel } from '../../kit/ChallengePanel';
import { ClusterView } from '../../kit/ClusterView';
import { KVControls } from '../../kit/KVControls';
import { MetricsPanel } from '../../kit/MetricsPanel';
import { TimelineScrubber } from '../../kit/TimelineScrubber';
import { btn, inputBox } from '../../kit/classes';

const NODE_IDS = ['A', 'B', 'C', 'D', 'E'];

export function LeaderlessLab() {
  const [w, setW] = useState(2);
  const [r, setR] = useState(2);
  const [sloppy, setSloppy] = useState(false);
  const [coordinator, setCoordinator] = useState<NodeId>('A');
  const [epoch, setEpoch] = useState(0);
  const ref = useRef<{ driver: SimDriver<LLState, LLPayload>; key: string } | null>(null);
  const simKey = `${w}:${r}:${sloppy}:${epoch}`;
  if (!ref.current || ref.current.key !== simKey) {
    ref.current?.driver.pause();
    useSimStore.getState().reset();
    const seed = 3000 + epoch;
    const sim = new Simulation<LLState, LLPayload>({
      module: leaderless,
      config: { nodeIds: NODE_IDS, params: { w, r, sloppy } },
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

  const statesOf = () =>
    new Map<NodeId, LLState>(
      driver.sim.config.nodeIds.map((id) => [id, driver.sim.getState(id)] as const),
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-xs font-mono">
        <span>home replicas: A B C · fallbacks: D E · n=3</span>
        <label className="flex items-center gap-1">
          w
          <input type="range" min={1} max={3} value={w} onChange={(e) => setW(Number(e.target.value))} />
          {w}
        </label>
        <label className="flex items-center gap-1">
          r
          <input type="range" min={1} max={3} value={r} onChange={(e) => setR(Number(e.target.value))} />
          {r}
        </label>
        <span className={w + r > 3 ? 'text-set' : 'text-sign'}>
          w+r{w + r > 3 ? '>' : '≤'}n {w + r > 3 ? '(overlap guaranteed)' : '(stale reads possible)'}
        </span>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={sloppy} onChange={(e) => setSloppy(e.target.checked)} />
          sloppy quorum
        </label>
        <label className="flex items-center gap-1">
          coordinator
          <select className={inputBox} value={coordinator} onChange={(e) => setCoordinator(e.target.value)}>
            {NODE_IDS.map((id) => (
              <option key={id}>{id}</option>
            ))}
          </select>
        </label>
        <button className={btn} onClick={() => setEpoch((e) => e + 1)}>
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
      <KVControls
        writeTargets={[coordinator]}
        readTargets={[coordinator]}
        onWrite={(node, key, value) => driver.external(node, { cmd: 'write', key, value })}
        onRead={(node, key) => driver.external(node, { cmd: 'read', key })}
      />
      <ChaosToolbar
        caps={leaderless.chaos}
        nodeIds={NODE_IDS}
        deadNodes={view.nodes.filter((n) => n.dead).map((n) => n.id)}
        onAction={(a) => driver.control(a)}
      />
      <ChallengePanel
        title="Chaos Challenge: sloppy quorum loses an acked write"
        storageKeyPrefix="ddia:ch05:sloppy-loss"
        prompt="Predict first: how does a sloppy-quorum ack lose data? (skippable)"
        runningHint="get a write acked through hints, then destroy every copy before handoff."
        check={() => detectLostAckedWrite(statesOf(), driver.sim.deadNodes())}
        onWin={() => driver.pause()}
        renderWin={(win, prediction) => (
          <>
            <p>
              write <code className="text-warn">{win.ack.key}</code> was acked at {win.coordinator}{' '}
              (t={win.ack.time}) — but every node holding it is dead. The sloppy quorum promised
              durability it could not keep.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />
    </div>
  );
}
```

- [ ] **Step 2: Register catalog entry and page**

In `src/ui/shell/catalog.ts`, replace the `ch5` chapter entry with:

```ts
  {
    id: 'ch5',
    title: 'Ch.5 — Replication',
    labs: [
      { id: '5.1', label: 'Replication Theater', status: 'active' },
      { id: '5.2', label: 'Multi-Leader Conflicts', status: 'active' },
      { id: '5.3', label: 'Leaderless Quorum', status: 'active' },
      { id: '5.d', label: 'Debrief & Journal', status: 'active' },
    ],
  },
```

In `src/ui/App.tsx`: add the import and a PAGES entry after `'5.2'`:

```tsx
import { LeaderlessLab } from './labs/leaderless/LeaderlessLab';
```

```tsx
  '5.3': {
    eyebrow: 'Chapter 5 — Replication',
    title: 'Leaderless: Quorum Reads & Writes',
    thesis:
      'No leader — any node coordinates. Writes succeed at w of 3 home replicas, reads consult r; w+r>n guarantees overlap. Sloppy quorum trades that guarantee for availability: hints on fallback nodes count toward w, and a hint that dies before handoff takes an acknowledged write with it.',
    Component: LeaderlessLab,
  },
```

- [ ] **Step 3: Gates + manual smoke**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: all green.
Manual (`npm run dev`): w+r indicator flips teal/coral with sliders; strict write against a partition fails (failed-writes metric); sloppy same scenario acks + hints-outstanding rises; the canonical challenge script (partition D,E | A,B,C → write @ E → kill D → kill E) wins.

- [ ] **Step 4: Commit + push (deploys 5.3)**

```bash
git add src/ui
git commit -m "feat(ui): leaderless quorum lab with sloppy-loss chaos challenge (5.3)"
git push
```

---

### Task 8: Debrief extension, DESIGN_PLAN note, deploy verification

**Files:**
- Modify: `content/ch05/debrief.mdx`, `docs/DESIGN_PLAN.en.md` (§7 Phase 1 line)

**Interfaces:** none — docs + verification.

- [ ] **Step 1: Extend the debrief**

Append to `content/ch05/debrief.mdx`:

```mdx
## Multi-leader: conflicts have no right answer

Two leaders both acked your writes, then LWW picked one and **silently deleted
the other** — the discard record in the lab is the only witness. LWW is what
Cassandra does by default; the alternative (version vectors + application-level
merge, Dynamo-style) surfaces the conflict instead of hiding it. Note the lab's
timestamps are Lamport-bumped (`ts = max(now, seen+1)`) — with real wall clocks
and skew, LWW gets worse, not better.

## Leaderless: quorum math

With n=3, **w + r > n guarantees read/write overlap** — some replica in your
read set saw the newest write. w=r=2 tolerates one dead replica for both reads
and writes. Drop to w+r ≤ n and the lab's stale reads return. **Sloppy quorum**
keeps accepting writes when home replicas are unreachable by hinting them onto
fallback nodes — availability bought with durability risk: you proved an acked
write can vanish when the hint-holders die before handoff. That is exactly the
Riak/Dynamo trade-off `sloppy_quorum=true` makes.
```

- [ ] **Step 2: Mark Ch5 complete in the design plan**

In `docs/DESIGN_PLAN.en.md` §7, change the Phase 1 line's ending from:

```md
Shipping this slice validates the entire concept.
```

to:

```md
Shipping this slice validates the entire concept. *(v1.2 note: shipped 2026-07-10 — leader-follower slice first, then the multi-leader and leaderless follow-up labs; Ch5 complete.)*
```

- [ ] **Step 3: Full gates, commit, push**

Run: `npm test && npm run coverage && npm run typecheck && npm run lint && npm run build`
Expected: all green.

```bash
git add content/ch05/debrief.mdx docs/DESIGN_PLAN.en.md
git commit -m "docs: ch05 debrief covers LWW conflicts + quorum math; mark Ch5 complete"
git push
```

- [ ] **Step 4: Verify deploy (spec DoD)**

```bash
gh run watch --exit-status $(gh run list --limit 1 --json databaseId --jq '.[0].databaseId')
curl -s -o /dev/null -w "%{http_code}" https://jonathn1001.github.io/ddia-visualized/
```

Expected: both CI jobs green; HTTP 200. Open the site: 5.2 and 5.3 active in the sidebar, both challenges winnable, debrief shows the new sections.

---

## Self-Review (done at authoring time)

- **Spec coverage:** kit refactor → Task 1; multileader module/verifier/metrics → Task 2; leaderless module/verifier/metrics → Task 5; 4 properties → Tasks 3+6; labs/challenges/catalog → Tasks 4+7; debrief + doc note + deploy DoD → Task 8. Out-of-scope items (version vectors, anti-entropy, dynamic n, ring) appear in no task. ✓
- **Placeholder scan:** none; every code step is complete.
- **Type consistency:** `ChallengePanel<R>` props, `KVControls` signature, `MLState`/`MLPayload`/`detectLostWrite`, `LLState`/`LLPayload`/`detectLostAckedWrite(states, deadNodes)` cross-checked across Tasks 1–7. `sim.deadNodes()` exists (engine, Phase 1 Task 2). ✓
