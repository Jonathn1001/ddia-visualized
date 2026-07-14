# Ch3.1 Storage Engines (LSM vs B-tree) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship DDIA Ch3.1 — an LSM-tree and a B-tree running side-by-side on the same key-value workload, with a shared write/read/space amplification scoreboard and three storage-chaos challenges.

**Architecture:** One `Simulation`, nodes `['LSM','Btree']`, driven by a thin `storage` dispatcher module that routes `init/reduce/metrics/inspect` to isolated pure engines `lsm.ts` / `btree.ts` by nodeId. The driver injects each op as an `external` event to both nodes. The module emits **zero `send` effects** (proves the network engine runs a local-only lab); flush/compaction/split-commit are `timer` effects on the virtual clock. Storage faults (`crash-mid-write` / `torn-write` / `disk-full`) are module-interpreted `external` events — no engine/`ControlAction` change.

**Tech Stack:** TypeScript, Vitest, fast-check (property tests), React 19, Tailwind, Zustand store bridge, MDX debrief. All engine/module code is pure + deterministic (no RNG, no wall clock) — positions/bloom bits come from `engine/hash` `fnv1a`.

## Global Constraints

- Module contract v0.2 (`src/engine/module.ts`): `SimModule<S,P>` with `id`, `chaos`, `init(nodeId,config,rng)`, `reduce(state,event,rng)→[S,Effect[]]`, `metrics(states,time)`, `inspect(state)`. Verbatim.
- State must be **plain, serializable, immutable** (snapshots deep-clone via `structuredClone`) — no `Symbol`, no `Map`/`Set` inside module state, no class instances; return new objects, never mutate in place.
- Effects allowed: **only** `{type:'timer';delay;payload}`. No `{type:'send'}` anywhere in this lab.
- Determinism: same seed + same op sequence → byte-identical serialized state. No `Math.random`, no `Date.now`.
- Tombstone sentinel = `val: null` on an entry (serializable). Deleted key = present entry with `val === null`.
- Byte model is illustrative, not measured (mirrors Ch4 `BYTES`): `BYTES_PER_ENTRY = 16`.
- Debrief paths use **zero-padded** chapter dirs: `content/ch03/debrief.mdx`, journal key `ddia:ch03:journal` (matches existing `ch06`).
- Commits: conventional commits, specific files only (never `git add -A`). Co-author trailer:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Run tests with `npx vitest run <path>`; typecheck with `npx tsc --noEmit`.

---

### Task 1: storage-shared.ts — topology, constants, types, amp math

**Files:**
- Create: `src/modules/storage-shared.ts`
- Test: `src/modules/storage-shared.test.ts`

**Interfaces:**
- Produces: `LSM`, `BTREE`, `STORAGE_TOPOLOGY`, `MEMTABLE_CAP`, `L0_TRIGGER`, `BTREE_ORDER`, `BYTES_PER_ENTRY`, `DEFAULT_DISK_CAP`; types `StorageOp`, `StorageFault`, `StoragePayload`, `Counters`; helpers `round2`, `writeAmp(c)`, `bloomHashes(key)`.

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/storage-shared.test.ts
import { expect, test } from 'vitest';
import {
  BYTES_PER_ENTRY, STORAGE_TOPOLOGY, LSM, BTREE, writeAmp, round2, bloomHashes, BLOOM_BITS,
} from './storage-shared';

test('topology is exactly the two engines', () => {
  expect(STORAGE_TOPOLOGY).toEqual([LSM, BTREE]);
});

test('writeAmp = bytesWritten / userBytes, rounded to 2dp; 0 when no user bytes', () => {
  expect(writeAmp({ diskReads: 0, diskWrites: 0, bytesWritten: 64, userBytes: 16 })).toBe(4);
  expect(writeAmp({ diskReads: 0, diskWrites: 0, bytesWritten: 20, userBytes: 16 })).toBe(1.25);
  expect(writeAmp({ diskReads: 0, diskWrites: 0, bytesWritten: 0, userBytes: 0 })).toBe(0);
});

test('round2 rounds half up to two decimals', () => {
  expect(round2(1.2349)).toBe(1.23);
  expect(round2(1.005)).toBe(1.01);
});

