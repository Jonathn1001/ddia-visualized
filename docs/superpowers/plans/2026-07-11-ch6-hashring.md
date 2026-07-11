# Ch6.1 Consistent Hashing Ring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship DDIA Ch6 (Partitioning) as one interactive lab — a consistent-hash ring with virtual nodes where the learner puts keys, adds/removes nodes, watches keys migrate, and wins an engine-verified "create a hotspot" challenge.

**Architecture:** New pure `SimModule` (`hashring.ts`) with Dynamo-faithful routing — any node coordinates; membership changes broadcast a new ring view and re-home keys via handoff messages. New `RingView` SVG kit component (recolor-on-migration, no key-hop animation). Lab page follows the PR #2 driver-in-effect pattern. Zero engine changes.

**Tech Stack:** TypeScript, React 19, Vite, vitest + fast-check, zustand store bridge, existing sim engine (`src/engine/`).

**Spec:** `docs/superpowers/specs/2026-07-11-ch6-consistent-hashing-design.md` (approved). RingView migration visual = **recolor-only** (user decision).

## Global Constraints

- `src/modules/**` stays pure: no React/DOM imports, no `Math.random`/`Date.now`; all placement from the engine's `fnv1a`; state plain JSON. (ESLint-enforced — see `eslint.config.js`.)
- Zero engine changes — reuse `fnv1a`, SimModule contract v0.2, chaos, bridge as-is.
- Theme tokens only in UI (`ink/panel/line/dim/fg/set/sign/warn`); no hardcoded slate/sky Tailwind classes. (A hex node-color palette constant is allowed — `MetricsPanel.tsx` sets the precedent.)
- localStorage scheme `<prefix>:attempt` / `<prefix>:prediction:<n>`; challenge prefix `ddia:ch06:hotspot`; journal key `ddia:ch06:journal`.
- Coverage ≥ 80% (lines/functions/branches/statements) on `src/engine/**` + `src/modules/**` (`vitest.config.ts` thresholds).
- Bundle < 500 KB gzip.
- Conventional commits; every task leaves a deployable state (typecheck + full suite green before each commit).
- Branch: `feat/ch6-hashring` in an isolated worktree (superpowers:using-git-worktrees at execution start).

## File Structure

| File | Responsibility |
|---|---|
| Create `src/modules/hashring.ts` | Pure ring math + SimModule (routing, membership, handoff, verifier, metrics) |
| Create `src/modules/hashring.test.ts` | Unit tests: ring math, routing, membership, verifier |
| Create `src/modules/hashring.property.test.ts` | Property tests: single-owner, minimal migration, key conservation |
| Create `src/ui/kit/RingView.tsx` | SVG ring: vnode ticks, key dots, per-node load bars |
| Create `src/ui/kit/RingView.test.tsx` | Render test |
| Create `src/ui/labs/hashring/HashRingLab.tsx` | Lab page: controls, readout, challenge |
| Create `src/ui/labs/hashring/Debrief.tsx` | Ch6 debrief page |
| Create `src/ui/kit/DebriefArticle.tsx` | Shared debrief article wrapper (extracted from ch5 Debrief) |
| Create `content/ch06/debrief.mdx` | Debrief copy: minimal migration, vnodes, hot-key limit |
| Modify `src/ui/kit/SurpriseJournal.tsx` | Add `storageKey` prop (default keeps ch5 key) |
| Modify `src/ui/labs/replication/Debrief.tsx` | Use `DebriefArticle` |
| Modify `src/ui/shell/catalog.ts` | Flip `6.1` active; add `6.d` debrief entry |
| Modify `src/ui/App.tsx` | PAGES `'6.1'` + `'6.d'` |
| Modify `src/ui/App.test.tsx` | Sidebar-nav smoke test for 6.1 |

Module tasks (1–4) grow `hashring.ts` sequentially — same file, strictly ordered.

---

### Task 1: Ring math helpers

**Files:**
- Create: `src/modules/hashring.ts`
- Test: `src/modules/hashring.test.ts`

**Interfaces:**
- Consumes: `fnv1a` from `../engine/hash`, `NodeId` from `../engine/events`.
- Produces (later tasks + UI rely on these exact signatures):
  - `interface RingVnode { pos: number; node: NodeId }`
  - `buildRing(members: NodeId[], vnodes: number): RingVnode[]` — sorted clockwise
  - `keyPos(key: string): number`
  - `ownerOf(ring: RingVnode[], key: string): NodeId` — precondition: ring non-empty
  - `ringOwner(key: string, members: NodeId[], vnodes: number): NodeId`
  - `modNOwner(key: string, members: NodeId[]): NodeId`
  - `modNMovedCount(keys: string[], from: NodeId[], to: NodeId[]): number`

- [ ] **Step 1: Write the failing tests**

