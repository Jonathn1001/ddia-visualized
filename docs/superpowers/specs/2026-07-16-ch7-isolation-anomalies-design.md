# Ch7.1 — Isolation Anomaly Lab (four isolation levels, side-by-side) — Design

**Status:** APPROVED (brainstorm 2026-07-16; user delegated remaining decisions —
"pick the most suitable"). Not yet built.

**Goal:** Ship DDIA Chapter 7 (Transactions) as one interactive lab that replays the
**same transaction schedule** under **four isolation levels simultaneously** — Read
Uncommitted, Read Committed, Snapshot Isolation, Serializable — in four lockstep panels.
Each of the three preset schedules is engineered to trigger one classic anomaly (dirty
read, lost update, write skew); the learner steps the schedule op-by-op and watches the
anomaly appear in the weak panels and die at a successive isolation rung. The ladder is
the lesson: each level buys off exactly one class of race, and only Serializable buys
them all.

Builds on the Phase-0 engine + Phase-1 kit. Roadmap slots `7.1` ("Isolation Anomaly
Lab") and `7.d` (debrief) → `active`. Second non-network lab after Ch3: zero `send`
effects, schedule driven entirely by `external` events.

**Design deviation (documented):** the brainstorm option said "three panels
RC/SI/Serializable", but a dirty read is *invisible* at Read Committed and above — the
floor rung must be Read Uncommitted for challenge 1 to show anything. Four panels, not
three. The approved core-trio anomaly scope is unchanged.

---

## 1. Scope

**In:**
- Two new pure modules (contract v0.2):
  - `src/modules/txn-shared.ts` — level/op/anomaly types, the three preset schedules,
    anomaly detectors, shared constants.
  - `src/modules/txn.ts` — one `SimModule` whose per-node state is a full
    level-parameterized transaction engine; `nodeIds: ['RU','RC','SI','SER']` select the
    semantics. One engine, four behavior profiles (unlike Ch3's two distinct engines,
    the levels share ~80% of their mechanics — one parameterized reducer is the honest
    factoring).
- New lab page `src/ui/labs/txn/TxnLab.tsx` (7.1): 4-panel grid, `SchedulePanel`
  (preset picker + op list + step/play/reset), `TxnScoreboard`, `ChallengePanel`
  (3 challenges), `TimelineScrubber`.
- `IsolationPanel.tsx` — one panel per level, rendered ×4 from config: per-txn status
  (active / committed / aborted / **waiting** for SER), KV store with per-key committed
  value + uncommitted overlay (RU) / versions (SI), anomaly badges.
- Ch7 debrief: `content/ch7/debrief.mdx` + `src/ui/labs/txn/Debrief.tsx` (7.d), journal
  key `ddia:ch7:journal`, via shared `DebriefArticle` / `SurpriseJournal`.
- Catalog + routing: `7.1`, `7.d` → `active`; App PAGES `'7.1'`, `'7.d'`.
- Unit + property tests for the engine per level; view render tests; a pinned lesson
  test guarding the full challenge outcome matrix (§6).

**Out (explicitly deferred):**
- Two-phase locking as the Serializable implementation (blocking + deadlock detection).
  SER = **actual serial execution** (DDIA §7's first serializable technique): far
  smaller, and the "as if one at a time" visual is the clearest possible contrast.
- SSI (detecting rw-antidependencies) — mentioned in the debrief only.
- Free-form schedule composition (op palette). Presets + step-through only.
- Phantoms / range queries / predicate locks (point reads and writes only).
- More than 2 concurrent transactions per schedule.
- Explicit row locks at RC (RC here = "reads see last committed value"; write-write
  blocking is not modeled — both writers proceed, which is exactly what makes the lost
  update visible at RC).

---

## 2. Architecture — same schedule, four interpreters

One `Simulation<TxnState>`, config `nodeIds: ['RU','RC','SI','SER']`, module = `txn`.

**Schedule model.** A preset is an ordered list of steps: `{ txn: 'T1'|'T2', op: Op }`
where
```ts
type Op =
  | { op: 'begin' }
  | { op: 'read';  key: string }
  | { op: 'write'; key: string; value: number | { inc: number } }
      // {inc:n} = "the value this txn last read for this key, plus n" — lets the
      // lost-update preset stay declarative while SER shows the correct final value
  | { op: 'ensure'; keys: string[]; atLeast: number }  // app-level check-then-act:
      // read all keys; if sum < atLeast, the txn aborts itself (the write-skew guard)
  | { op: 'commit' }
  | { op: 'abort' };
```
The driver holds the preset and a cursor. **Step** injects the current step to all four
nodes as an `external` event at the same virtual time:
```
['RU','RC','SI','SER'].forEach(id => sim.external(id, { schedule: step }))
```
then advances the cursor. **Play** steps on an interval. **Reset** rebuilds the sim.
One shared timeline and scrubber span all four panels, because all four nodes live in
one `Simulation` — identical to Ch3's side-by-side mechanics, widened to four.

**Per-panel divergence is the point.** The same step lands in all four panels, but:
- under **SER**, an op belonging to a txn that isn't the *active* txn is **queued**, not
  applied (serial execution admits one txn at a time; queued ops drain, in order, when
  the active txn commits or aborts);
- under **SI**, a txn killed by first-committer-wins turns its remaining ops into
  flagged no-ops (`skipped: txn aborted`);
- an `ensure` that fails aborts its txn at that panel only.
So the four panels drift apart — same input, different histories — and the outcome row
makes the drift countable.

**No network, no chaos toolbar.** The module emits **zero effects** (not even timers —
every transition is synchronous on the injected step). `chaos: []`. Ch7's "faults" are
the schedules themselves; challenges load a preset instead of injecting a fault.

---

## 3. Transaction engine — one reducer, four semantics

**State (`TxnState`, plain serializable):**
- `level`: `'RU' | 'RC' | 'SI' | 'SER'` (fixed at init from nodeId).
- `store`: `Record<key, Version[]>` where `Version = { value, txn, committedAt: number
  | null }` — a small multi-version store used by *all* levels (RU/RC just read
  different versions of it; SI reads by snapshot; committed versions keep history).
- `txns`: `Record<TxnId, { status: 'idle'|'active'|'committed'|'aborted'|'waiting',
  beganAt, snapshotAt (SI), reads: {key, value, versionCommittedAt}[], writes: key[],
  abortReason?: string }>`.
- `queue`: `ScheduleStep[]` (SER only — ops parked while the other txn is active).
- `anomalies`: `{ type: 'dirty-read'|'lost-update'|'write-skew', detail: string,
  at: number }[]` — appended by the detectors (§4).
- counters: `commits`, `aborts`, `queuedOps`, `skippedOps`.

**Level semantics (the four interpreters):**

| | read | write | commit rule |
|---|---|---|---|
| **RU** | latest version, committed **or not** | new uncommitted version, visible immediately | always commits |
| **RC** | latest **committed** version | new uncommitted version, private until commit | always commits |
| **SI** | latest version committed **≤ snapshotAt** | private version | **first-committer-wins**: if any written key has a version committed after `snapshotAt`, abort with `write-write conflict` |
| **SER** | latest committed version | private version | always commits — conflicts are impossible because only one txn runs at a time |

- **begin:** RU/RC/SI → `active` (SI records `snapshotAt = now`). SER → `active` if no
  other txn is active, else `waiting` (op and all its successors queue).
- **ensure(keys, atLeast):** reads each key at the level's read rule; if
  `sum(values) < atLeast` the txn aborts itself (`abortReason: 'ensure failed'`). This
  is DDIA's check-then-act shape — the doctors-on-call guard — as a first-class op, so
  write skew is expressible without a scripting language.
- **commit:** apply the level's commit rule; stamp the txn's versions
  `committedAt = now`; run detectors; SER then drains its queue.
- **abort:** discard the txn's uncommitted versions; SER drains its queue.

**Aborted-txn ops:** any op arriving for a `committed`/`aborted` txn increments
`skippedOps` and is otherwise a no-op — the schedule always runs to the end in every
panel.

---

## 4. Anomaly detectors — engine-verified, not narrated

Detectors run inside the module (on read or on commit) and append to `anomalies`; the
UI renders badges from state and challenge verifiers read them via `inspect()`. All
three are *observations of what actually happened in that panel*, not level-based
assumptions:

- **dirty-read** — flagged at **read** time when the version returned has
  `committedAt === null` and belongs to another txn. (Fires only at RU by
  construction, but the detector is level-blind.)
- **lost-update** — flagged at **commit** time when a committed write to key `k`
  overwrites a committed version that the committing txn **never read** — i.e. the txn
  read an older version of `k` (its `versionCommittedAt` predates the clobbered
  version's `committedAt`), then wrote `k`. Classic read-modify-write clobber.
- **write-skew** — flagged at **commit** time when this txn and another *overlapping*
  committed txn (their active windows intersect) read one another's written keys but
  wrote **disjoint** key sets, and both commits stand. (The doctors shape: both read
  {alice,bob}, one wrote alice, the other bob.)

`metrics()` per node: `commits`, `aborts`, `dirtyReads`, `lostUpdates`, `writeSkews`,
`queuedOps`, `skippedOps`. `inspect()` exposes the full txn table + anomaly log +
final committed store for the scoreboard, panels, and verifiers.

---

## 5. Preset schedules — one per anomaly

All presets use two transactions and end with the schedule fully consumed in every
panel. Initial committed store is loaded at `init` from the preset.

1. **Dirty read** (`x = 10` initially):
   `T1 begin · T1 write x=99 · T2 begin · T2 read x · T2 commit · T1 abort`
   *RU:* T2 read 99 — a value that, after T1's abort, **never existed**; dirty-read
   badge. *RC/SI/SER:* T2 read 10. (SER note: T2's read queues until T1 aborts, then
   reads 10 — same answer, different mechanism, and the panel shows the queueing.)
2. **Lost update** (`counter = 10`; both writes are `{inc: 1}`):
   `T1 begin · T2 begin · T1 read counter · T2 read counter · T1 write counter+=1 ·
   T1 commit · T2 write counter+=1 · T2 commit`
   *RU/RC:* both read 10, both wrote 11 — final `counter = 11`, one increment
   vanished; lost-update badge at T2's commit. *SI:* T2 aborts (first-committer-wins),
   final 11 with an explicit abort — degraded but **honest**. *SER:* T2's ops queued
   until T1 committed, then T2 read 11 and wrote **12** — the only panel where both
   increments land.
3. **Write skew — doctors on call** (`alice = 1, bob = 1`, invariant: at least one
   on call):
   `T1 begin · T2 begin · T1 ensure [alice,bob] ≥ 2 · T2 ensure [alice,bob] ≥ 2 ·
   T1 write alice=0 · T1 commit · T2 write bob=0 · T2 commit`
   *RU/RC/SI:* both ensures saw 2 (SI: both snapshots predate both writes), both
   committed, final on-call **count = 0** — invariant broken, write-skew badge. *SER:*
   T2 ran after T1; its ensure saw `alice=0, bob=1` → sum 1 < 2 → T2 aborted itself;
   invariant holds.

Note dirty-*write* and read-skew are not preset scenarios (core-trio scope), but the
debrief names them and the engine's version store would support future presets.

---

## 6. Challenges + the pinned outcome matrix

Three `ChallengePanel` challenges (predict-before-run + engine verifier, same kit as
Ch3/5/6/11). Each challenge: pick its preset, predict the per-panel outcome, run the
schedule to the end, verifier reads `inspect()` across all four nodes.

1. **"Read a lie"** — verifier: `dirty-read` flagged at RU **and only** RU; RC/SI/SER
   all read 10.
2. **"The vanishing increment"** — verifier: lost-update flagged at RU and RC (final
   11); SI shows T2 aborted with write-write conflict; SER final = **12** with zero
   anomalies.
3. **"Nobody's on call"** — verifier: write-skew flagged at RU, RC **and SI** (final
   on-call sum 0); SER holds the invariant (sum ≥ 1) via T2's failed ensure.

The **pinned lesson test** asserts this full 3-schedule × 4-level matrix (anomaly
flags + final stores + abort reasons) in one table-driven test — the headline guard
that refactors can't silently weaken a level or strengthen a weak one.

---

## 7. UI

`src/ui/labs/txn/`:
- **`TxnLab.tsx`** — builds the `Simulation` in an effect (PR#2 lesson); 4-column
  panel grid (2×2 below `lg`); beneath: `SchedulePanel`, `TxnScoreboard`,
  `TimelineScrubber`, three `ChallengePanel`s.
- **`SchedulePanel.tsx`** — preset picker (3 presets), the op list with a cursor
  highlight (`T1 write x=99` style monospace rows), step / play / reset buttons.
  Owns the driver cursor.
- **`IsolationPanel.tsx`** — rendered ×4 from a level-config array: level name +
  one-line credo ("reads may see uncommitted data" / "reads see last committed" /
  "reads from snapshot; first committer wins" / "one transaction at a time"); T1/T2
  status chips (active/committed/aborted/waiting + abort reason); the store with
  committed values and, where relevant, uncommitted overlay (RU) or version list
  (SI); anomaly badges (sign/coral); SER shows its op queue.
- **`TxnScoreboard.tsx`** — §4 metrics as a 4-column table; anomaly cells highlighted
  coral when non-zero, SER column teal when clean.
- **`Debrief.tsx`** (7.d) — `DebriefArticle` over `content/ch7/debrief.mdx` +
  `SurpriseJournal` (`ddia:ch7:journal`). Debrief covers the ladder, what each level
  costs (SI's aborts, SER's queueing = throughput), 2PL/SSI as the real-world
  serializable implementations, and why "use transactions" is not the end of the
  conversation.

Catalog `ch7` → `7.1 Isolation Anomaly Lab` + `7.d Debrief & Journal`, both `active`;
`App` PAGES add `'7.1'`, `'7.d'`.

---

## 8. Testing (TDD, RED→GREEN→REFACTOR)

**Engine unit (`txn.test.ts`):**
- RU read returns uncommitted foreign version + flags dirty-read; RC read of the same
  state returns last committed.
- SI: reads stable across foreign commits after `snapshotAt`; first-committer-wins
  aborts the second writer; abort discards private versions.
- SER: second `begin` queues; queue drains in order on commit/abort; queued `ensure`
  evaluates against post-commit state.
- `ensure` below threshold aborts the txn; at/above threshold is a no-op.
- `{inc:n}` write resolves against the txn's own read.
- Ops after commit/abort are counted `skippedOps`, state unchanged.
- Lost-update and write-skew detectors fire on hand-built histories and stay silent on
  clean ones (e.g. two txns writing disjoint keys they didn't read → no skew flag).

**Property (`txn.property.test.ts`, fast-check):**
- Determinism: same preset + same seed → identical serialized state ×4 nodes.
- **SER panel never flags any anomaly** for any generated valid schedule (ops over a
  small key/txn alphabet, txn-wellformed: begin before ops, one commit/abort last).
- RC and above never flag dirty-read; store versions with `committedAt !== null` are
  immutable once written.
- SI: every read in a txn returns values from the same snapshot bound.

**UI:** `SchedulePanel` cursor advances + disables at end; `IsolationPanel` renders
status chips, badges, SER queue from inspect fixtures; `TxnScoreboard` renders the
4-column matrix; each challenge verifier passes on its scripted preset run and fails
on a wrong-level fixture. Repo conventions: `// @vitest-environment jsdom`,
`afterEach(cleanup)`, container queries, no jest-dom.

**Pinned lesson test:** the §6 matrix, table-driven over the three presets.

---

## 9. File plan

New:
- `src/modules/txn-shared.ts`
- `src/modules/txn.ts`, `src/modules/txn.test.ts`, `src/modules/txn.property.test.ts`
- `src/ui/labs/txn/TxnLab.tsx` (+ `.test.tsx`)
- `src/ui/labs/txn/SchedulePanel.tsx` (+ `.test.tsx`)
- `src/ui/labs/txn/IsolationPanel.tsx` (+ `.test.tsx`)
- `src/ui/labs/txn/TxnScoreboard.tsx` (+ `.test.tsx`)
- `src/ui/labs/txn/Debrief.tsx`
- `content/ch7/debrief.mdx`

Edited:
- `src/ui/shell/catalog.ts` — `7.1`, `7.d` → `active`.
- `src/ui/App.tsx` — PAGES `'7.1'`, `'7.d'`.
- `README.md` — Ch7 lab listed.
- `docs/DESIGN_PLAN.en.md` — Ch7 checked off.

---

## 10. Risks

- **Level semantics drift.** Four interpreters in one reducer invite subtle
  cross-contamination (e.g. SI accidentally reading a too-new version). Mitigation:
  read/commit rules isolated in two pure functions switched on `level`, each
  unit-tested against hand-built version stores; the property suite pins SER-clean and
  RC-no-dirty-read invariants.
- **Detector false positives.** Lost-update/write-skew definitions must not fire on
  benign histories. Mitigation: negative unit tests (§8) + the pinned matrix asserts
  *exact* flag sets, not "at least".
- **`{inc:n}` write before any read.** Undefined base — spec: resolves against the
  txn's last read of that key; if the txn never read the key, it resolves against the
  value the level's read rule *would* return at write time (and records it as a read,
  so the lost-update detector still sees the dependency).
- **SER queue starvation confusion.** With 2 txns and finite presets this cannot
  loop, but the panel must show *why* nothing happened on a step (op queued) or the
  lockstep illusion breaks. Mitigation: SER panel renders its queue; SchedulePanel
  cursor is global, per-panel effects are per-panel truth.