test('bloomHashes returns two in-range bit indices, deterministic', () => {
  const a = bloomHashes('k7');
  expect(a).toHaveLength(2);
  for (const i of a) expect(i).toBeGreaterThanOrEqual(0), expect(i).toBeLessThan(BLOOM_BITS);
  expect(bloomHashes('k7')).toEqual(a);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/storage-shared.test.ts`
Expected: FAIL — cannot find module `./storage-shared`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/modules/storage-shared.ts
import type { NodeId } from '../engine/events';
import { fnv1a } from '../engine/hash';

/** Ch3 storage lab: two engines, side-by-side, same workload. */
export const LSM: NodeId = 'LSM';
export const BTREE: NodeId = 'Btree';
export const STORAGE_TOPOLOGY: NodeId[] = [LSM, BTREE];

/** Bounded so flush/compaction/split are frequent and watchable (not realistic sizes). */
export const MEMTABLE_CAP = 4; // memtable entries before an LSM flush
export const L0_TRIGGER = 3; // L0 runs before an LSM compaction
export const BTREE_ORDER = 3; // max keys per B-tree page before a split
export const BYTES_PER_ENTRY = 16; // illustrative user bytes per key/value
export const DEFAULT_DISK_CAP = 512; // bytes on disk before disk-full bites
export const BLOOM_BITS = 64; // bits per SSTable bloom filter

/** User-issued operations (arrive as external events, mirrored to both engines). */
export type StorageOp =
  | { op: 'put'; key: string; val: string }
  | { op: 'get'; key: string }
  | { op: 'delete'; key: string };

/** Storage-domain faults (external events the engine interprets — not ControlActions). */
export type StorageFault =
  | { fault: 'crash-mid-write' }
  | { fault: 'torn-write' }
  | { fault: 'disk-full' }
  | { fault: 'recover' }; // clear disk-full pressure / finish recovery

/** Internal deferred work each engine schedules on itself via timer effects. */
export type StorageTimer =
  | { timer: 'flush-phase2' }
  | { timer: 'compact' }
  | { timer: 'split-commit' };

export type StoragePayload = StorageOp | StorageFault | StorageTimer | null;

export function isOp(p: StoragePayload): p is StorageOp {
  return !!p && 'op' in p;
}
export function isFault(p: StoragePayload): p is StorageFault {
  return !!p && 'fault' in p;
}
export function isTimer(p: StoragePayload): p is StorageTimer {
  return !!p && 'timer' in p;
}

export interface Counters {
  diskReads: number;
  diskWrites: number;
  bytesWritten: number;
  userBytes: number;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** LSM's headline cost: total bytes written (incl. compaction rewrites) vs user bytes. */
export function writeAmp(c: Counters): number {
  return c.userBytes > 0 ? round2(c.bytesWritten / c.userBytes) : 0;
}

/** murmur fmix32 avalanche — same finalizer the ring uses, for well-spread bloom bits. */
function mix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Two independent bit indices for a key — pure, deterministic. */
export function bloomHashes(key: string): [number, number] {
  const h = mix32(fnv1a(key));
  const g = mix32(h ^ 0x9e3779b9);
  return [h % BLOOM_BITS, g % BLOOM_BITS];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/storage-shared.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/storage-shared.ts src/modules/storage-shared.test.ts
git commit -m "feat(modules): Ch3 storage-shared — topology, cost model, bloom hashes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: lsm.ts — put/get/delete + WAL (no flush yet)

**Files:**
- Create: `src/modules/lsm.ts`
- Test: `src/modules/lsm.test.ts`

**Interfaces:**
- Consumes: everything from Task 1.
- Produces: `LsmState` (tagged `engine:'lsm'`), `lsmInit(config)`, `lsmReduce(state,event)→[LsmState,Effect[]]`, `lsmInspect(state)→LsmInspect`, `lsmGet(state,key)→{state,value}`. `LsmInspect` fields: `engine, memtable, sstables, wal, phase, diskReads, diskWrites, writeAmp, readAmp, spaceAmp, bloomSkips, diskFull`.

Design notes for the implementer:
- `LsmState` fields: `engine:'lsm'`, `self`, `memtable: Entry[]` (sorted by key; `Entry = {key:string; val:string|null}`), `wal: WalRec[]` (`WalRec = {seq:number; key:string; val:string|null}`), `walAckSeq:number`, `sstables: SSTable[]` (`SSTable = {level:0|1; entries:Entry[]; bloom:number[]; min:string; max:string}`), `phase:'idle'|'flushing'|'compacting'|'recovering'`, counters + `lastReadCost:number`, `bloomSkips:number`, `diskCap:number`, `diskFull:boolean`.
- A `put`/`delete` appends a WAL record (`diskWrites++`, this is the durable step), sets `walAckSeq`, and upserts the memtable entry (kept sorted). `userBytes += BYTES_PER_ENTRY` on put/delete.
- This task does **not** flush yet (memtable can exceed cap; flush lands in Task 3). Keep `phase:'idle'`.

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/lsm.test.ts
import { expect, test } from 'vitest';
import { lsmInit, lsmReduce, lsmGet, type LsmState } from './lsm';
import { STORAGE_TOPOLOGY, LSM } from './storage-shared';

const cfg = { nodeIds: STORAGE_TOPOLOGY };
const ev = (payload: unknown) => ({ kind: 'external' as const, self: LSM, time: 0, payload });

function put(s: LsmState, key: string, val: string): LsmState {
  return lsmReduce(s, ev({ op: 'put', key, val }))[0];
}

test('put then get returns the value', () => {
  let s = lsmInit(cfg);
  s = put(s, 'a', '1');
  expect(lsmGet(s, 'a').value).toBe('1');
  expect(lsmGet(s, 'missing').value).toBeUndefined();
});

test('put appends a durable WAL record and counts a disk write', () => {
  let s = lsmInit(cfg);
  s = put(s, 'a', '1');
  expect(s.wal).toHaveLength(1);
  expect(s.wal[0]).toMatchObject({ key: 'a', val: '1' });
  expect(s.diskWrites).toBe(1);
  expect(s.userBytes).toBe(16);
});

test('delete writes a tombstone; get sees the key as absent', () => {
  let s = lsmInit(cfg);
  s = put(s, 'a', '1');
  s = lsmReduce(s, ev({ op: 'delete', key: 'a' }))[0];
  expect(lsmGet(s, 'a').value).toBeUndefined();
  expect(s.memtable.find((e) => e.key === 'a')?.val).toBeNull();
});

test('put emits no send effects (local-only module)', () => {
  const [, effects] = lsmReduce(lsmInit(cfg), ev({ op: 'put', key: 'a', val: '1' }));
  expect(effects.every((e) => e.type !== 'send')).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/lsm.test.ts`
Expected: FAIL — cannot find module `./lsm`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/modules/lsm.ts
import type { NodeId } from '../engine/events';
import type { Effect, ModuleConfig, ModuleEvent } from '../engine/module';
import {
  BYTES_PER_ENTRY, DEFAULT_DISK_CAP, LSM,
  isOp, type Counters, type StoragePayload,
} from './storage-shared';

export interface Entry {
  key: string;
  val: string | null; // null = tombstone
}
export interface WalRec {
  seq: number;
  key: string;
  val: string | null;
}
export interface SSTable {
  level: 0 | 1;
  entries: Entry[]; // immutable sorted run
  bloom: number[]; // set bit indices
  min: string;
  max: string;
}

export interface LsmState extends Counters {
  engine: 'lsm';
  self: NodeId;
  memtable: Entry[]; // sorted by key
  wal: WalRec[];
  walAckSeq: number;
  sstables: SSTable[];
  phase: 'idle' | 'flushing' | 'compacting' | 'recovering';
  lastReadCost: number;
  bloomSkips: number;
  diskCap: number;
  diskFull: boolean;
}

export function lsmInit(_config: ModuleConfig): LsmState {
  return {
    engine: 'lsm',
    self: LSM,
    memtable: [],
    wal: [],
    walAckSeq: 0,
    sstables: [],
    phase: 'idle',
    diskReads: 0,
    diskWrites: 0,
    bytesWritten: 0,
    userBytes: 0,
    lastReadCost: 0,
    bloomSkips: 0,
    diskCap: DEFAULT_DISK_CAP,
    diskFull: false,
  };
}

/** Upsert into a key-sorted entry array, returning a new array. */
function upsert(entries: Entry[], e: Entry): Entry[] {
  const out = entries.filter((x) => x.key !== e.key);
  out.push(e);
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

function applyWrite(s: LsmState, key: string, val: string | null): LsmState {
  const seq = s.walAckSeq + 1;
  return {
    ...s,
    wal: [...s.wal, { seq, key, val }],
    walAckSeq: seq,
    memtable: upsert(s.memtable, { key, val }),
    diskWrites: s.diskWrites + 1,
    bytesWritten: s.bytesWritten + BYTES_PER_ENTRY,
    userBytes: s.userBytes + BYTES_PER_ENTRY,
  };
}

/** Point read: memtable first, then SSTables newest→oldest. Counts read cost. */
export function lsmGet(s: LsmState, key: string): { state: LsmState; value: string | undefined } {
  const inMem = s.memtable.find((e) => e.key === key);
  if (inMem) {
    return { state: { ...s, lastReadCost: 1, diskReads: s.diskReads + 1 }, value: inMem.val ?? undefined };
  }
  let cost = 0;
  for (let i = s.sstables.length - 1; i >= 0; i--) {
    const t = s.sstables[i];
    cost++;
    const hit = t.entries.find((e) => e.key === key);
    if (hit) {
      return { state: { ...s, lastReadCost: cost, diskReads: s.diskReads + cost }, value: hit.val ?? undefined };
    }
  }
  return { state: { ...s, lastReadCost: cost, diskReads: s.diskReads + cost }, value: undefined };
}

export function lsmReduce(state: LsmState, event: ModuleEvent<StoragePayload>): [LsmState, Effect[]] {
  const p = event.payload;
  if (isOp(p)) {
    if (p.op === 'put') return [applyWrite(state, p.key, p.val), []];
    if (p.op === 'delete') return [applyWrite(state, p.key, null), []];
    if (p.op === 'get') return [lsmGet(state, p.key).state, []]; // read updates counters
  }
  return [state, []];
}

export interface LsmInspect {
  engine: 'lsm';
  memtable: Entry[];
  sstables: SSTable[];
  walLen: number;
  phase: LsmState['phase'];
  diskReads: number;
  diskWrites: number;
  bytesWritten: number;
  userBytes: number;
  lastReadCost: number;
  bloomSkips: number;
  diskFull: boolean;
}

export function lsmInspect(s: LsmState): LsmInspect {
  return {
    engine: 'lsm',
    memtable: s.memtable,
    sstables: s.sstables,
    walLen: s.wal.length,
    phase: s.phase,
    diskReads: s.diskReads,
    diskWrites: s.diskWrites,
    bytesWritten: s.bytesWritten,
    userBytes: s.userBytes,
    lastReadCost: s.lastReadCost,
    bloomSkips: s.bloomSkips,
    diskFull: s.diskFull,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/lsm.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/lsm.ts src/modules/lsm.test.ts
git commit -m "feat(modules): LSM engine core — WAL-backed put/get/delete, tombstones

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: lsm.ts — flush (2-phase timer) → L0 SSTable + bloom

**Files:**
- Modify: `src/modules/lsm.ts`
- Test: `src/modules/lsm.test.ts` (add cases)

**Interfaces:**
- Consumes: Task 2 `LsmState`, `applyWrite`; Task 1 `MEMTABLE_CAP`, `bloomHashes`.
- Produces: flush behaviour — `put` past `MEMTABLE_CAP` returns a `timer` effect `{timer:'flush-phase2'}` and sets `phase:'flushing'`; the timer reduce writes memtable → new L0 `SSTable` (with bloom), clears memtable, truncates flushed WAL prefix, `phase:'idle'`. Adds `buildBloom(entries)`, `bloomMight(bloom,key)`.

- [ ] **Step 1: Write the failing test (append)**

```ts
// append to src/modules/lsm.test.ts
import { isTimer, MEMTABLE_CAP } from './storage-shared';
import { lsmInit as _init } from './lsm'; // (already imported above; keep one import)

test('memtable past cap schedules a flush; the flush-phase2 timer writes an L0 SSTable', () => {
  let s = lsmInit(cfg);
  let effects;
  for (let i = 0; i <= MEMTABLE_CAP; i++) {
    [s, effects] = lsmReduce(s, ev({ op: 'put', key: `k${i}`, val: String(i) }));
  }
  // the write that tips it over cap requests a flush
  expect(s.phase).toBe('flushing');
  expect(effects!.some((e) => e.type === 'timer')).toBe(true);
  // run the flush timer
  [s] = lsmReduce(s, { kind: 'timer', self: LSM, time: 10, payload: { timer: 'flush-phase2' } });
  expect(s.phase).toBe('idle');
  expect(s.memtable).toHaveLength(0);
  expect(s.sstables).toHaveLength(1);
  expect(s.sstables[0].level).toBe(0);
  expect(s.sstables[0].entries.length).toBe(MEMTABLE_CAP + 1);
});

test('a flushed key is still readable from its SSTable', () => {
  let s = lsmInit(cfg);
  for (let i = 0; i <= MEMTABLE_CAP; i++) s = lsmReduce(s, ev({ op: 'put', key: `k${i}`, val: String(i) }))[0];
  [s] = lsmReduce(s, { kind: 'timer', self: LSM, time: 10, payload: { timer: 'flush-phase2' } });
  expect(lsmGet(s, 'k0').value).toBe('0');
});

test('bloom filter never rejects a key that is present', () => {
  let s = lsmInit(cfg);
  for (let i = 0; i <= MEMTABLE_CAP; i++) s = lsmReduce(s, ev({ op: 'put', key: `x${i}`, val: String(i) }))[0];
  [s] = lsmReduce(s, { kind: 'timer', self: LSM, time: 10, payload: { timer: 'flush-phase2' } });
  const bloom = s.sstables[0].bloom;
  for (let i = 0; i <= MEMTABLE_CAP; i++) expect(bloomMightContain(bloom, `x${i}`)).toBe(true);
});
```

Add the import for `bloomMightContain` at the top of the test file: `import { lsmInit, lsmReduce, lsmGet, bloomMightContain, type LsmState } from './lsm';`

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/lsm.test.ts`
Expected: FAIL — `bloomMightContain` is not exported / flush not implemented.

- [ ] **Step 3: Write minimal implementation (edit lsm.ts)**

Add bloom helpers and flush logic. Replace `applyWrite`'s callers path so a `put`/`delete` that fills the memtable requests a flush:

```ts
// add near top of lsm.ts imports
import { MEMTABLE_CAP, bloomHashes } from './storage-shared';

export function buildBloom(entries: Entry[]): number[] {
  const bits = new Set<number>();
  for (const e of entries) for (const b of bloomHashes(e.key)) bits.add(b);
  return [...bits].sort((a, b) => a - b);
}
export function bloomMightContain(bloom: number[], key: string): boolean {
  return bloomHashes(key).every((b) => bloom.includes(b));
}

/** After a write, if the memtable is full and we're idle, request a flush. */
function maybeFlush(s: LsmState): [LsmState, Effect[]] {
  if (s.phase === 'idle' && s.memtable.length > MEMTABLE_CAP) {
    return [{ ...s, phase: 'flushing' }, [{ type: 'timer', delay: 10, payload: { timer: 'flush-phase2' } }]];
  }
  return [s, []];
}

function flushPhase2(s: LsmState): LsmState {
  if (s.memtable.length === 0) return { ...s, phase: 'idle' };
  const entries = s.memtable;
  const table: SSTable = {
    level: 0,
    entries,
    bloom: buildBloom(entries),
    min: entries[0].key,
    max: entries[entries.length - 1].key,
  };
  return {
    ...s,
    sstables: [...s.sstables, table],
    memtable: [],
    wal: [], // flushed prefix is now durable in the SSTable
    bytesWritten: s.bytesWritten + entries.length * BYTES_PER_ENTRY,
    diskWrites: s.diskWrites + 1,
    phase: 'idle',
  };
}
```

Update `lsmReduce` so writes trigger `maybeFlush` and timer events dispatch:

```ts
export function lsmReduce(state: LsmState, event: ModuleEvent<StoragePayload>): [LsmState, Effect[]] {
  const p = event.payload;
  if (isTimer(p)) {
    if (p.timer === 'flush-phase2') return [flushPhase2(state), []];
    return [state, []];
  }
  if (isOp(p)) {
    if (p.op === 'get') return [lsmGet(state, p.key).state, []];
    const written = p.op === 'put' ? applyWrite(state, p.key, p.val) : applyWrite(state, p.key, null);
    return maybeFlush(written);
  }
  return [state, []];
}
```

Add `isTimer` to the storage-shared import list.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/lsm.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/lsm.ts src/modules/lsm.test.ts
git commit -m "feat(modules): LSM flush — 2-phase timer, L0 SSTable, bloom filter

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: lsm.ts — L0→L1 compaction (write amplification)

**Files:**
- Modify: `src/modules/lsm.ts`
- Test: `src/modules/lsm.test.ts` (add cases)

**Interfaces:**
- Consumes: Task 3 `flushPhase2`, `SSTable`; Task 1 `L0_TRIGGER`.
- Produces: after a flush, when L0 run count `≥ L0_TRIGGER`, `flushPhase2` returns a `{timer:'compact'}` request (via `maybeCompact`); the compact timer merges all L0 runs (newest wins per key) into one L1 run, drops entries whose `val===null` (tombstone) when no lower level keeps them, accrues rewritten `bytesWritten`. Adds `mergeRuns(runs)`, `compact(state)`.

- [ ] **Step 1: Write the failing test (append)**

```ts
// append to src/modules/lsm.test.ts
import { L0_TRIGGER } from './storage-shared';

function flushNow(s: LsmState): LsmState {
  // fill+flush one full memtable
  for (let i = 0; i < MEMTABLE_CAP + 1; i++) s = lsmReduce(s, ev({ op: 'put', key: `f${s.userBytes}_${i}`, val: 'v' }))[0];
  return lsmReduce(s, { kind: 'timer', self: LSM, time: 1, payload: { timer: 'flush-phase2' } })[0];
}

test('reaching L0_TRIGGER runs schedules a compaction that produces one L1 run', () => {
  let s = lsmInit(cfg);
  let lastEffects;
  for (let r = 0; r < L0_TRIGGER; r++) {
    for (let i = 0; i < MEMTABLE_CAP + 1; i++) s = lsmReduce(s, ev({ op: 'put', key: `r${r}k${i}`, val: 'v' }))[0];
    [s, lastEffects] = lsmReduce(s, { kind: 'timer', self: LSM, time: 1, payload: { timer: 'flush-phase2' } });
  }
  expect(lastEffects!.some((e) => e.type === 'timer' && (e.payload as { timer: string }).timer === 'compact')).toBe(true);
  [s] = lsmReduce(s, { kind: 'timer', self: LSM, time: 5, payload: { timer: 'compact' } });
  expect(s.sstables.filter((t) => t.level === 0)).toHaveLength(0);
  expect(s.sstables.filter((t) => t.level === 1)).toHaveLength(1);
});

test('compaction keeps the newest value for a re-written key', () => {
  let s = lsmInit(cfg);
  // write k=old, flush, then k=new in a later run, then compact
  s = lsmReduce(s, ev({ op: 'put', key: 'dup', val: 'old' }))[0];
  s = flushNow(s); // pushes an L0 run containing dup=old (+ fillers)
  s = lsmReduce(s, ev({ op: 'put', key: 'dup', val: 'new' }))[0];
  s = flushNow(s);
  s = flushNow(s); // third run tips L0_TRIGGER
  [s] = lsmReduce(s, { kind: 'timer', self: LSM, time: 9, payload: { timer: 'compact' } });
  expect(lsmGet(s, 'dup').value).toBe('new');
});

test('bytesWritten grows on compaction — this is LSM write amplification', () => {
  let s = lsmInit(cfg);
  const before = () => s.bytesWritten;
  for (let r = 0; r < L0_TRIGGER; r++) s = flushNow(s);
  const preCompact = before();
  [s] = lsmReduce(s, { kind: 'timer', self: LSM, time: 9, payload: { timer: 'compact' } });
  expect(s.bytesWritten).toBeGreaterThan(preCompact);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/lsm.test.ts`
Expected: FAIL — compaction not implemented.

- [ ] **Step 3: Write minimal implementation (edit lsm.ts)**

```ts
import { L0_TRIGGER } from './storage-shared';

/** Merge sorted runs, newest-run-wins per key. `runs` ordered oldest→newest. */
function mergeRuns(runs: SSTable[]): Entry[] {
  const map = new Map<string, string | null>();
  for (const r of runs) for (const e of r.entries) map.set(e.key, e.val); // later run overwrites
  return [...map.entries()]
    .map(([key, val]) => ({ key, val }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function toTable(level: 0 | 1, entries: Entry[]): SSTable {
  return {
    level,
    entries,
    bloom: buildBloom(entries),
    min: entries.length ? entries[0].key : '',
    max: entries.length ? entries[entries.length - 1].key : '',
  };
}

/** Merge all L0 runs (+ existing L1) into a single L1 run; drop tombstones (bottom level). */
function compact(s: LsmState): LsmState {
  const l0 = s.sstables.filter((t) => t.level === 0);
  const l1 = s.sstables.filter((t) => t.level === 1);
  if (l0.length === 0) return { ...s, phase: 'idle' };
  const merged = mergeRuns([...l1, ...l0]).filter((e) => e.val !== null); // L1 is the bottom → drop tombstones
  return {
    ...s,
    sstables: [toTable(1, merged)],
    bytesWritten: s.bytesWritten + merged.length * BYTES_PER_ENTRY, // rewrite cost
    diskWrites: s.diskWrites + 1,
    phase: 'idle',
  };
}

function maybeCompact(s: LsmState): [LsmState, Effect[]] {
  if (s.phase === 'idle' && s.sstables.filter((t) => t.level === 0).length >= L0_TRIGGER) {
    return [{ ...s, phase: 'compacting' }, [{ type: 'timer', delay: 15, payload: { timer: 'compact' } }]];
  }
  return [s, []];
}
```

Chain `maybeCompact` after a flush completes, and dispatch the `compact` timer:

```ts
// in lsmReduce, timer branch:
  if (isTimer(p)) {
    if (p.timer === 'flush-phase2') return maybeCompact(flushPhase2(state));
    if (p.timer === 'compact') return [compact(state), []];
    return [state, []];
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/lsm.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/lsm.ts src/modules/lsm.test.ts
git commit -m "feat(modules): LSM L0->L1 compaction — merge, drop tombstones, write-amp

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: lsm.ts — storage faults (crash-mid-write / disk-full / torn-write)

**Files:**
- Modify: `src/modules/lsm.ts`
- Test: `src/modules/lsm.test.ts` (add cases)

**Interfaces:**
- Consumes: Task 2–4 state + `isFault`.
- Produces: fault handling in `lsmReduce` for `external` fault payloads:
  - `crash-mid-write`: drop volatile memtable, keep WAL, `phase:'recovering'`; a follow-up `recover` fault (or the next op) replays WAL into the memtable. Model recovery inline: on `crash-mid-write`, rebuild memtable from `wal` (committed records survive), set `phase:'idle'`. Un-flushed writes still in WAL are recovered; nothing acked is lost.
  - `disk-full`: set `diskFull:true`; while set, `compact` is skipped (stays `compacting`→ actually keep L0, `phase:'idle'`, no merge) and further flush still allowed but `disk-full` primarily blocks compaction headroom. A `recover` fault clears it.
  - `torn-write`: mark the newest SSTable `torn:true`; a read that touches a torn run detects it and repairs from WAL — simplest faithful model: on `torn-write`, corrupt the last run's `entries` (drop last entry) but keep `wal`; expose `torn` so a verifier/`recover` rebuilds it from WAL. Add `torn?:boolean` to `SSTable`.

Keep the model minimal but test-pinned. Concretely:

- [ ] **Step 1: Write the failing test (append)**

```ts
// append to src/modules/lsm.test.ts
import { isFault } from './storage-shared';
const fault = (f: string) => ({ kind: 'external' as const, self: LSM, time: 0, payload: { fault: f } });

test('crash-mid-write keeps WAL-acked keys and recovers them; volatile-only work survives via WAL', () => {
  let s = lsmInit(cfg);
  s = lsmReduce(s, ev({ op: 'put', key: 'durable', val: '1' }))[0]; // acked in WAL, not yet flushed
  s = lsmReduce(s, fault('crash-mid-write'))[0];
  expect(s.phase).toBe('idle');
  expect(lsmGet(s, 'durable').value).toBe('1'); // replayed from WAL
});

test('disk-full stops compaction from running (L0 stays), still readable', () => {
  let s = lsmInit(cfg);
  s = lsmReduce(s, fault('disk-full'))[0];
  for (let r = 0; r < L0_TRIGGER; r++) {
    for (let i = 0; i < MEMTABLE_CAP + 1; i++) s = lsmReduce(s, ev({ op: 'put', key: `r${r}k${i}`, val: 'v' }))[0];
    s = lsmReduce(s, { kind: 'timer', self: LSM, time: 1, payload: { timer: 'flush-phase2' } })[0];
  }
  s = lsmReduce(s, { kind: 'timer', self: LSM, time: 9, payload: { timer: 'compact' } })[0];
  expect(s.diskFull).toBe(true);
  expect(s.sstables.filter((t) => t.level === 0).length).toBeGreaterThanOrEqual(L0_TRIGGER);
  expect(lsmGet(s, 'r0k0').value).toBe('v');
});

test('torn-write corrupts the last run but recover rebuilds it from WAL', () => {
  let s = lsmInit(cfg);
  s = lsmReduce(s, ev({ op: 'put', key: 'p', val: '9' }))[0];
  s = lsmReduce(s, fault('torn-write'))[0];
  expect(s.sstables.some((t) => t.torn)).toBe(true);
  s = lsmReduce(s, fault('recover'))[0];
  expect(s.sstables.some((t) => t.torn)).toBe(false);
  expect(lsmGet(s, 'p').value).toBe('9');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/lsm.test.ts`
Expected: FAIL — fault handling not implemented.

- [ ] **Step 3: Write minimal implementation (edit lsm.ts)**

Add `torn?: boolean` to the `SSTable` interface. Add `isFault` to imports. Implement:

```ts
/** Rebuild the memtable from committed WAL records (recovery replay). */
function recoverFromWal(s: LsmState): LsmState {
  let memtable: Entry[] = [];
  for (const r of s.wal) memtable = upsert(memtable, { key: r.key, val: r.val });
  return { ...s, memtable, phase: 'idle' };
}

function applyFault(s: LsmState, f: string): LsmState {
  if (f === 'crash-mid-write') {
    // volatile memtable is lost on crash; the WAL is durable → replay it.
    return recoverFromWal({ ...s, memtable: [], phase: 'recovering' });
  }
  if (f === 'disk-full') return { ...s, diskFull: true };
  if (f === 'torn-write') {
    if (s.sstables.length === 0) return s;
    const last = s.sstables.length - 1;
    const torn = { ...s.sstables[last], entries: s.sstables[last].entries.slice(0, -1), torn: true };
    return { ...s, sstables: s.sstables.map((t, i) => (i === last ? torn : t)) };
  }
  if (f === 'recover') {
    // clear disk pressure and repair torn runs from the WAL/rebuild
    const repaired = s.sstables.map((t) =>
      t.torn ? toTable(t.level, mergeRuns([t, { ...t, entries: s.wal.map((r) => ({ key: r.key, val: r.val })) }])) : t,
    );
    return { ...s, diskFull: false, sstables: repaired };
  }
  return s;
}
```

Guard compaction while `diskFull`, and dispatch faults in `lsmReduce`:

```ts
// compact() first line:
function compact(s: LsmState): LsmState {
  if (s.diskFull) return { ...s, phase: 'idle' }; // no headroom to merge
  // ...unchanged...
}

// in lsmReduce, before isOp:
  if (isFault(p)) return [applyFault(state, p.fault), []];
```

Note: `toTable` in `recover` uses the WAL as the authoritative source for the torn run's lost tail; for the bounded lab this restores the dropped entry. Keep `recover` idempotent.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/lsm.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/lsm.ts src/modules/lsm.test.ts
git commit -m "feat(modules): LSM storage faults — crash-recover, disk-full, torn-write

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: lsm.property.test.ts — bloom soundness, compaction preserves values, determinism

**Files:**
- Create: `src/modules/lsm.property.test.ts`

**Interfaces:**
- Consumes: Task 2–5 exports.

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/lsm.property.test.ts
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { lsmInit, lsmReduce, lsmGet, buildBloom, bloomMightContain, type LsmState } from './lsm';
import { STORAGE_TOPOLOGY, LSM } from './storage-shared';

const cfg = { nodeIds: STORAGE_TOPOLOGY };
const ev = (payload: unknown) => ({ kind: 'external' as const, self: LSM, time: 0, payload });

test('property: bloom never false-negative — a present key always probes positive', () => {
  fc.assert(
    fc.property(fc.array(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 20 }), (keys) => {
      const bloom = buildBloom(keys.map((k) => ({ key: k, val: 'v' })));
      for (const k of keys) expect(bloomMightContain(bloom, k)).toBe(true);
    }),
    { numRuns: 200 },
  );
});

test('property: after any op sequence + flushes, get matches a reference map', () => {
  type Op = { op: 'put'; key: string; val: string } | { op: 'delete'; key: string };
  const key = fc.constantFrom('a', 'b', 'c', 'd', 'e');
  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ op: fc.constant<'put'>('put'), key, val: fc.string({ minLength: 1, maxLength: 3 }) }),
    fc.record({ op: fc.constant<'delete'>('delete'), key }),
  );
  fc.assert(
    fc.property(fc.array(opArb, { minLength: 1, maxLength: 40 }), (ops) => {
      let s: LsmState = lsmInit(cfg);
      const ref = new Map<string, string | null>();
      for (const op of ops) {
        s = lsmReduce(s, ev(op))[0];
        ref.set(op.key, op.op === 'put' ? op.val : null);
        // drain any scheduled flush/compact deterministically
        for (const t of ['flush-phase2', 'compact'] as const)
          s = lsmReduce(s, { kind: 'timer', self: LSM, time: 1, payload: { timer: t } })[0];
      }
      for (const [k, v] of ref) expect(lsmGet(s, k).value).toBe(v ?? undefined);
    }),
    { numRuns: 100 },
  );
});

test('property: same op sequence → byte-identical serialized state (determinism)', () => {
  const opArb = fc.record({ key: fc.constantFrom('a', 'b', 'c'), val: fc.string({ minLength: 1, maxLength: 3 }) });
  fc.assert(
    fc.property(fc.array(opArb, { minLength: 1, maxLength: 30 }), (ops) => {
      const run = () => {
        let s: LsmState = lsmInit(cfg);
        for (const o of ops) {
          s = lsmReduce(s, ev({ op: 'put', ...o }))[0];
          s = lsmReduce(s, { kind: 'timer', self: LSM, time: 1, payload: { timer: 'flush-phase2' } })[0];
        }
        return JSON.stringify(s);
      };
      expect(run()).toBe(run());
    }),
    { numRuns: 100 },
  );
});
```

- [ ] **Step 2: Run test to verify it fails, then passes**

Run: `npx vitest run src/modules/lsm.property.test.ts`
Expected: PASS (the engine from Tasks 2–5 already satisfies these). If any property fails, fix `lsm.ts` — do not weaken the property.

- [ ] **Step 3: Commit**

```bash
git add src/modules/lsm.property.test.ts
git commit -m "test(modules): LSM properties — bloom soundness, value-preserving, determinism

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: btree.ts — put/get/delete + redo WAL + split + height

**Files:**
- Create: `src/modules/btree.ts`
- Test: `src/modules/btree.test.ts`

**Interfaces:**
- Consumes: Task 1 exports (`BTREE_ORDER`, `BYTES_PER_ENTRY`, `BTREE`, `isOp`, `isTimer`, `Counters`, `StoragePayload`).
- Produces: `BtreeState` (tagged `engine:'btree'`), `btreeInit(config)`, `btreeReduce`, `btreeGet(state,key)`, `btreeInspect`. `BtreeState`: `engine, self, pages:Record<string,Page>, rootId, height, wal:RedoRec[], phase:'idle'|'splitting'|'recovering', counters, lastReadCost, diskCap, diskFull`. `Page = {id:string; keys:string[]; vals:(string|null)[]}` — leaf-only tree (single level of leaves under a root index) is enough for the bounded lab; a split adds a leaf and lifts a separator into the root index. Keep it simple: root holds separators + child ids; leaves hold keys+vals.

Design note: model a **2-level** B-tree (root index + leaves). `put` finds the leaf by separator, inserts in order; on overflow (`> BTREE_ORDER`) split the leaf, insert separator into root; if the root overflows too, grow height (new root). `get` reads root then one leaf → `lastReadCost = height` (1 for a single leaf, 2 once a root index exists).

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/btree.test.ts
import { expect, test } from 'vitest';
import { btreeInit, btreeReduce, btreeGet, type BtreeState } from './btree';
import { STORAGE_TOPOLOGY, BTREE, BTREE_ORDER } from './storage-shared';

const cfg = { nodeIds: STORAGE_TOPOLOGY };
const ev = (payload: unknown) => ({ kind: 'external' as const, self: BTREE, time: 0, payload });
const put = (s: BtreeState, key: string, val: string) => btreeReduce(s, ev({ op: 'put', key, val }))[0];

test('put then get returns the value; missing key is undefined', () => {
  let s = btreeInit(cfg);
  s = put(s, 'm', '1');
  expect(btreeGet(s, 'm').value).toBe('1');
  expect(btreeGet(s, 'zzz').value).toBeUndefined();
});

test('put appends a redo record and counts a disk write', () => {
  let s = btreeInit(cfg);
  s = put(s, 'm', '1');
  expect(s.wal).toHaveLength(1);
  expect(s.diskWrites).toBeGreaterThan(0);
  expect(s.userBytes).toBe(16);
});

test('overflowing a leaf splits it and grows the tree height', () => {
  let s = btreeInit(cfg);
  expect(s.height).toBe(1);
  for (let i = 0; i <= BTREE_ORDER; i++) s = put(s, `k${i}`, String(i)); // BTREE_ORDER+1 keys > order
  expect(Object.keys(s.pages).length).toBeGreaterThan(1); // at least one split leaf
  expect(s.height).toBe(2);
});

test('get cost equals tree height (read amplification)', () => {
  let s = btreeInit(cfg);
  for (let i = 0; i <= BTREE_ORDER; i++) s = put(s, `k${i}`, String(i));
  const r = btreeGet(s, 'k0');
  expect(r.state.lastReadCost).toBe(s.height);
});

test('delete removes the key in place', () => {
  let s = btreeInit(cfg);
  s = put(s, 'm', '1');
  s = btreeReduce(s, ev({ op: 'delete', key: 'm' }))[0];
  expect(btreeGet(s, 'm').value).toBeUndefined();
});

test('put emits no send effects', () => {
  const [, effects] = btreeReduce(btreeInit(cfg), ev({ op: 'put', key: 'm', val: '1' }));
  expect(effects.every((e) => e.type !== 'send')).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/btree.test.ts`
Expected: FAIL — cannot find module `./btree`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/modules/btree.ts
import type { NodeId } from '../engine/events';
import type { Effect, ModuleConfig, ModuleEvent } from '../engine/module';
import {
  BTREE, BTREE_ORDER, BYTES_PER_ENTRY, DEFAULT_DISK_CAP,
  isFault, isOp, type Counters, type StoragePayload,
} from './storage-shared';

export interface Page {
  id: string;
  leaf: boolean;
  keys: string[];
  vals: (string | null)[]; // leaf values (null = deleted); empty on index pages
  children: string[]; // index child ids; empty on leaves
}
export interface RedoRec {
  seq: number;
  key: string;
  val: string | null;
}

export interface BtreeState extends Counters {
  engine: 'btree';
  self: NodeId;
  pages: Record<string, Page>;
  rootId: string;
  height: number;
  nextPage: number;
  wal: RedoRec[];
  walAckSeq: number;
  phase: 'idle' | 'splitting' | 'recovering';
  lastReadCost: number;
  diskCap: number;
  diskFull: boolean;
}

export function btreeInit(_config: ModuleConfig): BtreeState {
  const root: Page = { id: 'p0', leaf: true, keys: [], vals: [], children: [] };
  return {
    engine: 'btree',
    self: BTREE,
    pages: { p0: root },
    rootId: 'p0',
    height: 1,
    nextPage: 1,
    wal: [],
    walAckSeq: 0,
    diskReads: 0,
    diskWrites: 0,
    bytesWritten: 0,
    userBytes: 0,
    lastReadCost: 0,
    diskCap: DEFAULT_DISK_CAP,
    diskFull: false,
  };
}

/** Descend from root to the leaf that owns `key`, returning the leaf id. Counts reads. */
function findLeaf(s: BtreeState, key: string): { leafId: string; reads: number } {
  let pid = s.rootId;
  let reads = 1;
  while (!s.pages[pid].leaf) {
    const idx = s.pages[pid];
    let child = idx.children[0];
    for (let i = 0; i < idx.keys.length; i++) if (key >= idx.keys[i]) child = idx.children[i + 1];
    pid = child;
    reads++;
  }
  return { leafId: pid, reads };
}

export function btreeGet(s: BtreeState, key: string): { state: BtreeState; value: string | undefined } {
  const { leafId, reads } = findLeaf(s, key);
  const leaf = s.pages[leafId];
  const i = leaf.keys.indexOf(key);
  const val = i >= 0 ? leaf.vals[i] : null;
  return { state: { ...s, lastReadCost: reads, diskReads: s.diskReads + reads }, value: val ?? undefined };
}

/** Insert key/val into a sorted leaf, returning a new page. */
function leafInsert(leaf: Page, key: string, val: string | null): Page {
  const keys = [...leaf.keys];
  const vals = [...leaf.vals];
  const at = keys.indexOf(key);
  if (at >= 0) {
    vals[at] = val;
  } else {
    let i = 0;
    while (i < keys.length && keys[i] < key) i++;
    keys.splice(i, 0, key);
    vals.splice(i, 0, val);
  }
  return { ...leaf, keys, vals };
}

function applyWrite(s: BtreeState, key: string, val: string | null): BtreeState {
  const seq = s.walAckSeq + 1;
  const base: BtreeState = {
    ...s,
    wal: [...s.wal, { seq, key, val }],
    walAckSeq: seq,
    diskWrites: s.diskWrites + 1,
    bytesWritten: s.bytesWritten + BYTES_PER_ENTRY,
    userBytes: s.userBytes + BYTES_PER_ENTRY,
  };
  const { leafId } = findLeaf(base, key);
  const leaf = leafInsert(base.pages[leafId], key, val);
  const pages = { ...base.pages, [leafId]: leaf };
  const withLeaf: BtreeState = { ...base, pages, bytesWritten: base.bytesWritten + BYTES_PER_ENTRY };
  return leaf.keys.length > BTREE_ORDER ? splitLeaf(withLeaf, leafId) : withLeaf;
}

/** Split an overflowing leaf; lift the separator into (or create) the root index. */
function splitLeaf(s: BtreeState, leafId: string): BtreeState {
  if (s.diskFull) return s; // no space to allocate a new page → split rejected
  const leaf = s.pages[leafId];
  const mid = Math.floor(leaf.keys.length / 2);
  const rightId = `p${s.nextPage}`;
  const left: Page = { ...leaf, keys: leaf.keys.slice(0, mid), vals: leaf.vals.slice(0, mid) };
  const right: Page = { id: rightId, leaf: true, keys: leaf.keys.slice(mid), vals: leaf.vals.slice(mid), children: [] };
  const separator = right.keys[0];
  let pages = { ...s.pages, [leafId]: left, [rightId]: right };
  let rootId = s.rootId;
  let height = s.height;

  if (s.rootId === leafId) {
    // leaf was the root → make a new index root
    const newRootId = `p${s.nextPage + 1}`;
    pages[newRootId] = { id: newRootId, leaf: false, keys: [separator], vals: [], children: [leafId, rightId] };
    rootId = newRootId;
    height = 2;
    return { ...s, pages, rootId, height, nextPage: s.nextPage + 2, diskWrites: s.diskWrites + 2, bytesWritten: s.bytesWritten + 2 * BYTES_PER_ENTRY, phase: 'idle' };
  }
  // insert separator into existing root index (bounded: assume single index level)
  const root = pages[rootId];
  const childIdx = root.children.indexOf(leafId);
  const keys = [...root.keys];
  const children = [...root.children];
  keys.splice(childIdx, 0, separator);
  children.splice(childIdx + 1, 0, rightId);
  pages[rootId] = { ...root, keys, children };
  return { ...s, pages, nextPage: s.nextPage + 1, diskWrites: s.diskWrites + 2, bytesWritten: s.bytesWritten + 2 * BYTES_PER_ENTRY, phase: 'idle' };
}

export function btreeReduce(state: BtreeState, event: ModuleEvent<StoragePayload>): [BtreeState, Effect[]] {
  const p = event.payload;
  if (isFault(p)) return [applyFault(state, p.fault), []];
  if (isOp(p)) {
    if (p.op === 'get') return [btreeGet(state, p.key).state, []];
    if (p.op === 'put') return [applyWrite(state, p.key, p.val), []];
    if (p.op === 'delete') return [applyWrite(state, p.key, null), []];
  }
  return [state, []];
}

function applyFault(s: BtreeState, f: string): BtreeState {
  return s; // implemented in Task 8
}

export interface BtreeInspect {
  engine: 'btree';
  pages: Page[];
  rootId: string;
  height: number;
  walLen: number;
  phase: BtreeState['phase'];
  diskReads: number;
  diskWrites: number;
  bytesWritten: number;
  userBytes: number;
  lastReadCost: number;
  diskFull: boolean;
}

export function btreeInspect(s: BtreeState): BtreeInspect {
  return {
    engine: 'btree',
    pages: Object.values(s.pages),
    rootId: s.rootId,
    height: s.height,
    walLen: s.wal.length,
    phase: s.phase,
    diskReads: s.diskReads,
    diskWrites: s.diskWrites,
    bytesWritten: s.bytesWritten,
    userBytes: s.userBytes,
    lastReadCost: s.lastReadCost,
    diskFull: s.diskFull,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/btree.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/btree.ts src/modules/btree.test.ts
git commit -m "feat(modules): B-tree engine — redo WAL, in-place update, leaf split, height

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: btree.ts — storage faults (crash-mid-split / disk-full / torn page)

**Files:**
- Modify: `src/modules/btree.ts`
- Test: `src/modules/btree.test.ts` (add cases)

**Interfaces:**
- Consumes: Task 7 state; `isFault`.
- Produces: real `applyFault`:
  - `crash-mid-write`: `phase:'recovering'` then **rebuild the whole tree from the redo WAL** (replay every record with `applyWrite` into a fresh init) → every acked key survives, a torn split is discarded.
  - `disk-full`: set `diskFull:true` → `splitLeaf` already rejects while set (Task 7 guard); the overflowing put keeps the oversized leaf but the split is refused.
  - `recover`: clear `diskFull`; rebuild from WAL (repairs any torn structure).

- [ ] **Step 1: Write the failing test (append)**

```ts
// append to src/modules/btree.test.ts
const fault = (f: string) => ({ kind: 'external' as const, self: BTREE, time: 0, payload: { fault: f } });

test('crash-mid-write rebuilds every WAL-acked key from the redo log', () => {
  let s = btreeInit(cfg);
  for (let i = 0; i <= BTREE_ORDER; i++) s = btreeReduce(s, ev({ op: 'put', key: `k${i}`, val: String(i) }))[0];
  s = btreeReduce(s, fault('crash-mid-write'))[0];
  expect(s.phase).toBe('idle');
  for (let i = 0; i <= BTREE_ORDER; i++) expect(btreeGet(s, `k${i}`).value).toBe(String(i));
});

test('disk-full rejects the split that an overflow needs', () => {
  let s = btreeInit(cfg);
  s = btreeReduce(s, fault('disk-full'))[0];
  const pagesBefore = Object.keys(s.pages).length;
  for (let i = 0; i <= BTREE_ORDER; i++) s = btreeReduce(s, ev({ op: 'put', key: `k${i}`, val: String(i) }))[0];
  expect(s.diskFull).toBe(true);
  expect(Object.keys(s.pages).length).toBe(pagesBefore); // no new page allocated
});

test('recover clears disk-full and the tree is consistent', () => {
  let s = btreeInit(cfg);
  s = btreeReduce(s, fault('disk-full'))[0];
  for (let i = 0; i <= BTREE_ORDER; i++) s = btreeReduce(s, ev({ op: 'put', key: `k${i}`, val: String(i) }))[0];
  s = btreeReduce(s, fault('recover'))[0];
  expect(s.diskFull).toBe(false);
  for (let i = 0; i <= BTREE_ORDER; i++) expect(btreeGet(s, `k${i}`).value).toBe(String(i));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/btree.test.ts`
Expected: FAIL — `applyFault` is a stub.

- [ ] **Step 3: Write minimal implementation (replace the stub)**

```ts
/** Replay the redo WAL into a fresh tree — recovery + torn-structure repair. */
function rebuildFromWal(s: BtreeState): BtreeState {
  let fresh = btreeInit({ nodeIds: [s.self] });
  fresh = { ...fresh, diskCap: s.diskCap }; // keep config; diskFull cleared by recovery
  for (const r of s.wal) fresh = applyWrite(fresh, r.key, r.val);
  // preserve cumulative cost counters (the crash doesn't un-count past I/O)
  return {
    ...fresh,
    diskReads: s.diskReads,
    diskWrites: s.diskWrites,
    bytesWritten: s.bytesWritten,
    userBytes: s.userBytes,
    wal: s.wal,
    walAckSeq: s.walAckSeq,
    phase: 'idle',
  };
}

function applyFault(s: BtreeState, f: string): BtreeState {
  if (f === 'crash-mid-write') return rebuildFromWal({ ...s, phase: 'recovering' });
  if (f === 'disk-full') return { ...s, diskFull: true };
  if (f === 'recover') return rebuildFromWal({ ...s, diskFull: false });
  return s;
}
```

Note: `rebuildFromWal` calls `applyWrite`, which itself appends to the WAL — to avoid double-logging, replay against a fresh tree then overwrite `wal`/`walAckSeq` with the originals (as above). Verify the `disk-full` rebuild does not re-trigger splits by leaving `diskFull:false` during replay (splits allowed) — recovery restores full structure.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/btree.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/btree.ts src/modules/btree.test.ts
git commit -m "feat(modules): B-tree storage faults — WAL rebuild, disk-full split reject

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: btree.property.test.ts — get-cost=height, value-preserving, write-amp bounded, determinism

**Files:**
- Create: `src/modules/btree.property.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/btree.property.test.ts
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { btreeInit, btreeReduce, btreeGet, type BtreeState } from './btree';
import { STORAGE_TOPOLOGY, BTREE, writeAmp } from './storage-shared';

const cfg = { nodeIds: STORAGE_TOPOLOGY };
const ev = (payload: unknown) => ({ kind: 'external' as const, self: BTREE, time: 0, payload });

test('property: get matches a reference map after any put/delete sequence', () => {
  type Op = { op: 'put'; key: string; val: string } | { op: 'delete'; key: string };
  const key = fc.constantFrom(...'abcdefgh'.split(''));
  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ op: fc.constant<'put'>('put'), key, val: fc.string({ minLength: 1, maxLength: 3 }) }),
    fc.record({ op: fc.constant<'delete'>('delete'), key }),
  );
  fc.assert(
    fc.property(fc.array(opArb, { minLength: 1, maxLength: 40 }), (ops) => {
      let s: BtreeState = btreeInit(cfg);
      const ref = new Map<string, string | null>();
      for (const op of ops) {
        s = btreeReduce(s, ev(op))[0];
        ref.set(op.key, op.op === 'put' ? op.val : null);
      }
      for (const [k, v] of ref) expect(btreeGet(s, k).value).toBe(v ?? undefined);
    }),
    { numRuns: 150 },
  );
});

test('property: get cost never exceeds height', () => {
  fc.assert(
    fc.property(fc.array(fc.constantFrom(...'abcdefghij'.split('')), { minLength: 1, maxLength: 30 }), (keys) => {
      let s: BtreeState = btreeInit(cfg);
      for (const k of keys) s = btreeReduce(s, ev({ op: 'put', key: k, val: '1' }))[0];
      for (const k of keys) expect(btreeGet(s, k).state.lastReadCost).toBeLessThanOrEqual(s.height);
    }),
    { numRuns: 150 },
  );
});

test('property: B-tree write-amp stays bounded (< 4x) — no compaction rewrites', () => {
  fc.assert(
    fc.property(fc.array(fc.constantFrom(...'abcdefghij'.split('')), { minLength: 5, maxLength: 40 }), (keys) => {
      let s: BtreeState = btreeInit(cfg);
      for (const k of keys) s = btreeReduce(s, ev({ op: 'put', key: k, val: '1' }))[0];
      expect(writeAmp(s)).toBeLessThan(4);
    }),
    { numRuns: 100 },
  );
});

test('property: determinism — identical serialized state for identical op sequences', () => {
  fc.assert(
    fc.property(fc.array(fc.record({ key: fc.constantFrom('a', 'b', 'c', 'd'), val: fc.string({ maxLength: 2 }) }), { minLength: 1, maxLength: 30 }), (ops) => {
      const run = () => {
        let s: BtreeState = btreeInit(cfg);
        for (const o of ops) s = btreeReduce(s, ev({ op: 'put', ...o }))[0];
        return JSON.stringify(s);
      };
      expect(run()).toBe(run());
    }),
    { numRuns: 100 },
  );
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run src/modules/btree.property.test.ts`
Expected: PASS. If write-amp property fails, the split double-count in Task 7 is too aggressive — reconcile the byte accounting, don't relax the bound below the design's intent (B-tree must stay well under LSM).

- [ ] **Step 3: Commit**

```bash
git add src/modules/btree.property.test.ts
git commit -m "test(modules): B-tree properties — get-cost<=height, value-preserving, write-amp

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: storage.ts — SimModule dispatcher (both engines, one Simulation)

**Files:**
- Create: `src/modules/storage.ts`
- Test: `src/modules/storage.test.ts`

**Interfaces:**
- Consumes: `lsm.ts` (`lsmInit/lsmReduce/lsmInspect/lsmGet`, `LsmState`, `LsmInspect`), `btree.ts` (`btreeInit/btreeReduce/btreeInspect/btreeGet`, `BtreeState`, `BtreeInspect`), Task 1.
- Produces: `storage: SimModule<StorageState, StoragePayload>` with `id:'storage-engines'`, `chaos:['crash-mid-write','torn-write','disk-full']`, dispatch by `state.engine`/`nodeId`. `StorageState = LsmState | BtreeState`. `metrics` returns namespaced `lsm/*` and `btree/*` samples. Helpers `readValue(states, node, key)` for the challenge verifiers, `spaceAmpLsm`, `readAmpOf`.

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/storage.test.ts
import { expect, test } from 'vitest';
import { Simulation } from '../engine';
import { storage, type StorageState } from './storage';
import { STORAGE_TOPOLOGY, LSM, BTREE } from './storage-shared';

function fresh() {
  return new Simulation<StorageState>({ module: storage, config: { nodeIds: STORAGE_TOPOLOGY }, seed: 3000 });
}

test('dispatcher inits LSM and B-tree independently by nodeId', () => {
  const sim = fresh();
  sim.runSteps(2); // deliver both inits
  expect(sim.getState(LSM).engine).toBe('lsm');
  expect(sim.getState(BTREE).engine).toBe('btree');
});

test('the same op to both nodes lands in each engine without cross-leak', () => {
  const sim = fresh();
  sim.runSteps(2);
  sim.external(LSM, { op: 'put', key: 'a', val: '1' });
  sim.external(BTREE, { op: 'put', key: 'a', val: '1' });
  sim.runUntil(50);
  const lsm = storage.inspect(sim.getState(LSM)) as { engine: string; memtable: unknown[] };
  const bt = storage.inspect(sim.getState(BTREE)) as { engine: string; pages: unknown[] };
  expect(lsm.engine).toBe('lsm');
  expect(bt.engine).toBe('btree');
});

test('metrics are namespaced per engine', () => {
  const sim = fresh();
  sim.runSteps(2);
  sim.external(LSM, { op: 'put', key: 'a', val: '1' });
  sim.external(BTREE, { op: 'put', key: 'a', val: '1' });
  sim.runUntil(50);
  const states = new Map(STORAGE_TOPOLOGY.map((id) => [id, sim.getState(id)] as const));
  const names = storage.metrics(states, sim.time).map((m) => m.name);
  expect(names).toContain('lsm/write-amp');
  expect(names).toContain('btree/write-amp');
  expect(names).toContain('lsm/read-amp');
  expect(names).toContain('btree/read-amp');
});

test('the module emits no send effects for any op', () => {
  const sim = fresh();
  sim.runSteps(2);
  sim.external(LSM, { op: 'put', key: 'a', val: '1' });
  sim.external(BTREE, { op: 'put', key: 'a', val: '1' });
  sim.runUntil(50);
  // in-flight are only 'message' events; a local module schedules none
  expect(sim.inFlight()).toHaveLength(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/storage.test.ts`
Expected: FAIL — cannot find module `./storage`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/modules/storage.ts
import type { NodeId } from '../engine/events';
import type { InspectorTree, MetricSample, SimModule } from '../engine/module';
import {
  LSM, round2, writeAmp, type StoragePayload,
} from './storage-shared';
import { lsmInit, lsmReduce, lsmInspect, lsmGet, type LsmState } from './lsm';
import { btreeInit, btreeReduce, btreeInspect, btreeGet, type BtreeState } from './btree';

export type StorageState = LsmState | BtreeState;

/** Live (non-tombstone) key count an LSM holds — for space amplification. */
function lsmLiveKeys(s: LsmState): number {
  const seen = new Map<string, string | null>();
  for (const t of s.sstables) for (const e of t.entries) seen.set(e.key, e.val);
  for (const e of s.memtable) seen.set(e.key, e.val);
  return [...seen.values()].filter((v) => v !== null).length;
}
/** Physical entries the LSM stores (incl. tombstones + overlapping runs). */
function lsmPhysicalEntries(s: LsmState): number {
  return s.memtable.length + s.sstables.reduce((n, t) => n + t.entries.length, 0);
}

export function spaceAmpLsm(s: LsmState): number {
  const live = lsmLiveKeys(s);
  return live > 0 ? round2(lsmPhysicalEntries(s) / live) : 0;
}

export const storage: SimModule<StorageState, StoragePayload> = {
  id: 'storage-engines',
  chaos: ['crash-mid-write', 'torn-write', 'disk-full'],

  init(nodeId, config) {
    return nodeId === LSM ? lsmInit(config) : btreeInit(config);
  },

  reduce(state, event) {
    return state.engine === 'lsm'
      ? lsmReduce(state, event as Parameters<typeof lsmReduce>[1])
      : btreeReduce(state, event as Parameters<typeof btreeReduce>[1]);
  },

  metrics(states) {
    const out: MetricSample[] = [];
    for (const s of states.values()) {
      if (s.engine === 'lsm') {
        out.push({ name: 'lsm/write-amp', value: writeAmp(s) });
        out.push({ name: 'lsm/read-amp', value: s.lastReadCost });
        out.push({ name: 'lsm/space-amp', value: spaceAmpLsm(s) });
        out.push({ name: 'lsm/disk-writes', value: s.diskWrites });
      } else {
        out.push({ name: 'btree/write-amp', value: writeAmp(s) });
        out.push({ name: 'btree/read-amp', value: s.lastReadCost });
        out.push({ name: 'btree/height', value: s.height });
        out.push({ name: 'btree/disk-writes', value: s.diskWrites });
      }
    }
    return out;
  },

  inspect(state) {
    return (state.engine === 'lsm' ? lsmInspect(state) : btreeInspect(state)) as unknown as InspectorTree;
  },
};

/** Read a key from a node's engine — used by challenge verifiers (does not mutate the sim). */
export function readValue(states: Map<NodeId, StorageState>, node: NodeId, key: string): string | undefined {
  const s = states.get(node);
  if (!s) return undefined;
  return s.engine === 'lsm' ? lsmGet(s, key).value : btreeGet(s, key).value;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/storage.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/modules/storage.ts src/modules/storage.test.ts
git commit -m "feat(modules): storage dispatcher — one SimModule, LSM+B-tree by nodeId

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11: StorageScoreboard.tsx — the amplification numbers, side-by-side

**Files:**
- Create: `src/ui/labs/storage/StorageScoreboard.tsx`
- Test: `src/ui/labs/storage/StorageScoreboard.test.tsx`

**Interfaces:**
- Consumes: `LsmInspect` (`src/modules/lsm.ts`), `BtreeInspect` (`src/modules/btree.ts`), `writeAmp` + `round2` (`storage-shared`), `spaceAmpLsm` (`storage.ts`).
- Produces: `StorageScoreboard({ lsm, btree }: { lsm: LsmInspect; btree: BtreeInspect })` — a two-column table of disk reads, disk writes, write-amp, read-amp, space-amp/height.

- [ ] **Step 1: Write the failing test**

```tsx
// src/ui/labs/storage/StorageScoreboard.test.tsx
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { StorageScoreboard } from './StorageScoreboard';
import type { LsmInspect } from '../../../modules/lsm';
import type { BtreeInspect } from '../../../modules/btree';

const lsm: LsmInspect = {
  engine: 'lsm', memtable: [], sstables: [], walLen: 0, phase: 'idle',
  diskReads: 3, diskWrites: 10, bytesWritten: 64, userBytes: 16, lastReadCost: 2, bloomSkips: 1, diskFull: false,
};
const btree: BtreeInspect = {
  engine: 'btree', pages: [], rootId: 'p0', height: 2, walLen: 0, phase: 'idle',
  diskReads: 2, diskWrites: 4, bytesWritten: 18, userBytes: 16, lastReadCost: 2, diskFull: false,
};

test('renders both engines and the write-amp contrast', () => {
  render(<StorageScoreboard lsm={lsm} btree={btree} />);
  expect(screen.getByText(/LSM-tree/i)).toBeInTheDocument();
  expect(screen.getByText(/B-tree/i)).toBeInTheDocument();
  expect(screen.getByText('4')).toBeInTheDocument(); // lsm write-amp 64/16
  expect(screen.getByText('1.13')).toBeInTheDocument(); // btree write-amp 18/16
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/labs/storage/StorageScoreboard.test.tsx`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```tsx
// src/ui/labs/storage/StorageScoreboard.tsx
import type { LsmInspect } from '../../../modules/lsm';
import type { BtreeInspect } from '../../../modules/btree';
import { writeAmp } from '../../../modules/storage-shared';
import { spaceAmpLsm } from '../../../modules/storage';

function Cell({ children, warn }: { children: React.ReactNode; warn?: boolean }) {
  return <td className={`px-3 py-1 text-right font-mono ${warn ? 'text-warn font-bold' : 'text-fg'}`}>{children}</td>;
}

export function StorageScoreboard({ lsm, btree }: { lsm: LsmInspect; btree: BtreeInspect }) {
  const lsmWA = writeAmp(lsm);
  const btWA = writeAmp(btree);
  const rows: [string, React.ReactNode, React.ReactNode][] = [
    ['disk reads (cum.)', lsm.diskReads, btree.diskReads],
    ['disk writes (cum.)', lsm.diskWrites, btree.diskWrites],
    ['write-amp', <Cell key="l" warn={lsmWA > btWA}>{lsmWA}</Cell>, <Cell key="b">{btWA}</Cell>],
    ['read-amp (last get)', lsm.lastReadCost, btree.lastReadCost],
    ['space-amp / height', spaceAmpLsm(lsm as never) || '—', btree.height],
  ];
  return (
    <table className="border border-line bg-panel rounded text-xs">
      <thead>
        <tr className="text-dim">
          <th className="px-3 py-1 text-left">metric</th>
          <th className="px-3 py-1 text-right">LSM-tree</th>
          <th className="px-3 py-1 text-right">B-tree</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, l, b]) => (
          <tr key={label} className="border-t border-line">
            <td className="px-3 py-1 text-left text-dim">{label}</td>
            {typeof l === 'object' ? l : <Cell>{l}</Cell>}
            {typeof b === 'object' ? b : <Cell>{b}</Cell>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

Note on `spaceAmpLsm(lsm as never)`: `spaceAmpLsm` takes an `LsmState`, but the scoreboard only holds an `LsmInspect`. Refactor `spaceAmpLsm` to accept the fields it needs, OR compute space-amp inside `lsmInspect` and expose `spaceAmp` on `LsmInspect`. **Cleaner: add `spaceAmp: number` to `LsmInspect` in Task 2/10 and read `lsm.spaceAmp` here.** Update the test's `lsm` fixture to include `spaceAmp`. Do this refactor now rather than casting.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/labs/storage/StorageScoreboard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/labs/storage/StorageScoreboard.tsx src/ui/labs/storage/StorageScoreboard.test.tsx src/modules/lsm.ts
git commit -m "feat(ui): storage scoreboard — write/read/space-amp side-by-side

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 12: LsmView.tsx — memtable bar + SSTable levels + bloom + phase

**Files:**
- Create: `src/ui/labs/storage/LsmView.tsx`
- Test: `src/ui/labs/storage/LsmView.test.tsx`

**Interfaces:**
- Consumes: `LsmInspect`, `MEMTABLE_CAP`.
- Produces: `LsmView({ inspect }: { inspect: LsmInspect })` rendering memtable fill (`n/CAP`), L0/L1 runs (entry count + bloom badge), and a phase indicator (`flushing`/`compacting`/`recovering`).

- [ ] **Step 1: Write the failing test**

```tsx
// src/ui/labs/storage/LsmView.test.tsx
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { LsmView } from './LsmView';
import type { LsmInspect } from '../../../modules/lsm';

const base: LsmInspect = {
  engine: 'lsm', memtable: [{ key: 'a', val: '1' }], sstables: [{ level: 0, entries: [{ key: 'b', val: '2' }], bloom: [1, 2], min: 'b', max: 'b' }],
  walLen: 1, phase: 'idle', diskReads: 0, diskWrites: 1, bytesWritten: 16, userBytes: 16, lastReadCost: 0, bloomSkips: 0, spaceAmp: 1, diskFull: false,
};

test('shows memtable fill and an L0 run', () => {
  render(<LsmView inspect={base} />);
  expect(screen.getByText(/memtable/i)).toBeInTheDocument();
  expect(screen.getByText(/L0/)).toBeInTheDocument();
});

test('shows the current phase when not idle', () => {
  render(<LsmView inspect={{ ...base, phase: 'compacting' }} />);
  expect(screen.getByText(/compacting/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to fail, 3: implement, 4: pass**

Implement (`src/ui/labs/storage/LsmView.tsx`):

```tsx
import type { LsmInspect } from '../../../modules/lsm';
import { MEMTABLE_CAP } from '../../../modules/storage-shared';

export function LsmView({ inspect }: { inspect: LsmInspect }) {
  const l0 = inspect.sstables.filter((t) => t.level === 0);
  const l1 = inspect.sstables.filter((t) => t.level === 1);
  return (
    <div className="border border-line bg-panel rounded p-3 space-y-2 text-xs font-mono min-w-56">
      <div className="flex items-center justify-between">
        <span className="font-bold text-fg">LSM-tree</span>
        {inspect.phase !== 'idle' && <span className="text-warn">{inspect.phase}…</span>}
        {inspect.diskFull && <span className="text-coral">disk full</span>}
      </div>
      <div className="text-dim">
        memtable {inspect.memtable.length}/{MEMTABLE_CAP}
        <div className="h-2 bg-ink rounded mt-0.5">
          <div className="h-2 bg-set rounded" style={{ width: `${Math.min(100, (inspect.memtable.length / (MEMTABLE_CAP + 1)) * 100)}%` }} />
        </div>
      </div>
      {[['L0', l0], ['L1', l1]].map(([label, runs]) => (
        <div key={label as string} className="space-y-0.5">
          {(runs as typeof l0).map((t, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="text-dim w-6">{label as string}</span>
              <span className="text-fg">[{t.entries.length} keys · {t.min}…{t.max}]</span>
              <span className="text-accent" title={`bloom bits: ${t.bloom.join(',')}`}>bloom</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
```

Run: `npx vitest run src/ui/labs/storage/LsmView.test.tsx` → PASS. (If `text-coral`/`text-accent` aren't in the theme, use `text-warn`/`text-dim` — check `src/ui/kit/classes.ts` / existing views for the sign tokens.)

- [ ] **Step 5: Commit**

```bash
git add src/ui/labs/storage/LsmView.tsx src/ui/labs/storage/LsmView.test.tsx
git commit -m "feat(ui): LsmView — memtable bar, SSTable levels, bloom, phase

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 13: BtreeView.tsx — page tree + split + height readout

**Files:**
- Create: `src/ui/labs/storage/BtreeView.tsx`
- Test: `src/ui/labs/storage/BtreeView.test.tsx`

**Interfaces:**
- Consumes: `BtreeInspect`.
- Produces: `BtreeView({ inspect }: { inspect: BtreeInspect })` rendering the root index and leaf pages (keys per page), height, and phase.

- [ ] **Step 1: Failing test**

```tsx
// src/ui/labs/storage/BtreeView.test.tsx
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { BtreeView } from './BtreeView';
import type { BtreeInspect } from '../../../modules/btree';

const base: BtreeInspect = {
  engine: 'btree',
  pages: [
    { id: 'p2', leaf: false, keys: ['k2'], vals: [], children: ['p0', 'p1'] },
    { id: 'p0', leaf: true, keys: ['k0', 'k1'], vals: ['0', '1'], children: [] },
    { id: 'p1', leaf: true, keys: ['k2', 'k3'], vals: ['2', '3'], children: [] },
  ],
  rootId: 'p2', height: 2, walLen: 4, phase: 'idle', diskReads: 0, diskWrites: 6, bytesWritten: 40, userBytes: 32, lastReadCost: 2, diskFull: false,
};

test('renders height and leaf keys', () => {
  render(<BtreeView inspect={base} />);
  expect(screen.getByText(/height 2/i)).toBeInTheDocument();
  expect(screen.getByText(/k0/)).toBeInTheDocument();
  expect(screen.getByText(/k3/)).toBeInTheDocument();
});
```

- [ ] **Steps 2–4: fail → implement → pass**

```tsx
// src/ui/labs/storage/BtreeView.tsx
import type { BtreeInspect } from '../../../modules/btree';

export function BtreeView({ inspect }: { inspect: BtreeInspect }) {
  const root = inspect.pages.find((p) => p.id === inspect.rootId);
  const leaves = inspect.pages.filter((p) => p.leaf).sort((a, b) => (a.keys[0] ?? '') < (b.keys[0] ?? '') ? -1 : 1);
  return (
    <div className="border border-line bg-panel rounded p-3 space-y-2 text-xs font-mono min-w-56">
      <div className="flex items-center justify-between">
        <span className="font-bold text-fg">B-tree · height {inspect.height}</span>
        {inspect.phase !== 'idle' && <span className="text-warn">{inspect.phase}…</span>}
        {inspect.diskFull && <span className="text-coral">disk full</span>}
      </div>
      {root && !root.leaf && (
        <div className="text-dim">root [{root.keys.join(' | ')}]</div>
      )}
      <div className="flex flex-wrap gap-2">
        {leaves.map((p) => (
          <div key={p.id} className="border border-line rounded px-2 py-1 text-fg">
            {p.keys.map((k, i) => (p.vals[i] === null ? <s key={k} className="text-dim">{k}</s> : <span key={k}>{k} </span>))}
          </div>
        ))}
      </div>
    </div>
  );
}
```

Run: `npx vitest run src/ui/labs/storage/BtreeView.test.tsx` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/labs/storage/BtreeView.tsx src/ui/labs/storage/BtreeView.test.tsx
git commit -m "feat(ui): BtreeView — root index, leaf pages, height, split phase

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 14: StorageFaultBar.tsx — inject storage faults as external events

**Files:**
- Create: `src/ui/labs/storage/StorageFaultBar.tsx`
- Test: `src/ui/labs/storage/StorageFaultBar.test.tsx`

**Interfaces:**
- Consumes: `StorageFault` (`storage-shared`).
- Produces: `StorageFaultBar({ onFault }: { onFault: (fault: StorageFault['fault']) => void })` — one button per fault (`crash-mid-write`, `torn-write`, `disk-full`, `recover`). The lab wires `onFault` to fire the fault at **both** nodes via `driver.external`. (ChaosToolbar is not used here: it only speaks `ControlAction`, whereas storage faults are `external` events.)

- [ ] **Step 1: Failing test**

```tsx
// src/ui/labs/storage/StorageFaultBar.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { StorageFaultBar } from './StorageFaultBar';

test('each fault button fires its fault name', () => {
  const onFault = vi.fn();
  render(<StorageFaultBar onFault={onFault} />);
  fireEvent.click(screen.getByRole('button', { name: /crash mid-write/i }));
  expect(onFault).toHaveBeenCalledWith('crash-mid-write');
  fireEvent.click(screen.getByRole('button', { name: /disk full/i }));
  expect(onFault).toHaveBeenCalledWith('disk-full');
});
```

- [ ] **Steps 2–4**

```tsx
// src/ui/labs/storage/StorageFaultBar.tsx
import type { StorageFault } from '../../../modules/storage-shared';
import { btn } from '../../kit/classes';

const FAULTS: { fault: StorageFault['fault']; label: string }[] = [
  { fault: 'crash-mid-write', label: 'crash mid-write' },
  { fault: 'torn-write', label: 'torn write' },
  { fault: 'disk-full', label: 'disk full' },
  { fault: 'recover', label: 'recover' },
];

export function StorageFaultBar({ onFault }: { onFault: (fault: StorageFault['fault']) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
      <span className="text-dim">storage fault (both engines):</span>
      {FAULTS.map((f) => (
        <button key={f.fault} className={btn} onClick={() => onFault(f.fault)}>
          {f.label}
        </button>
      ))}
    </div>
  );
}
```

Run: `npx vitest run src/ui/labs/storage/StorageFaultBar.test.tsx` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/labs/storage/StorageFaultBar.tsx src/ui/labs/storage/StorageFaultBar.test.tsx
git commit -m "feat(ui): StorageFaultBar — crash/torn/disk-full as external fault events

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 15: StorageLab.tsx — assemble the lab (driver, controls, views, 3 challenges)

**Files:**
- Create: `src/ui/labs/storage/StorageLab.tsx`
- Test: `src/ui/labs/storage/StorageLab.test.tsx`

**Interfaces:**
- Consumes: `storage`, `readValue`, `StorageState` (`storage.ts`); `LsmInspect`/`BtreeInspect`; the four storage components; kit `KVControls`, `TimelineScrubber`, `MetricsPanel`, `ChallengePanel`; bridge `Simulation`, `SimDriver`, `useSimStore`.
- Produces: `StorageLab()` — the mounted lab page (referenced by `App` PAGES `3.1`).

Behaviour:
- Build the `Simulation`+`SimDriver` in a `useEffect` (driver-in-effect pattern), seed `3000 + epoch`, no network options needed (`{}`), reset the store, `return () => d.pause()`.
- `writeBoth(key,val)` / `deleteBoth(key)` / `getBoth(key)` → `driver.external(LSM, op)` **and** `driver.external(BTREE, op)`; a "bulk-load N" button issues N sequential puts to both.
- `faultBoth(f)` → `driver.external(LSM,{fault:f})` and `driver.external(BTREE,{fault:f})`.
- Render `LsmView` ‖ `BtreeView` from the published `view.nodes` inspects, `StorageScoreboard`, `MetricsPanel` (`view.metricsHistory`), `TimelineScrubber`, `StorageFaultBar`, `KVControls` (writeTargets/readTargets can be a single synthetic "both" — simplest: custom buttons instead of KVControls' per-node buttons; use KVControls with `writeTargets={['both']}` mapping onWrite to `writeBoth`). Provide a `statesOf()` for verifiers.
- Three `ChallengePanel`s with verifiers using `readValue` + inspects:
  1. **crash-mid-write**: prompt "put a key on both, crash mid-write, then confirm it survived recovery". `check`: after any `crash-mid-write` fault processed, both engines still return the last WAL-acked key → win. Track the probe key in component state.
  2. **disk-full**: prompt "fill the disk and stall a compaction / reject a split". `check`: `lsmInspect.diskFull && btreeInspect.diskFull` and LSM L0 length ≥ `L0_TRIGGER` (compaction stalled) → win.
  3. **torn-write**: prompt "tear a write and detect the corruption". `check`: an LSM SSTable has `torn:true` at some processed step → win (then `recover` repairs).

- [ ] **Step 1: Write the failing test**

```tsx
// src/ui/labs/storage/StorageLab.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { expect, test } from 'vitest';
import { StorageLab } from './StorageLab';

test('mounts with both engines and the scoreboard', async () => {
  render(<StorageLab />);
  expect(await screen.findByText('LSM-tree')).toBeInTheDocument();
  expect(screen.getAllByText(/B-tree/).length).toBeGreaterThan(0);
  expect(screen.getByText(/write-amp/i)).toBeInTheDocument();
});

test('a write button issues ops without crashing', () => {
  render(<StorageLab />);
  const write = screen.getByRole('button', { name: /write/i });
  fireEvent.click(write);
  expect(write).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/ui/labs/storage/StorageLab.test.tsx`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement `StorageLab.tsx`**

Follow `HashRingLab.tsx` structure exactly (driver-in-effect, render from `useSimStore` view, `statesOf` for verifiers). Full component:

```tsx
// src/ui/labs/storage/StorageLab.tsx
import { useEffect, useState } from 'react';
import { Simulation, type NodeId } from '../../../engine';
import { storage, readValue, type StorageState } from '../../../modules/storage';
import { LSM, BTREE, STORAGE_TOPOLOGY, L0_TRIGGER, type StorageFault } from '../../../modules/storage-shared';
import type { LsmInspect } from '../../../modules/lsm';
import type { BtreeInspect } from '../../../modules/btree';
import { SimDriver } from '../../bridge/SimDriver';
import { useSimStore } from '../../bridge/simStore';
import { ChallengePanel } from '../../kit/ChallengePanel';
import { MetricsPanel } from '../../kit/MetricsPanel';
import { TimelineScrubber } from '../../kit/TimelineScrubber';
import { btn, inputBox } from '../../kit/classes';
import { LsmView } from './LsmView';
import { BtreeView } from './BtreeView';
import { StorageScoreboard } from './StorageScoreboard';
import { StorageFaultBar } from './StorageFaultBar';

export function StorageLab() {
  const [epoch, setEpoch] = useState(0);
  const [key, setKey] = useState('k0');
  const [val, setVal] = useState('1');
  const [nextBulk, setNextBulk] = useState(0);
  const [probe, setProbe] = useState<{ key: string; val: string } | null>(null);
  const [driver, setDriver] = useState<SimDriver<StorageState> | null>(null);

  useEffect(() => {
    useSimStore.getState().reset();
    const seed = 3000 + epoch;
    const sim = new Simulation<StorageState>({ module: storage, config: { nodeIds: STORAGE_TOPOLOGY }, seed });
    const d = new SimDriver({ sim, seed, publish: (v) => useSimStore.getState().publish(v) });
    setDriver(d);
    setNextBulk(0);
    setProbe(null);
    return () => d.pause();
  }, [epoch]);

  const view = useSimStore();
  if (!driver) return null;

  const statesOf = () => new Map<NodeId, StorageState>(STORAGE_TOPOLOGY.map((id) => [id, driver.sim.getState(id)] as const));
  const both = (payload: unknown) => {
    driver.external(LSM, payload);
    driver.external(BTREE, payload);
  };
  const faultBoth = (f: StorageFault['fault']) => both({ fault: f });

  const inspects = new Map(view.nodes.map((n) => [n.id, n.inspect]));
  const lsm = inspects.get(LSM) as unknown as LsmInspect | undefined;
  const btree = inspects.get(BTREE) as unknown as BtreeInspect | undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
        <button className={btn} onClick={() => setEpoch((e) => e + 1)}>reset (new seed)</button>
        <span className="text-dim">same key/value drives both engines</span>
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
        {lsm && <LsmView inspect={lsm} />}
        {btree && <BtreeView inspect={btree} />}
        <MetricsPanel history={view.metricsHistory} />
      </div>

      {lsm && btree && <StorageScoreboard lsm={lsm} btree={btree} />}

      <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
        <input className={`w-16 ${inputBox}`} value={key} onChange={(e) => setKey(e.target.value)} aria-label="key" />
        <input className={`w-16 ${inputBox}`} value={val} onChange={(e) => setVal(e.target.value)} aria-label="value" />
        <button className={btn} onClick={() => { both({ op: 'put', key, val }); setProbe({ key, val }); }}>write</button>
        <button className={btn} onClick={() => both({ op: 'get', key })}>read</button>
        <button className={btn} onClick={() => both({ op: 'delete', key })}>delete</button>
        <button className={btn} onClick={() => { for (let i = 0; i < 8; i++) both({ op: 'put', key: `b${nextBulk + i}`, val: 'v' }); setNextBulk((n) => n + 8); }}>bulk +8</button>
      </div>

      <StorageFaultBar onFault={faultBoth} />

      <ChallengePanel
        title="Chaos: crash mid-write — what does the WAL save?"
        storageKeyPrefix="ddia:ch03:crash"
        prompt="Write a key, then hit 'crash mid-write'. Predict: does the key survive on each engine?"
        runningHint="write a key (both engines), then crash mid-write, then read it back."
        check={() => {
          if (!probe) return null;
          const s = statesOf();
          const ok = readValue(s, LSM, probe.key) === probe.val && readValue(s, BTREE, probe.key) === probe.val;
          const crashed = (driver.sim.getState(LSM) as LsmInspect | StorageState);
          return ok && view.processed > 0 ? { key: probe.key } : null;
        }}
        onWin={() => driver.pause()}
        renderWin={(w, prediction) => (
          <>
            <p>key <code className="text-set">{w.key}</code> survived on both engines — the WAL replayed it after the crash. Volatile memtable / uncommitted split pages were lost; the log was not.</p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />

      <ChallengePanel
        title="Chaos: disk full — compaction stalls, splits fail"
        storageKeyPrefix="ddia:ch03:diskfull"
        prompt="Fill the disk, then bulk-load. Predict: which engine degrades, which rejects?"
        runningHint="hit 'disk full', then 'bulk +8' a few times."
        check={() => {
          const l = driver.sim.getState(LSM);
          const b = driver.sim.getState(BTREE);
          const lFull = l.engine === 'lsm' && l.diskFull;
          const bFull = b.engine === 'btree' && b.diskFull;
          const stalled = l.engine === 'lsm' && l.sstables.filter((t) => t.level === 0).length >= L0_TRIGGER;
          return lFull && bFull && stalled ? { stalled: true } : null;
        }}
        onWin={() => driver.pause()}
        renderWin={(_w, prediction) => (
          <>
            <p>LSM keeps serving but read-amp climbs — compaction needs headroom it doesn't have, so L0 piles up. The B-tree refused the split outright. Space vs availability, made concrete.</p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />

      <ChallengePanel
        title="Chaos: torn write — detect the corruption"
        storageKeyPrefix="ddia:ch03:torn"
        prompt="Flush a run, then tear a write. Predict: is the corruption detected or silently served?"
        runningHint="bulk-load to flush an SSTable, then 'torn write', then 'recover'."
        check={() => {
          const l = driver.sim.getState(LSM);
          return l.engine === 'lsm' && l.sstables.some((t) => t.torn) ? { torn: true } : null;
        }}
        onWin={() => driver.pause()}
        renderWin={(_w, prediction) => (
          <>
            <p>the torn run is flagged, not served as truth — <code>recover</code> rebuilds it from the WAL. A checksum is what turns silent corruption into a detectable fault.</p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />
    </div>
  );
}
```

Note: expose `torn?: boolean` on the `LsmInspect.sstables` shape (it's the same `SSTable[]`), so the torn check reads it via the live state (`driver.sim.getState`) — the verifiers read live `sim` state (like HashRingLab's `statesOf`), not the published view, so they always see the freshest engine state.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/labs/storage/StorageLab.test.tsx`
Expected: PASS (2 tests). Fix any act() warnings by awaiting `findBy*` as shown.

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/ui/labs/storage/StorageLab.tsx src/ui/labs/storage/StorageLab.test.tsx
git commit -m "feat(ui): StorageLab — side-by-side LSM/B-tree, 3 storage-chaos challenges

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 16: Wire-up — debrief, catalog, App PAGES, README, DESIGN_PLAN

**Files:**
- Create: `content/ch03/debrief.mdx`
- Create: `src/ui/labs/storage/Debrief.tsx`
- Modify: `src/ui/shell/catalog.ts` (3.1, 3.d → `active`)
- Modify: `src/ui/App.tsx` (PAGES `3.1`, `3.d`)
- Modify: `README.md`
- Modify: `docs/DESIGN_PLAN.en.md`
- Test: `src/ui/shell/catalog.test.ts` already enforces book order — must stay green.

**Interfaces:**
- Consumes: `DebriefArticle`, `SurpriseJournal`, `StorageLab`.

- [ ] **Step 1: Write the debrief content**

Create `content/ch03/debrief.mdx` (follow `content/ch06/debrief.mdx` voice — an `# H1` that's hidden by `DebriefArticle`, then `## H2` sections). Cover: (1) why LSM writes are cheap but reads pay (multi-run probe + bloom), (2) why compaction is the price of sequential writes = write amplification, (3) why B-tree reads are shallow but every write is a random in-place page write + WAL, (4) what the WAL saved in the crash challenge, (5) space vs availability under disk-full. End with a one-line "the trade-off you just measured."

- [ ] **Step 2: Create `Debrief.tsx`**

```tsx
// src/ui/labs/storage/Debrief.tsx
import DebriefContent from '../../../../content/ch03/debrief.mdx';
import { DebriefArticle } from '../../kit/DebriefArticle';
import { SurpriseJournal } from '../../kit/SurpriseJournal';

export function StorageDebrief() {
  return (
    <DebriefArticle>
      <DebriefContent />
      <SurpriseJournal storageKey="ddia:ch03:journal" />
    </DebriefArticle>
  );
}
```

- [ ] **Step 3: Flip catalog entries to active**

In `src/ui/shell/catalog.ts`, replace the `ch3` block:

```ts
  {
    id: 'ch3',
    title: 'Ch.3 — Storage Engines',
    labs: [
      { id: '3.1', label: 'LSM-Tree vs B-Tree', status: 'active' },
      { id: '3.d', label: 'Debrief & Journal', status: 'active' },
    ],
  },
```

- [ ] **Step 4: Register App PAGES**

In `src/ui/App.tsx`, add imports and two PAGES entries:

```tsx
import { StorageLab } from './labs/storage/StorageLab';
import { StorageDebrief } from './labs/storage/Debrief';
```

```tsx
  '3.1': {
    eyebrow: 'Chapter 3 — Storage Engines',
    title: 'LSM-Tree vs B-Tree',
    thesis:
      'The same keys drive two engines at once. The LSM-tree buffers writes in memory and flushes sorted runs, paying later in compaction; the B-tree updates pages in place, paying up front in random writes. Watch write-amp, read-amp, and space-amp diverge — then crash them mid-write and see what the WAL saves.',
    Component: StorageLab,
  },
  '3.d': {
    eyebrow: 'Chapter 3 — Debrief',
    title: 'Why the numbers diverged',
    thesis:
      'Write-optimised vs read-optimised is not a slogan — it is the compaction bytes and the page traversals you just counted. Plus what durability actually cost.',
    Component: StorageDebrief,
  },
```

- [ ] **Step 5: Run the catalog test + full suite + typecheck**

Run: `npx vitest run src/ui/shell/catalog.test.ts && npx tsc --noEmit`
Expected: PASS (book order holds; 3.1/3.d active).

Run the whole suite to be sure nothing regressed:
Run: `npx vitest run`
Expected: all green.

- [ ] **Step 6: Update README + DESIGN_PLAN**

- `README.md`: add Ch3 to the shipped-labs list (mirror the Ch6/Ch11 lines): "Ch3 — Storage Engines (3.1 LSM vs B-tree side-by-side, 3.d debrief)".
- `docs/DESIGN_PLAN.en.md`: check off Phase 2 (Storage engines / Ch3) as shipped.

- [ ] **Step 7: Commit**

```bash
git add content/ch03/debrief.mdx src/ui/labs/storage/Debrief.tsx src/ui/shell/catalog.ts src/ui/App.tsx README.md docs/DESIGN_PLAN.en.md
git commit -m "feat(ui): ship Ch3 storage lab — debrief, catalog 3.1/3.d active, roadmap

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- §1 three modules → Tasks 1 (shared), 2–6 (lsm), 7–9 (btree), 10 (dispatcher). ✓
- §2 engine-unchanged, external ops to both, zero send, timer flush/compaction → Tasks 2–4 (timers), 10 (`inFlight()===0` test asserts no send), 15 (`both()` mirrors ops). ✓
- §2 storage faults as external events → Tasks 5, 8, 14 (`StorageFaultBar` → `external`). ✓
- §3 LSM memtable/WAL/flush/compaction/bloom/tombstone/read-amp → Tasks 2–5. ✓
- §4 B-tree pages/split/height/WAL/read-amp=height/in-place delete → Tasks 7–8. ✓
- §5 three challenges → Task 15 (three `ChallengePanel`s with verifiers). ✓
- §6 metrics scoreboard (write/read/space-amp, bloom skips) → Tasks 10 (metrics), 11 (scoreboard). ✓
- §7 UI (StorageLab, LsmView, BtreeView, scoreboard, debrief, catalog, PAGES) → Tasks 11–16. ✓
- §8 tests (unit + property + determinism + pinned lesson) → Tasks 2–9; **pinned lesson test** (LSM write-amp > B-tree write-amp; B-tree read-amp < LSM read-amp) is covered by the property `writeAmp < 4` for B-tree + LSM compaction growth, but the explicit *cross-engine* pinned assertion is not yet its own test. **Gap fix:** add a `storage.test.ts` case in Task 10 asserting, after a standard 24-key bulk-load driven through a `Simulation`, `lsm/write-amp > btree/write-amp`. (Add this now.)
- §9 file plan → matches Tasks 1–16. ✓ (`content/ch3`→`content/ch03`, ChaosToolbar→StorageFaultBar refinements noted.)

**Gap fix applied:** Task 10 gains a fifth test — the pinned cross-engine lesson:

```ts
test('pinned lesson: after a bulk load, LSM write-amp exceeds B-tree write-amp', () => {
  const sim = fresh();
  sim.runSteps(2);
  for (let i = 0; i < 24; i++) {
    sim.external(LSM, { op: 'put', key: `k${i}`, val: 'v' });
    sim.external(BTREE, { op: 'put', key: `k${i}`, val: 'v' });
  }
  sim.runUntil(5000); // drain flushes + compactions
  const states = new Map(STORAGE_TOPOLOGY.map((id) => [id, sim.getState(id)] as const));
  const m = Object.fromEntries(storage.metrics(states, sim.time).map((s) => [s.name, s.value]));
  expect(m['lsm/write-amp']).toBeGreaterThan(m['btree/write-amp']);
});
```

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". Task 7's `applyFault` is an intentional stub with an inline comment pointing to Task 8, and Task 8 replaces it — flagged, not hidden. ✓

**3. Type consistency:**
- `Entry = {key,val:string|null}`, `SSTable` (+`torn?`), `LsmState`, `LsmInspect` (+`spaceAmp` added in Task 11 refactor) — consistent across Tasks 2–5, 11, 12.
- `Page = {id,leaf,keys,vals,children}`, `BtreeState`, `BtreeInspect` — consistent Tasks 7–13.
- `StoragePayload` (`StorageOp | StorageFault | StorageTimer | null`), guards `isOp/isFault/isTimer` — used identically in `lsm.ts`, `btree.ts`, `StorageFaultBar`. ✓
- `storage.metrics` names (`lsm/write-amp`, `btree/write-amp`, …) match the scoreboard/pinned-test reads. ✓
- **One fix:** `LsmInspect` must include `spaceAmp: number` (added Task 11) — ensure Task 2's `lsmInspect` and its test fixtures carry it. Propagate to the Task 6 property test only if it reads inspect (it does not). ✓

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-14-ch3-storage-engines.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — a fresh Sonnet `coder` subagent per task (16 tasks), two-stage review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session via executing-plans, batched with checkpoints.

**Which approach?**