```ts
// src/modules/hashring.test.ts
import { describe, expect, test } from 'vitest';
import { fnv1a } from '../engine/hash';
import {
  buildRing,
  keyPos,
  modNMovedCount,
  modNOwner,
  ownerOf,
  ringOwner,
} from './hashring';

describe('ring math', () => {
  test('buildRing: members × vnodes entries, sorted by position', () => {
    const ring = buildRing(['A', 'B', 'C'], 4);
    expect(ring).toHaveLength(12);
    for (let i = 1; i < ring.length; i++) expect(ring[i].pos).toBeGreaterThanOrEqual(ring[i - 1].pos);
    expect(ring.filter((v) => v.node === 'A')).toHaveLength(4);
  });

  test('vnode positions derive from fnv1a of `${node}#${i}`', () => {
    const ring = buildRing(['A'], 2);
    expect(ring.map((v) => v.pos).sort((a, b) => a - b)).toEqual(
      [fnv1a('A#0'), fnv1a('A#1')].sort((a, b) => a - b),
    );
  });

  test('ownerOf: first vnode clockwise from the key, wrapping at 2^32', () => {
    const ring = buildRing(['A', 'B', 'C'], 1);
    const key = 'wrap-probe';
    const pos = keyPos(key);
    const successor = ring.find((v) => v.pos >= pos) ?? ring[0];
    expect(ownerOf(ring, key)).toBe(successor.node);
    // wrap case: a key positioned past the last vnode maps to ring[0]
    const last = ring[ring.length - 1];
    for (let i = 0; i < 5000; i++) {
      const k = `w${i}`;
      if (keyPos(k) > last.pos) {
        expect(ownerOf(ring, k)).toBe(ring[0].node);
        return;
      }
    }
    throw new Error('no wrap-around key found in 5000 candidates — widen the search');
  });

  test('ringOwner is deterministic and always a member', () => {
    for (const k of ['x', 'y', 'k42']) {
      const owner = ringOwner(k, ['A', 'B', 'C', 'D'], 3);
      expect(ringOwner(k, ['A', 'B', 'C', 'D'], 3)).toBe(owner);
      expect(['A', 'B', 'C', 'D']).toContain(owner);
    }
  });

  test('modNOwner: sorted-members index by fnv1a(key) % N', () => {
    const members = ['A', 'B', 'C'];
    expect(modNOwner('k1', members)).toBe(members[fnv1a('k1') % 3]);
  });

  test('consistent hashing moves fewer keys than mod-N on a membership change', () => {
    const keys = Array.from({ length: 100 }, (_, i) => `k${i}`);
    const from = ['A', 'B', 'C', 'D'];
    const to = ['A', 'B', 'C', 'D', 'E'];
    const ringMoved = keys.filter((k) => ringOwner(k, from, 4) !== ringOwner(k, to, 4)).length;
    const modMoved = modNMovedCount(keys, from, to);
    expect(ringMoved).toBeGreaterThan(0);
    expect(ringMoved).toBeLessThan(modMoved);
    // every ring-moved key lands on the added node
    for (const k of keys) {
      const now = ringOwner(k, to, 4);
      if (now !== ringOwner(k, from, 4)) expect(now).toBe('E');
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/modules/hashring.test.ts`
Expected: FAIL — `Cannot find module './hashring'` (file does not exist yet).

- [ ] **Step 3: Implement the ring math**

```ts
// src/modules/hashring.ts
import type { NodeId } from '../engine/events';
import { fnv1a } from '../engine/hash';

/**
 * Consistent-hash ring with virtual nodes (DDIA Ch6). Positions come from the
 * engine's fnv1a — pure and deterministic; no RNG, no wall clock.
 */
export interface RingVnode {
  pos: number;
  node: NodeId;
}

/** All vnode positions for a membership, sorted clockwise. Ties break by node id. */
export function buildRing(members: NodeId[], vnodes: number): RingVnode[] {
  const ring: RingVnode[] = [];
  for (const node of members)
    for (let i = 0; i < vnodes; i++) ring.push({ pos: fnv1a(`${node}#${i}`), node });
  ring.sort((a, b) => a.pos - b.pos || (a.node < b.node ? -1 : 1));
  return ring;
}

export function keyPos(key: string): number {
  return fnv1a(key);
}

/** Owner = first vnode clockwise from the key's position, wrapping at 2^32. Ring must be non-empty. */
export function ownerOf(ring: RingVnode[], key: string): NodeId {
  const pos = keyPos(key);
  for (const v of ring) if (v.pos >= pos) return v.node;
  return ring[0].node;
}

export function ringOwner(key: string, members: NodeId[], vnodes: number): NodeId {
  return ownerOf(buildRing(members, vnodes), key);
}

/** The naive `hash mod N` scheme the headline readout compares against. Members must be sorted. */
export function modNOwner(key: string, members: NodeId[]): NodeId {
  return members[keyPos(key) % members.length];
}

/** How many of `keys` a mod-N scheme would re-home going from one membership to another. */
export function modNMovedCount(keys: string[], from: NodeId[], to: NodeId[]): number {
  let n = 0;
  for (const k of keys) if (modNOwner(k, from) !== modNOwner(k, to)) n++;
  return n;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/modules/hashring.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/modules/hashring.ts src/modules/hashring.test.ts
git commit -m "feat(modules): consistent-hash ring math (vnodes, successor lookup, mod-N compare)"
```

---

### Task 2: Module skeleton + put routing

**Files:**
- Modify: `src/modules/hashring.ts` (append)
- Test: `src/modules/hashring.test.ts` (append)

**Interfaces:**
- Consumes: Task 1 helpers; `SimModule`, `Effect`, `ModuleEvent`, `InspectorTree` from `../engine/module`; `Simulation` from `../engine` (tests only).
- Produces:
  - `interface HRState { self: NodeId; pool: NodeId[]; members: NodeId[]; changeSeq: number; vnodes: number; keys: string[]; moved: number; movedInChange: number }`
  - `type HRPayload = { cmd: 'put'; key: string } | { cmd: 'addNode'; node: NodeId } | { cmd: 'removeNode'; node: NodeId } | { msg: 'store'; key: string } | { msg: 'handoff'; keys: string[] } | { msg: 'membership'; members: NodeId[]; seq: number } | null`
  - `export const hashring: SimModule<HRState, HRPayload>` with `id: 'hash-ring'`, `chaos: ['kill-node', 'partition', 'delay', 'drop', 'duplicate']`
  - `init` params: `{ vnodes?: number; initialMembers?: number }` — defaults `vnodes: 2`, `initialMembers: 3`; `pool` = sorted `config.nodeIds`; `members` = first `initialMembers` of pool.
  - `interface HRInspect { inRing: boolean; keys: string[]; members: NodeId[]; changeSeq: number; moved: number }` — the exact shape `inspect()` returns (UI casts `NodeView.inspect` to this).

- [ ] **Step 1: Write the failing tests**

Append to `src/modules/hashring.test.ts`:

```ts
import { Simulation, type NodeId } from '../engine';
import { hashring, type HRPayload, type HRState } from './hashring';

const POOL = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

function makeSim(seed: number, params: { vnodes?: number; initialMembers?: number } = {}) {
  return new Simulation<HRState, HRPayload>({
    module: hashring,
    config: { nodeIds: POOL, params },
    seed,
    network: { latency: [1, 40] },
  });
}

function statesOf(sim: Simulation<HRState, HRPayload>): Map<NodeId, HRState> {
  return new Map(POOL.map((id) => [id, sim.getState(id)] as const));
}

describe('put routing', () => {
  test('init: members = first 3 of sorted pool, empty keys', () => {
    const sim = makeSim(1);
    sim.runSteps(POOL.length);
    const s = sim.getState('A');
    expect(s.members).toEqual(['A', 'B', 'C']);
    expect(s.keys).toEqual([]);
    expect(s.vnodes).toBe(2);
  });

  test('put stores the key at its ring owner, nowhere else', () => {
    const sim = makeSim(2);
    sim.runSteps(POOL.length);
    sim.external('A', { cmd: 'put', key: 'k1' });
    sim.runUntil(1000);
    const owner = ringOwner('k1', ['A', 'B', 'C'], 2);
    for (const id of POOL) {
      expect(sim.getState(id).keys.includes('k1')).toBe(id === owner);
    }
  });

  test('coordinating from an out-of-ring pool node still routes to a member', () => {
    const sim = makeSim(3);
    sim.runSteps(POOL.length);
    sim.external('H', { cmd: 'put', key: 'k2' }); // H is not a member
    sim.runUntil(1000);
    const owner = ringOwner('k2', ['A', 'B', 'C'], 2);
    expect(sim.getState(owner).keys).toContain('k2');
  });

  test('duplicate put of the same key stores it once', () => {
    const sim = makeSim(4);
    sim.runSteps(POOL.length);
    sim.external('A', { cmd: 'put', key: 'k3' });
    sim.external('B', { cmd: 'put', key: 'k3' });
    sim.runUntil(1000);
    const total = POOL.reduce((n, id) => n + sim.getState(id).keys.filter((k) => k === 'k3').length, 0);
    expect(total).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/modules/hashring.test.ts`
Expected: FAIL — `hashring` / `HRState` not exported.

- [ ] **Step 3: Implement state, payload, put routing, module object**

Append to `src/modules/hashring.ts` (also add to the top imports: `import type { Effect, InspectorTree, ModuleEvent, SimModule } from '../engine/module';`):

```ts
export interface HRState {
  self: NodeId;
  pool: NodeId[];
  /** Current ring membership — sorted; a shared view updated by membership broadcasts. */
  members: NodeId[];
  changeSeq: number;
  vnodes: number;
  /** Keys this node stores. */
  keys: string[];
  /** Cumulative keys this node has handed off over the session. */
  moved: number;
  /** Keys this node handed off during changeSeq (resets each change). */
  movedInChange: number;
}

export type HRPayload =
  | { cmd: 'put'; key: string }
  | { cmd: 'addNode'; node: NodeId }
  | { cmd: 'removeNode'; node: NodeId }
  | { msg: 'store'; key: string }
  | { msg: 'handoff'; keys: string[] }
  | { msg: 'membership'; members: NodeId[]; seq: number }
  | null;

/** The exact shape inspect() publishes — the lab casts NodeView.inspect to this. */
export interface HRInspect {
  inRing: boolean;
  keys: string[];
  members: NodeId[];
  changeSeq: number;
  moved: number;
}

function storeKey(s: HRState, key: string): HRState {
  return s.keys.includes(key) ? s : { ...s, keys: [...s.keys, key] };
}

function handleClient(s: HRState, ev: ModuleEvent<HRPayload>): [HRState, Effect[]] {
  const p = ev.payload as Extract<HRPayload, { cmd: string }>;
  if (p.cmd === 'put') {
    const owner = ringOwner(p.key, s.members, s.vnodes);
    if (owner === s.self) return [storeKey(s, p.key), []];
    return [s, [{ type: 'send', to: owner, payload: { msg: 'store', key: p.key } }]];
  }
  return [s, []]; // addNode/removeNode arrive in Task 3
}

function handleMessage(s: HRState, ev: ModuleEvent<HRPayload>): [HRState, Effect[]] {
  const p = ev.payload as Extract<HRPayload, { msg: string }>;
  switch (p.msg) {
    case 'store':
      return [storeKey(s, p.key), []];
    case 'handoff':
      return [p.keys.reduce(storeKey, s), []];
    case 'membership':
      return [s, []]; // Task 3
  }
}

export const hashring: SimModule<HRState, HRPayload> = {
  id: 'hash-ring',
  chaos: ['kill-node', 'partition', 'delay', 'drop', 'duplicate'],

  init(nodeId, config) {
    const pool = [...config.nodeIds].sort();
    const params = (config.params ?? {}) as { vnodes?: number; initialMembers?: number };
    return {
      self: nodeId,
      pool,
      members: pool.slice(0, params.initialMembers ?? 3),
      changeSeq: 0,
      vnodes: params.vnodes ?? 2,
      keys: [],
      moved: 0,
      movedInChange: 0,
    };
  },

  reduce(state, event): [HRState, Effect[]] {
    const p = event.payload;
    if (event.kind === 'external' && p && 'cmd' in p) return handleClient(state, event);
    if (event.kind === 'message' && p && 'msg' in p) return handleMessage(state, event);
    return [state, []];
  },

  metrics() {
    return []; // Task 4
  },

  inspect(state) {
    return {
      inRing: state.members.includes(state.self),
      keys: state.keys,
      members: state.members,
      changeSeq: state.changeSeq,
      moved: state.moved,
    } satisfies HRInspect as unknown as InspectorTree;
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/modules/hashring.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/modules/hashring.ts src/modules/hashring.test.ts
git commit -m "feat(modules): hash-ring module skeleton with Dynamo-faithful put routing"
```

---

### Task 3: Membership changes + key handoff

**Files:**
- Modify: `src/modules/hashring.ts`
- Test: `src/modules/hashring.test.ts` (append)

**Interfaces:**
- Consumes: Task 1–2 exports.
- Produces:
  - `latestView(states: Map<NodeId, HRState>): HRState` — state with the max `changeSeq`
  - `movedInLatestChange(states: Map<NodeId, HRState>): number`
  - Behavior: `addNode`/`removeNode` client ops broadcast `{ msg: 'membership', members, seq }` to every other pool node; each node re-homes its keys via `{ msg: 'handoff', keys }`; `moved`/`movedInChange` count keys handed off.
  - Guards: add of an existing member or non-pool node → no-op; remove of a non-member or the last member → no-op; stale `seq` (≤ `changeSeq`) → no-op.

- [ ] **Step 1: Write the failing tests**

Append to `src/modules/hashring.test.ts`:

```ts
import { latestView, movedInLatestChange } from './hashring';

/** Every key stored anywhere in the pool, with its holder. */
function placement(sim: Simulation<HRState, HRPayload>): Map<string, NodeId> {
  const map = new Map<string, NodeId>();
  for (const id of POOL) for (const k of sim.getState(id).keys) map.set(k, id);
  return map;
}

function putKeys(sim: Simulation<HRState, HRPayload>, n: number, until: number) {
  for (let i = 0; i < n; i++) sim.external('A', { cmd: 'put', key: `k${i}` });
  sim.runUntil(until);
}

describe('membership', () => {
  test('addNode migrates only keys owned by the new node; counters track the move', () => {
    const sim = makeSim(10);
    sim.runSteps(POOL.length);
    putKeys(sim, 24, 2000);
    const before = placement(sim);
    sim.external('A', { cmd: 'addNode', node: 'D' });
    sim.runUntil(4000);
    const after = placement(sim);
    expect(after.size).toBe(24); // conservation
    let migrated = 0;
    for (const [k, holder] of after) {
      if (before.get(k) !== holder) {
        expect(holder).toBe('D'); // minimal migration
        migrated++;
      }
    }
    const states = statesOf(sim);
    expect(latestView(states).members).toEqual(['A', 'B', 'C', 'D']);
    expect(movedInLatestChange(states)).toBe(migrated);
    expect(migrated).toBeGreaterThan(0);
  });

  test('removeNode drains the removed node; its keys land on ring successors', () => {
    const sim = makeSim(11);
    sim.runSteps(POOL.length);
    putKeys(sim, 24, 2000);
    sim.external('A', { cmd: 'removeNode', node: 'B' });
    sim.runUntil(4000);
    expect(sim.getState('B').keys).toEqual([]);
    const after = placement(sim);
    expect(after.size).toBe(24);
    for (const [k, holder] of after) {
      expect(holder).toBe(ringOwner(k, ['A', 'C'], 2));
    }
  });

  test('guards: add existing / add non-pool / remove non-member / remove last are no-ops', () => {
    const sim = makeSim(12);
    sim.runSteps(POOL.length);
    sim.external('A', { cmd: 'addNode', node: 'A' });
    sim.external('A', { cmd: 'addNode', node: 'Z' });
    sim.external('A', { cmd: 'removeNode', node: 'H' });
    sim.runUntil(1000);
    expect(latestView(statesOf(sim)).members).toEqual(['A', 'B', 'C']);
    sim.external('A', { cmd: 'removeNode', node: 'B' });
    sim.external('A', { cmd: 'removeNode', node: 'C' });
    sim.runUntil(2000);
    expect(latestView(statesOf(sim)).members).toEqual(['A']);
    sim.external('A', { cmd: 'removeNode', node: 'A' }); // last member — refused
    sim.runUntil(3000);
    expect(latestView(statesOf(sim)).members).toEqual(['A']);
  });

  test('stale membership broadcast (duplicate chaos) is ignored', () => {
    const sim = makeSim(13);
    sim.runSteps(POOL.length);
    sim.external('A', { cmd: 'addNode', node: 'D' });
    sim.runUntil(2000);
    const s = sim.getState('B');
    const [next] = hashring.reduce(
      s,
      { kind: 'message', self: 'B', from: 'A', time: 2001, payload: { msg: 'membership', members: ['A', 'B', 'C'], seq: s.changeSeq } },
      // rng unused by this module
      undefined as never,
    );
    expect(next.members).toEqual(s.members);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/modules/hashring.test.ts`
Expected: FAIL — `latestView` not exported; addNode is a no-op so members never change.

- [ ] **Step 3: Implement membership + handoff**

In `src/modules/hashring.ts`, replace `handleClient`'s trailing `return [s, []];` and `handleMessage`'s `case 'membership'` with the real logic, and add the helpers:

```ts
/**
 * Apply a new ring view: keep the keys this node still owns, hand off the
 * rest to their new owners. A removed member owns nothing under the new
 * ring, so it hands off everything.
 */
function applyMembership(s: HRState, members: NodeId[], seq: number): [HRState, Effect[]] {
  if (seq <= s.changeSeq) return [s, []]; // stale or duplicated broadcast
  const ring = buildRing(members, s.vnodes);
  const keep: string[] = [];
  const outgoing = new Map<NodeId, string[]>();
  for (const k of s.keys) {
    const owner = ownerOf(ring, k);
    if (owner === s.self) keep.push(k);
    else outgoing.set(owner, [...(outgoing.get(owner) ?? []), k]);
  }
  const movedCount = s.keys.length - keep.length;
  const effects: Effect[] = [...outgoing].map(([to, keys]) => ({
    type: 'send',
    to,
    payload: { msg: 'handoff', keys },
  }));
  return [
    { ...s, members, changeSeq: seq, keys: keep, moved: s.moved + movedCount, movedInChange: movedCount },
    effects,
  ];
}
```

In `handleClient`, after the `put` branch:

```ts
  // Membership change — the coordinator computes the new view, applies it
  // locally, and broadcasts it to every other pool node.
  const members =
    p.cmd === 'addNode'
      ? s.members.includes(p.node) || !s.pool.includes(p.node)
        ? null
        : [...s.members, p.node].sort()
      : !s.members.includes(p.node) || s.members.length <= 1
        ? null
        : s.members.filter((m) => m !== p.node);
  if (!members) return [s, []];
  const seq = s.changeSeq + 1;
  const [next, effects] = applyMembership(s, members, seq);
  const broadcast: Effect[] = s.pool
    .filter((n) => n !== s.self)
    .map((to) => ({ type: 'send', to, payload: { msg: 'membership', members, seq } }));
  return [next, [...effects, ...broadcast]];
```

In `handleMessage`: `case 'membership': return applyMembership(s, p.members, p.seq);`

Helpers at the bottom of the file:

```ts
/** The most up-to-date membership view across the pool (max changeSeq). */
export function latestView(states: Map<NodeId, HRState>): HRState {
  let best: HRState | null = null;
  for (const s of states.values()) if (!best || s.changeSeq > best.changeSeq) best = s;
  return best!;
}

/** Keys the ring actually moved on the latest membership change. */
export function movedInLatestChange(states: Map<NodeId, HRState>): number {
  const seq = latestView(states).changeSeq;
  if (seq === 0) return 0;
  let n = 0;
  for (const s of states.values()) if (s.changeSeq === seq) n += s.movedInChange;
  return n;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/modules/hashring.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint
git add src/modules/hashring.ts src/modules/hashring.test.ts
git commit -m "feat(modules): ring membership changes re-home keys via handoff"
```

---

### Task 4: detectHotspot verifier + metrics

**Files:**
- Modify: `src/modules/hashring.ts`
- Test: `src/modules/hashring.test.ts` (append)

**Interfaces:**
- Produces:
  - `HOTSPOT_MIN_KEYS = 12` (exported const)
  - `interface HotspotResult { node: NodeId; load: number; fairShare: number }`
  - `detectHotspot(states: Map<NodeId, HRState>): HotspotResult | null` — member with `load ≥ 2 × fairShare`, only when total stored keys ≥ `HOTSPOT_MIN_KEYS`
  - `metrics()` → `max-load-ratio` (2-dp ratio), `keys-moved` (cumulative), `ring-nodes`, `vnodes`

- [ ] **Step 1: Write the failing tests**

Append to `src/modules/hashring.test.ts`:

```ts
import { detectHotspot, HOTSPOT_MIN_KEYS } from './hashring';

describe('hotspot + metrics', () => {
  test('no hotspot below the minimum key volume', () => {
    const sim = makeSim(20);
    sim.runSteps(POOL.length);
    putKeys(sim, HOTSPOT_MIN_KEYS - 1, 2000);
    expect(detectHotspot(statesOf(sim))).toBeNull();
  });

  test('hotspot fires when one member holds ≥ 2× fair share', () => {
    const sim = makeSim(21);
    sim.runSteps(POOL.length);
    // Hand-build the skew: reduce() is pure, so feed a member state directly.
    const s = sim.getState('A');
    const skewed: HRState = { ...s, keys: Array.from({ length: 20 }, (_, i) => `s${i}`) };
    const states = statesOf(sim);
    states.set('A', skewed);
    const hit = detectHotspot(states);
    expect(hit).not.toBeNull();
    expect(hit!.node).toBe('A');
    expect(hit!.load).toBe(20);
    expect(hit!.load).toBeGreaterThanOrEqual(2 * hit!.fairShare);
  });

  test('metrics report ratio, cumulative moved, member count, V', () => {
    const sim = makeSim(22);
    sim.runSteps(POOL.length);
    putKeys(sim, 24, 2000);
    sim.external('A', { cmd: 'addNode', node: 'D' });
    sim.runUntil(4000);
    const m = Object.fromEntries(hashring.metrics(statesOf(sim), 4000).map((x) => [x.name, x.value]));
    expect(m['ring-nodes']).toBe(4);
    expect(m['vnodes']).toBe(2);
    expect(m['keys-moved']).toBeGreaterThan(0);
    expect(m['max-load-ratio']).toBeGreaterThanOrEqual(1);
  });

  test('the documented challenge recipe reaches a hotspot', () => {
    // Recipe: V=1, grow to the full pool, put 48 keys, then repeatedly remove
    // the ring-predecessor of the max-load member so it inherits that arc.
    const sim = makeSim(23, { vnodes: 1 });
    sim.runSteps(POOL.length);
    let t = 0;
    for (const n of ['D', 'E', 'F', 'G', 'H']) {
      sim.external('A', { cmd: 'addNode', node: n });
      t += 500;
      sim.runUntil(t);
    }
    for (let i = 0; i < 48; i++) sim.external('A', { cmd: 'put', key: `k${i}` });
    t += 1500;
    sim.runUntil(t);
    for (let round = 0; round < 5 && !detectHotspot(statesOf(sim)); round++) {
      const view = latestView(statesOf(sim));
      const ring = buildRing(view.members, 1);
      const loads = view.members.map((m) => ({ m, load: sim.getState(m).keys.length }));
      const max = loads.reduce((a, b) => (b.load > a.load ? b : a)).m;
      const i = ring.findIndex((v) => v.node === max);
      const victim = ring[(i - 1 + ring.length) % ring.length].node;
      sim.external('A', { cmd: 'removeNode', node: victim });
      t += 1000;
      sim.runUntil(t);
    }
    expect(detectHotspot(statesOf(sim))).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/modules/hashring.test.ts`
Expected: FAIL — `detectHotspot` not exported.

- [ ] **Step 3: Implement verifier + metrics**

Append to `src/modules/hashring.ts`, and replace the stub `metrics()` in the module object:

```ts
/** Minimum stored keys before a hotspot verdict is meaningful (blocks 1-key degenerate wins). */
export const HOTSPOT_MIN_KEYS = 12;

export interface HotspotResult {
  node: NodeId;
  load: number;
  fairShare: number;
}

/**
 * A member holding ≥ 2× its fair share of stored keys. Sound and
 * quiescence-free — reads current per-node key counts.
 */
export function detectHotspot(states: Map<NodeId, HRState>): HotspotResult | null {
  const view = latestView(states);
  const loads = view.members.map((m) => ({ node: m, load: states.get(m)?.keys.length ?? 0 }));
  const total = loads.reduce((n, l) => n + l.load, 0);
  if (total < HOTSPOT_MIN_KEYS) return null;
  const fairShare = total / view.members.length;
  const worst = loads.reduce((a, b) => (b.load > a.load ? b : a));
  return worst.load >= 2 * fairShare ? { node: worst.node, load: worst.load, fairShare } : null;
}
```

```ts
  metrics(states) {
    const view = latestView(states);
    const loads = view.members.map((m) => states.get(m)?.keys.length ?? 0);
    const total = loads.reduce((a, b) => a + b, 0);
    const fair = view.members.length > 0 ? total / view.members.length : 0;
    const ratio = fair > 0 ? Math.round((Math.max(...loads) / fair) * 100) / 100 : 0;
    let moved = 0;
    for (const s of states.values()) moved += s.moved;
    return [
      { name: 'max-load-ratio', value: ratio },
      { name: 'keys-moved', value: moved },
      { name: 'ring-nodes', value: view.members.length },
      { name: 'vnodes', value: view.vnodes },
    ];
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/modules/hashring.test.ts`
Expected: PASS (18 tests). If the recipe test fails at 5 rounds, raise the round cap to 6 and re-run once; if it still fails, report DONE_WITH_CONCERNS with the observed loads — do not weaken the verifier.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint
git add src/modules/hashring.ts src/modules/hashring.test.ts
git commit -m "feat(modules): detectHotspot verifier and ring metrics"
```

---

### Task 5: Property tests

**Files:**
- Create: `src/modules/hashring.property.test.ts`

**Interfaces:**
- Consumes: everything exported by `hashring.ts`; `fast-check` (`fc.subarray`, style mirror of `leaderless.property.test.ts`).

- [ ] **Step 1: Write the property tests** (they should pass immediately — the properties pin behavior already built; a failure here is a real bug in Tasks 1–3)

```ts
// src/modules/hashring.property.test.ts
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { Simulation, type NodeId } from '../engine';
import { hashring, ringOwner, type HRPayload, type HRState } from './hashring';

const POOL = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

test('property: every key routes to exactly one member', () => {
  fc.assert(
    fc.property(
      fc.subarray(POOL, { minLength: 1, maxLength: 8 }),
      fc.integer({ min: 1, max: 8 }),
      fc.string({ minLength: 1, maxLength: 12 }),
      (members, vnodes, key) => {
        const owner = ringOwner(key, members, vnodes);
        expect(members).toContain(owner);
        expect(ringOwner(key, members, vnodes)).toBe(owner); // deterministic
      },
    ),
    { numRuns: 200 },
  );
});

test('property: adding a node moves keys only onto the added node', () => {
  fc.assert(
    fc.property(
      fc.subarray(POOL, { minLength: 2, maxLength: 7 }),
      fc.integer({ min: 1, max: 8 }),
      fc.integer({ min: 0, max: 1000 }),
      (members, vnodes, salt) => {
        const added = POOL.find((n) => !members.includes(n))!;
        const after = [...members, added].sort();
        for (let i = 0; i < 40; i++) {
          const k = `k${salt}-${i}`;
          const was = ringOwner(k, members, vnodes);
          const now = ringOwner(k, after, vnodes);
          if (now !== was) expect(now).toBe(added);
        }
      },
    ),
    { numRuns: 200 },
  );
});

test('property: sequential ops, no chaos — every put key is stored exactly once', () => {
  type Op = { kind: 'add' | 'remove'; node: string } | { kind: 'put'; n: number };
  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ kind: fc.constant<'add'>('add'), node: fc.constantFrom(...POOL) }),
    fc.record({ kind: fc.constant<'remove'>('remove'), node: fc.constantFrom(...POOL) }),
    fc.record({ kind: fc.constant<'put'>('put'), n: fc.integer({ min: 1, max: 8 }) }),
  );
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 2 ** 30 }),
      fc.integer({ min: 1, max: 4 }),
      fc.array(opArb, { minLength: 2, maxLength: 10 }),
      (seed, vnodes, ops) => {
        const sim = new Simulation<HRState, HRPayload>({
          module: hashring,
          config: { nodeIds: POOL, params: { vnodes } },
          seed,
          network: { latency: [1, 40] },
        });
        sim.runSteps(POOL.length);
        const put = new Set<string>();
        let t = 0;
        let nextKey = 0;
        for (const op of ops) {
          if (op.kind === 'put') {
            for (let i = 0; i < op.n; i++) {
              const k = `k${nextKey++}`;
              put.add(k);
              sim.external('A', { cmd: 'put', key: k });
            }
          } else {
            sim.external('A', op.kind === 'add' ? { cmd: 'addNode', node: op.node } : { cmd: 'removeNode', node: op.node });
          }
          t += 1500;
          sim.runUntil(t); // sequential: quiesce between ops
        }
        const holders = new Map<string, NodeId[]>();
        for (const id of POOL)
          for (const k of sim.getState(id).keys) holders.set(k, [...(holders.get(k) ?? []), id]);
        expect(holders.size).toBe(put.size);
        for (const [k, hs] of holders) {
          expect(put.has(k)).toBe(true);
          expect(hs).toHaveLength(1);
        }
      },
    ),
    { numRuns: 50 },
  );
});
```

- [ ] **Step 2: Run the property tests**

Run: `npx vitest run src/modules/hashring.property.test.ts`
Expected: PASS (3 tests). Any failure is a genuine Task 1–3 bug — minimize with the fast-check counterexample and fix the module, not the test.

- [ ] **Step 3: Run the full suite + coverage**

Run: `npm test && npx vitest run --coverage`
Expected: all green; coverage thresholds (80%) hold on `src/engine/**` + `src/modules/**`.

- [ ] **Step 4: Commit**

```bash
git add src/modules/hashring.property.test.ts
git commit -m "test(modules): hash-ring property tests — single owner, minimal migration, conservation"
```

---

### Task 6: RingView kit component

**Files:**
- Create: `src/ui/kit/RingView.tsx`
- Test: `src/ui/kit/RingView.test.tsx`

**Interfaces:**
- Consumes: `fnv1a`, `NodeId` from `../../engine`; `buildRing` from `../../modules/hashring`.
- Produces:
  - `interface KeyPlacement { key: string; owner: NodeId }`
  - `RingView({ pool, members, vnodes, placements }: { pool: NodeId[]; members: NodeId[]; vnodes: number; placements: KeyPlacement[] })`
  - Rendering contract (locked for the test): each vnode tick carries `data-vnode`, each key dot `data-key`, each load-bar row `data-load={nodeId}`. Node color = `NODE_COLORS[pool.indexOf(node) % NODE_COLORS.length]`. Recolor-only migration: a key dot's position depends only on its hash; owner changes just change its fill.

- [ ] **Step 1: Write the failing test**

```tsx
// src/ui/kit/RingView.test.tsx
// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { RingView } from './RingView';

afterEach(cleanup);

const POOL = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

test('renders one tick per vnode, one dot per key, one load row per member', () => {
  const { container } = render(
    <RingView
      pool={POOL}
      members={['A', 'B', 'C']}
      vnodes={2}
      placements={[
        { key: 'k1', owner: 'A' },
        { key: 'k2', owner: 'A' },
        { key: 'k3', owner: 'B' },
      ]}
    />,
  );
  expect(container.querySelectorAll('[data-vnode]')).toHaveLength(6);
  expect(container.querySelectorAll('[data-key]')).toHaveLength(3);
  const rows = container.querySelectorAll('[data-load]');
  expect(rows).toHaveLength(3);
  expect(rows[0].textContent).toContain('A');
  expect(rows[0].textContent).toContain('2');
});

test('a key dot recolors when its owner changes (recolor-only migration)', () => {
  const { container, rerender } = render(
    <RingView pool={POOL} members={['A', 'B']} vnodes={1} placements={[{ key: 'k1', owner: 'A' }]} />,
  );
  const before = container.querySelector('[data-key="k1"]')!.getAttribute('fill');
  rerender(
    <RingView pool={POOL} members={['A', 'B']} vnodes={1} placements={[{ key: 'k1', owner: 'B' }]} />,
  );
  const after = container.querySelector('[data-key="k1"]')!.getAttribute('fill');
  expect(after).not.toBe(before);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/kit/RingView.test.tsx`
Expected: FAIL — `Cannot find module './RingView'`.

- [ ] **Step 3: Implement RingView**

```tsx
// src/ui/kit/RingView.tsx
import { fnv1a, type NodeId } from '../../engine';
import { buildRing } from '../../modules/hashring';

/** Stable per-node hues, indexed by pool position (same precedent as MetricsPanel's palette). */
const NODE_COLORS = ['#0ea5e9', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

const CX = 160;
const CY = 160;
const R = 120;

export interface KeyPlacement {
  key: string;
  owner: NodeId;
}

function angleOf(pos: number): number {
  return (pos / 0x100000000) * 2 * Math.PI - Math.PI / 2;
}

function xy(angle: number, radius: number): { x: number; y: number } {
  return { x: CX + radius * Math.cos(angle), y: CY + radius * Math.sin(angle) };
}

/**
 * The consistent-hash ring (DESIGN_PLAN Ch6): vnode ticks and key dots at
 * their fnv1a angles, colored by owning node, plus per-member load bars.
 * Migration renders as recolor — a dot's position never changes, only its fill.
 */
export function RingView({
  pool,
  members,
  vnodes,
  placements,
}: {
  pool: NodeId[];
  members: NodeId[];
  vnodes: number;
  placements: KeyPlacement[];
}) {
  const colorOf = (node: NodeId) => NODE_COLORS[pool.indexOf(node) % NODE_COLORS.length];
  const ring = buildRing(members, vnodes);
  const loads = new Map<NodeId, number>(members.map((m) => [m, 0]));
  for (const p of placements) loads.set(p.owner, (loads.get(p.owner) ?? 0) + 1);
  const total = placements.length;
  const fair = members.length > 0 ? total / members.length : 0;
  const maxLoad = Math.max(1, ...loads.values());

  return (
    <div className="flex shrink-0 items-start gap-4">
      <svg viewBox="0 0 320 320" className="w-[320px] select-none">
        <circle cx={CX} cy={CY} r={R} className="fill-none stroke-line" strokeWidth={2} />
        {ring.map((v, i) => {
          const a = angleOf(v.pos);
          const p1 = xy(a, R - 6);
          const p2 = xy(a, R + 6);
          return (
            <line
              key={`${v.node}-${i}`}
              data-vnode={v.node}
              x1={p1.x}
              y1={p1.y}
              x2={p2.x}
              y2={p2.y}
              stroke={colorOf(v.node)}
              strokeWidth={3}
            />
          );
        })}
        {placements.map((p) => {
          const q = xy(angleOf(fnv1a(p.key)), R - 16);
          return <circle key={p.key} data-key={p.key} cx={q.x} cy={q.y} r={3.5} fill={colorOf(p.owner)} />;
        })}
      </svg>
      <div className="space-y-1 pt-2 font-mono text-xs">
        <p className="text-dim">load ({total} keys)</p>
        {members.map((m) => {
          const load = loads.get(m) ?? 0;
          const hot = total >= 12 && fair > 0 && load >= 2 * fair;
          return (
            <div key={m} data-load={m} className="flex items-center gap-2">
              <span className="w-4" style={{ color: colorOf(m) }}>
                {m}
              </span>
              <span className={`w-6 text-right ${hot ? 'text-warn font-bold' : 'text-fg'}`}>{load}</span>
              <div className="h-2 w-32 rounded bg-ink">
                <div
                  className="h-2 rounded"
                  style={{ width: `${(load / maxLoad) * 100}%`, backgroundColor: colorOf(m) }}
                />
              </div>
              {hot && <span className="text-warn">hot</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ui/kit/RingView.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint
git add src/ui/kit/RingView.tsx src/ui/kit/RingView.test.tsx
git commit -m "feat(ui): RingView — vnode ticks, key dots, load bars with hot highlight"
```

Note: RingView (UI) importing `buildRing` from `src/modules/hashring` is allowed — the ESLint purity fence blocks modules→UI imports, not UI→modules.

---

### Task 7: HashRingLab page + routing

**Files:**
- Create: `src/ui/labs/hashring/HashRingLab.tsx`
- Modify: `src/ui/shell/catalog.ts` (flip `6.1` to `active`)
- Modify: `src/ui/App.tsx` (PAGES `'6.1'`)
- Test: `src/ui/App.test.tsx` (append)

**Interfaces:**
- Consumes: `hashring`, `HRState`, `HRPayload`, `HRInspect`, `detectHotspot`, `latestView`, `movedInLatestChange`, `modNMovedCount`, `HOTSPOT_MIN_KEYS` from modules; `RingView`, `KeyPlacement` from kit; `SimDriver`, `useSimStore`, `ChaosToolbar`, `ChallengePanel`, `MetricsPanel`, `TimelineScrubber`, `btn`, `inputBox` — all existing.
- Produces: `HashRingLab()` component; catalog `6.1` active; App page `'6.1'`.

- [ ] **Step 1: Write the failing test**

Append to `src/ui/App.test.tsx`:

```tsx
test('hash ring lab renders from the sidebar', () => {
  render(<App />);
  fireEvent.click(screen.getByText('Consistent Hashing Ring'));
  expect(screen.getByText('Consistent Hashing Ring', { selector: 'h1' })).toBeTruthy();
  expect(screen.getByText('add node')).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/App.test.tsx`
Expected: FAIL — the 6.1 sidebar button is disabled (`soon`), click does nothing, no h1.

- [ ] **Step 3: Implement the lab page**

```tsx
// src/ui/labs/hashring/HashRingLab.tsx
import { useEffect, useState } from 'react';
import { Simulation, type NodeId } from '../../../engine';
import {
  detectHotspot,
  hashring,
  latestView,
  modNMovedCount,
  movedInLatestChange,
  type HRInspect,
  type HRPayload,
  type HRState,
} from '../../../modules/hashring';
import { SimDriver } from '../../bridge/SimDriver';
import { useSimStore } from '../../bridge/simStore';
import { ChaosToolbar } from '../../kit/ChaosToolbar';
import { ChallengePanel } from '../../kit/ChallengePanel';
import { MetricsPanel } from '../../kit/MetricsPanel';
import { RingView, type KeyPlacement } from '../../kit/RingView';
import { TimelineScrubber } from '../../kit/TimelineScrubber';
import { btn, inputBox } from '../../kit/classes';

const NODE_IDS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

export function HashRingLab() {
  const [vnodes, setVnodes] = useState(2);
  const [epoch, setEpoch] = useState(0);
  const [putCount, setPutCount] = useState(24);
  const [nextKey, setNextKey] = useState(0);
  const [addPick, setAddPick] = useState<NodeId>('D');
  const [removePick, setRemovePick] = useState<NodeId>('C');
  const [lastChange, setLastChange] = useState<{ from: NodeId[]; to: NodeId[] } | null>(null);
  const [driver, setDriver] = useState<SimDriver<HRState, HRPayload> | null>(null);
  // Driver-in-effect pattern (PR #2): build the sim in the commit phase, never
  // during render. V is build-time (spec §2) — changing it rebuilds with a
  // fresh seed/epoch, so vnodes joins epoch in the dep list.
  useEffect(() => {
    useSimStore.getState().reset();
    const seed = 6000 + epoch;
    const sim = new Simulation<HRState, HRPayload>({
      module: hashring,
      config: { nodeIds: NODE_IDS, params: { vnodes } },
      seed,
      network: { latency: [10, 80] },
    });
    const d = new SimDriver({ sim, seed, publish: (v) => useSimStore.getState().publish(v) });
    setDriver(d);
    setNextKey(0);
    setLastChange(null);
    return () => d.pause();
  }, [vnodes, epoch]);
  const view = useSimStore();
  if (!driver) return null;

  const statesOf = () =>
    new Map<NodeId, HRState>(
      driver.sim.config.nodeIds.map((id) => [id, driver.sim.getState(id)] as const),
    );

  // Render from the published store view only (one-directional bridge).
  const inspects = new Map(view.nodes.map((n) => [n.id, n.inspect as unknown as HRInspect]));
  const ringView = [...inspects.values()].reduce(
    (a, b) => (b.changeSeq > (a?.changeSeq ?? -1) ? b : a),
    null as HRInspect | null,
  );
  const members = ringView?.members ?? [];
  const placements: KeyPlacement[] = members.flatMap(
    (m) => (inspects.get(m)?.keys ?? []).map((key) => ({ key, owner: m })),
  );
  const coordinator = members[0];
  const addable = NODE_IDS.filter((n) => !members.includes(n));
  const allKeys = placements.map((p) => p.key);
  const actualMoved = lastChange ? movedInLatestChange(statesOf()) : 0;
  const modNMoved = lastChange ? modNMovedCount(allKeys, lastChange.from, lastChange.to) : 0;

  const change = (cmd: 'addNode' | 'removeNode', node: NodeId) => {
    const to =
      cmd === 'addNode' ? [...members, node].sort() : members.filter((m) => m !== node);
    setLastChange({ from: members, to });
    driver.external(coordinator, { cmd, node });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
        <label className="flex items-center gap-1">
          vnodes/node (rebuilds)
          <input
            type="range"
            min={1}
            max={100}
            value={vnodes}
            onChange={(e) => setVnodes(Number(e.target.value))}
          />
          {vnodes}
        </label>
        <button className={btn} onClick={() => setEpoch((e) => e + 1)}>
          reset (new seed)
        </button>
        <span className="text-dim">ring: {members.join(' ')} · pool of {NODE_IDS.length}</span>
      </div>
      <TimelineScrubber
        processed={view.processed}
        pending={view.pending}
        running={view.running}
        onPlayPause={() => (view.running ? driver.pause() : driver.start())}
        onStep={() => driver.stepOnce()}
        onScrub={(i) => driver.scrubTo(i)}
      />
      <div className="flex items-start gap-6">
        <RingView pool={NODE_IDS} members={members} vnodes={vnodes} placements={placements} />
        <MetricsPanel history={view.metricsHistory} />
      </div>
      <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
        <input
          type="number"
          min={1}
          max={64}
          className={`w-16 ${inputBox}`}
          value={putCount}
          onChange={(e) => setPutCount(Number(e.target.value))}
          aria-label="key count"
        />
        <button
          className={btn}
          onClick={() => {
            for (let i = 0; i < putCount; i++)
              driver.external(coordinator, { cmd: 'put', key: `k${nextKey + i}` });
            setNextKey((n) => n + putCount);
          }}
        >
          put {putCount} keys
        </button>
        <select className={inputBox} value={addPick} onChange={(e) => setAddPick(e.target.value)}>
          {addable.map((id) => (
            <option key={id}>{id}</option>
          ))}
        </select>
        <button className={btn} disabled={addable.length === 0} onClick={() => change('addNode', addPick)}>
          add node
        </button>
        <select className={inputBox} value={removePick} onChange={(e) => setRemovePick(e.target.value)}>
          {members.map((id) => (
            <option key={id}>{id}</option>
          ))}
        </select>
        <button
          className={btn}
          disabled={members.length <= 1}
          onClick={() => change('removeNode', removePick)}
        >
          remove node
        </button>
      </div>
      {lastChange && (
        <p className="font-mono text-xs text-fg">
          last change: ring moved <span className="text-set font-bold">{actualMoved}</span> keys ·{' '}
          naive <code>hash mod N</code> would move{' '}
          <span className="text-warn font-bold">{modNMoved}</span> of {allKeys.length}
        </p>
      )}
      <ChaosToolbar
        caps={hashring.chaos}
        nodeIds={NODE_IDS}
        deadNodes={view.nodes.filter((n) => n.dead).map((n) => n.id)}
        onAction={(a) => driver.control(a)}
      />
      <ChallengePanel
        title="Chaos Challenge: create a hotspot"
        storageKeyPrefix="ddia:ch06:hotspot"
        prompt="Predict first: how will you make one node carry ≥2× its fair share? (skippable)"
        runningHint="low vnodes make big arcs — put keys, then shrink the ring so one node inherits its neighbours."
        check={() => detectHotspot(statesOf())}
        onWin={() => driver.pause()}
        renderWin={(win, prediction) => (
          <>
            <p>
              node <code className="text-warn">{win.node}</code> holds {win.load} keys — fair share
              is {win.fairShare.toFixed(1)}. One node is doing {(win.load / win.fairShare).toFixed(1)}×
              its share of the work. Now raise vnodes (rebuild) or add a node and watch{' '}
              <code>max-load-ratio</code> fall.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />
    </div>
  );
}
```

- [ ] **Step 4: Flip the catalog entry and register the page**

`src/ui/shell/catalog.ts` — change the ch6 lab entry:

```ts
    labs: [{ id: '6.1', label: 'Consistent Hashing Ring', status: 'active' }],
```

`src/ui/App.tsx` — add the import and the PAGES entry:

```tsx
import { HashRingLab } from './labs/hashring/HashRingLab';
```

```tsx
  '6.1': {
    eyebrow: 'Chapter 6 — Partitioning',
    title: 'Consistent Hashing Ring',
    thesis:
      'Keys and nodes hash onto the same circle; a key belongs to the first node clockwise. Add a node and only its arcs move — remove one and its keys slide to the successors. Naive hash-mod-N would reshuffle almost everything. Skew the ring until one node does double work.',
    Component: HashRingLab,
  },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/ui/App.test.tsx src/ui/shell/catalog.test.ts`
Expected: PASS — new nav test green; catalog order test untouched (status change only).

- [ ] **Step 6: Full suite, typecheck, lint, commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/ui/labs/hashring/HashRingLab.tsx src/ui/shell/catalog.ts src/ui/App.tsx src/ui/App.test.tsx
git commit -m "feat(ui): consistent hashing ring lab (6.1) with hotspot challenge"
```

---

### Task 8: Ch6 debrief

**Files:**
- Create: `src/ui/kit/DebriefArticle.tsx`
- Create: `content/ch06/debrief.mdx`
- Create: `src/ui/labs/hashring/Debrief.tsx`
- Modify: `src/ui/kit/SurpriseJournal.tsx` (add `storageKey` prop)
- Modify: `src/ui/labs/replication/Debrief.tsx` (use `DebriefArticle`)
- Modify: `src/ui/shell/catalog.ts` (add `6.d`), `src/ui/App.tsx` (PAGES `'6.d'`), `src/ui/shell/catalog.test.ts` (unchanged — order stable)

**Interfaces:**
- Produces:
  - `DebriefArticle({ children }: { children: ReactNode })` — the article wrapper extracted verbatim from `replication/Debrief.tsx`
  - `SurpriseJournal({ storageKey = 'ddia:ch05:journal' }: { storageKey?: string })` — default preserves ch5 behavior
  - `HashRingDebrief()` component; catalog `6.d` entry; App page `'6.d'`

- [ ] **Step 1: Extract `DebriefArticle` and add the journal prop**

```tsx
// src/ui/kit/DebriefArticle.tsx
import type { ReactNode } from 'react';

/** Shared debrief typography wrapper — MDX content + journal render inside it. */
export function DebriefArticle({ children }: { children: ReactNode }) {
  return (
    <article className="max-w-xl space-y-4 [&_h1]:hidden [&_h2]:text-base [&_h2]:font-bold [&_h2]:text-fg [&_h2]:mt-4 [&_p]:text-sm [&_p]:text-dim [&_p]:leading-relaxed [&_li]:text-sm [&_li]:text-dim [&_ul]:list-disc [&_ul]:pl-5 [&_code]:text-warn [&_strong]:text-fg [&_em]:text-fg">
      {children}
    </article>
  );
}
```

`src/ui/kit/SurpriseJournal.tsx` — parameterize the key (default keeps ch5's):

```tsx
export function SurpriseJournal({ storageKey = 'ddia:ch05:journal' }: { storageKey?: string } = {}) {
  const [text, setText] = useState(() => localStorage.getItem(storageKey) ?? '');
```

(and replace both `KEY` usages with `storageKey`; delete the module-level `const KEY`.)

`src/ui/labs/replication/Debrief.tsx` — replace the `<article className=...>` wrapper with `<DebriefArticle>`:

```tsx
import DebriefContent from '../../../../content/ch05/debrief.mdx';
import { DebriefArticle } from '../../kit/DebriefArticle';
import { SurpriseJournal } from '../../kit/SurpriseJournal';

export function Debrief() {
  return (
    <DebriefArticle>
      <DebriefContent />
      <SurpriseJournal />
    </DebriefArticle>
  );
}
```

- [ ] **Step 2: Write the debrief content**

```mdx
// content/ch06/debrief.mdx  (file starts at the h1 — no comment line)
# Chapter 6 — Partitioning: Debrief

## The property you just watched

When you added a node, only the keys inside its new arcs moved — the readout showed
consistent hashing re-homing a handful of keys while **hash mod N would have reshuffled
almost all of them**. That is the whole trick: node and key positions come from the same
hash circle, so membership changes are local edits, not global reshuffles.

## Virtual nodes

At low vnodes you made a hotspot: one node owned a huge arc and hit ≥2× its fair
share. Raising vnodes splits each node into many small arcs scattered around the
circle — the law of large numbers evens the load. Real systems ship this dial:

- **Cassandra / ScyllaDB**: `num_tokens` (256 vnodes per node by default in older Cassandra).
- **Riak**: fixed ring of 64/128/256 partitions claimed by nodes.
- **Amazon Dynamo**: the paper's "strategy 3" — Q equal-sized partitions, T per node.

## What hashing cannot fix

A **celebrity hot key** — one key receiving most of the traffic — lands on exactly one
owner no matter how you hash. The ring balances *key count*, not *key popularity*.
Real fixes live above the partitioner: request caching, key salting (append a random
suffix and fan reads back in), or splitting the hot key's value.

## The crash contrast

`kill node` here strands keys — this lab keeps **one copy per key**, so a dead owner
means unreachable data. That is why membership changes in this lab are *planned*
add/remove operations, and why Ch5's replication exists: partitioning decides *where*
data lives, replication decides *how many places*.

## Terms

*consistent hashing* · *virtual nodes (vnodes)* · *rebalancing* · *hot spot / skew* —
the partitioning vocabulary of DDIA Ch6.
```

(Do not include the `// content/...` comment line in the real file — MDX starts at `# Chapter 6`.)

- [ ] **Step 3: Wire the ch6 debrief page**

```tsx
// src/ui/labs/hashring/Debrief.tsx
import DebriefContent from '../../../../content/ch06/debrief.mdx';
import { DebriefArticle } from '../../kit/DebriefArticle';
import { SurpriseJournal } from '../../kit/SurpriseJournal';

export function HashRingDebrief() {
  return (
    <DebriefArticle>
      <DebriefContent />
      <SurpriseJournal storageKey="ddia:ch06:journal" />
    </DebriefArticle>
  );
}
```

`src/ui/shell/catalog.ts` — ch6 labs become:

```ts
    labs: [
      { id: '6.1', label: 'Consistent Hashing Ring', status: 'active' },
      { id: '6.d', label: 'Debrief & Journal', status: 'active' },
    ],
```

`src/ui/App.tsx` — add:

```tsx
import { HashRingDebrief } from './labs/hashring/Debrief';
```

```tsx
  '6.d': {
    eyebrow: 'Chapter 6 — Debrief',
    title: 'Why so few keys moved',
    thesis:
      'The minimal-migration property you just used, the vnode dial real systems ship, and the hot key no partitioner can fix.',
    Component: HashRingDebrief,
  },
```

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green — ch5 debrief still renders (existing App tests), catalog order test still green (6.d appends inside ch6, chapter order unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/ui/kit/DebriefArticle.tsx src/ui/kit/SurpriseJournal.tsx src/ui/labs/replication/Debrief.tsx src/ui/labs/hashring/Debrief.tsx content/ch06/debrief.mdx src/ui/shell/catalog.ts src/ui/App.tsx
git commit -m "feat(ui): ch6 debrief — minimal migration, vnodes, hot-key limit"
```

---

### Task 9: Verification sweep

**Files:** none created — gates only.

- [ ] **Step 1: Full gates**

```bash
npm run lint && npm run typecheck && npx vitest run --coverage && npm run build
```
Expected: all green; coverage ≥ 80% on engine+modules; build succeeds.

- [ ] **Step 2: Bundle budget**

```bash
gzip -c dist/assets/*.js | wc -c
```
Expected: < 512000 (500 KB gzip). If over, check that `hashring.ts` didn't drag unexpected imports — the lab adds no new dependencies.

- [ ] **Step 3: Browser verification (superpowers:verification-before-completion + verifying-frontend-changes)**

Run `npm run dev`, open the app (playwright or manual), then walk the Definition of Done:
1. Sidebar shows Ch.6 active with 6.1 + 6.d; click 6.1 → RingView renders with A B C arcs.
2. `put 24 keys` → dots appear; load bars populate; metrics chart shows 4 lines.
3. `add node D` → readout appears: ring moved few vs mod-N many; migrated dots recolor to D's hue.
4. Set vnodes ≈ 60 (rebuild), re-put keys → load bars visibly even out; `max-load-ratio` near 1.
5. Win the challenge at vnodes=1: put 48 keys, add all nodes, remove ring-predecessors of the biggest bar until the panel fires with the hot node named.
6. Scrub the timeline back and forth — no console errors; navigate 5.1 ↔ 6.1 — no setState-during-render warning.
7. 6.d debrief renders; journal persists under `ddia:ch06:journal`.

- [ ] **Step 4: Commit any fixes, then hand off**

Rebase on `origin/master`, push `feat/ch6-hashring`, PR forced draft per dev-workflow. Merge gate stays human-approved.

---

## Self-Review (done at plan time)

- **Spec coverage:** §2 ring model → Tasks 1–4; §3 RingView → Task 6; §4 controls + readout → Task 7; §5 challenge → Tasks 4+7; §6 constraints → Global Constraints + Task 9; §8 DoD → Task 9 walk; §9 open questions → recolor-only locked (user), property phrasing locked (Task 5 test 2). Deviation noted: vnodes slider max 100 (spec said "up to ~200") — keeps SVG tick count ≤ 800 at full pool; smoothing is fully visible by 60.
- **Type consistency:** `HRState/HRPayload/HRInspect/HotspotResult/RingVnode/KeyPlacement` names and signatures match across all tasks; `latestView`/`movedInLatestChange`/`modNMovedCount` used in Task 7 exactly as exported in Tasks 1/3.
- **Known chaos behaviors (by design, documented in debrief):** dropped `membership` broadcast leaves a stale view (no anti-entropy); dropped `handoff` loses keys (one copy per key — the lab's point); killed owner strands keys.
