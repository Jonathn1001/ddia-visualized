# Ch3.1 — Storage Engines (LSM-tree vs B-tree, side-by-side) — Design

**Status:** APPROVED (brainstorm 2026-07-14). Not yet built.

**Goal:** Ship DDIA Chapter 3 (Storage Engines) as one interactive lab that runs an
**LSM-tree and a B-tree side-by-side**, driven by the **same** key-value workload, with a
shared disk-I/O scoreboard. The learner discovers *why* the two engines trade off the way
they do: write-optimised (LSM: sequential appends + background compaction) vs
read-optimised (B-tree: in-place update + shallow traversal). The comparison is the whole
point — same keys → both sides → **compare the numbers** (write / read / space amplification).

This is the first **non-network storage lab**. It validates the storage-chaos family of the
module contract (`crash-mid-write`, `torn-write`, `disk-full`) — declared in
`src/engine/module.ts` but never yet consumed — and proves the engine runs a purely-local
module that emits **zero network messages** (Phase 2 of DESIGN_PLAN §7).

Builds on the Phase-0 engine + Phase-1 kit. Roadmap slot `3.1` ("LSM-Tree vs B-Tree",
currently `soon`) → `active`.

---

## 1. Scope

**In:**
- Three new pure modules (contract v0.2):
  - `src/modules/storage-shared.ts` — topology (`['LSM','Btree']`), byte/page constants,
    amplification math, shared types, fault-event union.
  - `src/modules/lsm.ts` — LSM-tree engine state logic (memtable, WAL, SSTable levels,
    bloom filters, tombstones, flush + L0→L1 compaction).
  - `src/modules/btree.ts` — B-tree engine state logic (fixed-fanout pages, split-on-overflow,
    redo WAL, in-place update).
  - `src/modules/storage.ts` — thin `SimModule` dispatcher: routes `init/reduce/metrics/inspect`
    to `lsm` or `btree` by `nodeId`. This satisfies the one-module-per-Simulation constraint
    while keeping the two engines isolated and independently testable.
- New lab page `src/ui/labs/storage/StorageLab.tsx` (3.1): side-by-side layout, shared
  `KVControls`, `ChaosToolbar` (3 storage faults), `StorageScoreboard`, `TimelineScrubber`,
  `ChallengePanel` (3 challenges), MDX debrief.
- Two engine views: `LsmView.tsx` (memtable bar + SSTable levels with bloom + compaction
  animation) and `BtreeView.tsx` (page tree + split animation).
- `StorageScoreboard.tsx` — the countable numbers, both engines, side-by-side.
- Ch3 debrief: `content/ch3/debrief.mdx` + `src/ui/labs/storage/Debrief.tsx` (3.d), journal key
  `ddia:ch3:journal`, via shared `DebriefArticle` / `SurpriseJournal`.
- Catalog + routing: `ch3` entries `3.1 LSM-Tree vs B-Tree` + `3.d Debrief & Journal` → `active`;
  App PAGES `'3.1'`, `'3.d'` (book order enforced by existing catalog test).
- Unit + property tests per engine; view render tests; a pinned lesson test guarding the
  headline amplification signatures.

**Out (explicitly deferred — cut from the "full fidelity" option):**
- Multi-level leveled compaction beyond **L0→L1** (no L2/L3 cascade).
- Size-tiered vs leveled compaction toggle.
- B-tree merge / rebalance on delete (delete is a bounded in-place removal, no page merge).
- Tunable bloom false-positive rate / fanout sliders.
- Range scans / iterators (point ops only: put / get / delete).

---

## 2. Architecture — engine unchanged (the generalization proof)

One `Simulation<StorageState>`, config `nodeIds: ['LSM','Btree']`, module = `storage` dispatcher.

**Op path.** The user issues a key-value op via `KVControls`. The driver injects it as an
`external` event to **both** nodes at the same virtual time:
```
sim.external('LSM',   { op: 'put', key, value })
sim.external('Btree', { op: 'put', key, value })
```
Each node reduces the op independently against its own engine state. One shared timeline,
one scrubber, one event log spans both — because both nodes live in one `Simulation`.

**No network.** The storage module emits **no `send` effects**. The only effect it uses is
`timer` — to schedule deferred flush / compaction / split-commit phases on the deterministic
virtual clock. This is the point of the lab as a Phase-2 milestone: the engine, built for a
distributed-message world, runs an entirely local module without modification.

**Storage faults = `external` events, module-interpreted.** The `crash-mid-write`,
`torn-write`, and `disk-full` capabilities are *domain* faults, not network/liveness ones, so
they do **not** extend `ControlAction` (which stays kill/revive/partition/heal/net). Instead the
`ChaosToolbar` injects them as `external` fault events:
```
sim.external('LSM', { fault: 'crash-mid-write' })
```
The engine's reducer applies the fault to its own state. Rationale: (a) zero engine change →
other labs untouched (safer); (b) `crash-mid-write` semantics ("discard volatile memtable, keep
WAL, run recovery") are module-state logic the engine cannot perform alone; (c) `external` events
are already recorded + replayable, so faults are deterministic and scrub-safe.

---

## 3. LSM-tree model (faithful, bounded)

**State (`LsmState`, plain serializable):**
- `memtable`: sorted `[key, value|TOMBSTONE][]` (or object map kept sorted on read), capped at
  `MEMTABLE_CAP` entries.
- `wal`: durable append log `WalRecord[]` — survives `crash-mid-write`.
- `sstables`: `SSTable[]` grouped by level (`L0`, `L1`). Each = `{ level, entries (immutable
  sorted run), bloom (bit-set over keys), keyRange: [min,max] }`.
- `phase`: `'idle' | 'flushing' | 'compacting' | 'recovering'` — drives 2-phase timers + animation.
- counters: `diskReads`, `diskWrites`, `bytesWritten`, `bytesRead`, `userBytes`, `bloomSkips`.

**Ops:**
- **put(k,v) / delete(k):** append `WalRecord` (durable, counts a `diskWrite`); insert into
  memtable (delete = tombstone). If `memtable.size ≥ MEMTABLE_CAP` → emit `timer` to begin flush.
- **flush (2-phase, timer-driven):**
  - *phase 1:* append a flush-marker to WAL; schedule *phase 2* timer.
  - *phase 2:* write the memtable out as a new **L0** SSTable (immutable sorted run + bloom),
    count `bytesWritten`, clear memtable, truncate the flushed WAL prefix. → `phase: 'idle'`.
  - A `crash-mid-write` between phase 1 and phase 2 loses the **volatile** memtable but the WAL
    is intact → recovery replays WAL into a fresh memtable. This is *why* the flush is split
    across two timer events (also makes the animation watchable).
- **compaction:** when `L0` run count `≥ L0_TRIGGER` → `timer` to merge all L0 runs (+ any
  key-overlapping L1 run) into one new L1 run, dropping overwritten keys and dropped tombstones.
  Rewritten bytes accrue to `bytesWritten` → this is the source of LSM **write amplification**.
- **get(k):** probe memtable first; then SSTables **newest→oldest**, using each run's bloom to
  skip on a negative (count `bloomSkips`); the first hit (value or tombstone) wins. SSTables
  actually read (bloom positive) count toward `diskReads` → LSM **read amplification**.

---

## 4. B-tree model (faithful, bounded)

**State (`BtreeState`, plain serializable):**
- `pages`: `Map<PageId, Page>` where `Page = { id, isLeaf, keys[], values?[], children?: PageId[] }`,
  fixed order `BTREE_ORDER` (max keys per page).
- `rootId`, `height`.
- `wal`: redo log `RedoRecord[]` — survives `crash-mid-write`.
- `phase`: `'idle' | 'splitting' | 'recovering'`.
- counters: `diskReads`, `diskWrites`, `bytesWritten`, `bytesRead`, `userBytes`, `pageWrites`.

**Ops:**
- **put(k,v):** append redo record (durable, counts a `diskWrite`); traverse root→leaf (counts
  `diskReads` = height); in-place insert/overwrite in the target leaf (counts a `pageWrite`). If
  the leaf overflows (`> BTREE_ORDER`) → **split**: allocate a new page, push the median key to
  the parent; a root overflow allocates a new root and **grows `height` by one**. Split writes
  multiple pages across a short timer sequence so `crash-mid-write` can land mid-split.
- **get(k):** root→leaf traversal, `diskReads` = height = B-tree **read amplification** (shallow,
  ~constant vs LSM's multi-run probe).
- **delete(k):** in-place removal from the leaf (bounded — **no** merge/rebalance; a near-empty
  page just stays under-full; documented non-goal).
- **crash-mid-write:** a split writes several pages; a crash between them leaves a torn structure,
  but the redo WAL replays committed records on recovery → structure repaired.

Because B-tree updates in place and never rewrites whole runs, its `bytesWritten` stays close to
`userBytes` → **write-amp ≈ 1–2×**, the headline contrast against LSM's compaction cost.

---

## 5. Chaos challenges (all three)

Each is a `ChallengePanel` challenge with predict-before-run + an engine verifier (same pattern
as Ch5/Ch6/Ch11). All apply to both engines side-by-side so the learner sees each engine's fate.

1. **Crash mid-write (headline — DESIGN_PLAN §4).** Fire `crash-mid-write` during a flush (LSM) /
   split (B-tree). *Predict:* which writes survive? *Reveal:* WAL-committed writes replay on
   recovery; volatile-only data (un-flushed memtable / un-committed split page) is lost. Verifier:
   post-recovery, every WAL-acked key is readable; no un-acked key is.
2. **Disk full.** Cap `diskUsed` at `DISK_CAP`. LSM compaction needs temporary headroom (a merge
   briefly holds both input runs *and* the output run) → compaction **stalls**, L0 keeps growing,
   read-amp climbs. B-tree **split is rejected** → the insert fails. Verifier: LSM stays readable
   but degraded; B-tree rejects the overflowing put. Surfaces **space amplification**.
3. **Torn write.** The next durable write lands **partially** (SSTable / page half-written). A
   checksum mismatch is flagged on the next read of that run/page → the engine falls back to WAL
   redo to repair. Verifier: the torn run is detected (not silently served) and the correct value
   is recovered from the WAL.

---

## 6. Metrics — the countable numbers

`storage.metrics()` returns, for **each** engine (rendered side-by-side in `StorageScoreboard`):

| Metric | LSM | B-tree | Meaning |
|---|---|---|---|
| disk reads | runs probed / get | pages read = height | read cost |
| disk writes | WAL + flush + compaction | WAL + page writes | write cost |
| bytes written | incl. compaction rewrites | ≈ user bytes | raw write volume |
| **write-amp** | bytes written ÷ user bytes (high) | ≈ 1–2× (low) | LSM pays here |
| **read-amp** | runs touched / get (grows w/ L0) | height (shallow) | B-tree pays less |
| **space-amp** | disk used ÷ live data (tombstones, overlap) | fill factor | dead space |
| bloom skips | negatives skipped | — | why LSM reads stay bounded |

Every metric is a plain counter derived from state — deterministic, snapshot-safe.

---

## 7. UI

`src/ui/labs/storage/`:
- **`StorageLab.tsx`** — builds the `Simulation` in an effect (per the PR#2 render-phase lesson),
  side-by-side two-column layout: `LsmView` ‖ `BtreeView`. Shared controls beneath: `KVControls`
  (put / get / delete / bulk-load-N), `ChaosToolbar` (3 storage faults), `StorageScoreboard`,
  `TimelineScrubber`, `ChallengePanel`.
- **`LsmView.tsx`** — memtable fill bar; SSTable levels L0/L1 as stacked immutable runs (bloom
  badge, key range); flush + compaction animated via `phase`.
- **`BtreeView.tsx`** — page tree (root → leaves), keys per page, split animation via `phase`,
  height readout.
- **`StorageScoreboard.tsx`** — the §6 table, both engines, amp metrics highlighted when a
  challenge target threshold is crossed.
- **`Debrief.tsx`** (3.d) — `DebriefArticle` over `content/ch3/debrief.mdx` + `SurpriseJournal`
  (`ddia:ch3:journal`).

Catalog `ch3` → `3.1 LSM-Tree vs B-Tree` + `3.d Debrief & Journal`, both `active`; `App` PAGES add
`'3.1'`, `'3.d'`.

---

## 8. Testing (TDD, RED→GREEN→REFACTOR)

**Engine unit (`lsm.test.ts`, `btree.test.ts`):**
- put→get round-trip; delete hides key (LSM tombstone, B-tree removal).
- LSM flush produces an L0 run and clears memtable; L0_TRIGGER fires compaction; compaction
  preserves every live key and drops overwritten/tombstoned keys.
- B-tree split grows structure; root split increments height; get cost == height.
- WAL recovery: after `crash-mid-write`, every WAL-acked key readable, no un-acked key readable.
- disk-full: LSM compaction stalls (L0 grows, still readable); B-tree split rejected.
- torn-write: checksum flagged, value recovered from WAL.

**Property (`lsm.property.test.ts`, `btree.property.test.ts`, fast-check):**
- LSM bloom filter never false-negative (a present key is never skipped).
- Compaction is value-preserving: for any op sequence, post-compaction get == a reference map.
- write-amp is monotonic non-decreasing across compactions; B-tree write-amp bounded.
- Determinism: same seed + same op sequence → identical serialized state, both engines.

**UI:** `StorageScoreboard` renders both engines' metrics; each challenge verifier returns the
right pass/fail on a scripted op+fault sequence; pinned lesson test asserts LSM write-amp > B-tree
write-amp and B-tree read-amp < LSM read-amp after a standard workload (guards the headline).

---

## 9. File plan

New:
- `src/modules/storage-shared.ts`
- `src/modules/lsm.ts`, `src/modules/lsm.test.ts`, `src/modules/lsm.property.test.ts`
- `src/modules/btree.ts`, `src/modules/btree.test.ts`, `src/modules/btree.property.test.ts`
- `src/modules/storage.ts` (dispatcher) + `src/modules/storage.test.ts`
- `src/ui/labs/storage/StorageLab.tsx`
- `src/ui/labs/storage/LsmView.tsx` (+ `.test.tsx`)
- `src/ui/labs/storage/BtreeView.tsx` (+ `.test.tsx`)
- `src/ui/labs/storage/StorageScoreboard.tsx` (+ `.test.tsx`)
- `src/ui/labs/storage/Debrief.tsx`
- `content/ch3/debrief.mdx`

Edited:
- `src/ui/shell/catalog.ts` — `3.1`, `3.d` → `active`.
- `src/ui/App.tsx` — PAGES `'3.1'`, `'3.d'`.
- `README.md` — Ch3 lab listed.
- `docs/DESIGN_PLAN.en.md` — Phase 2 checked off.

---

## 10. Risks

- **crash-mid-write timing.** The crash must land *between* a flush's two phases (or a split's page
  writes) to be meaningful. Mitigation: the fault, when injected during `phase !== 'idle'`, discards
  exactly the volatile in-progress work and sets `phase: 'recovering'`; a scripted test pins the
  exact interleaving so a refactor can't silently make the crash a no-op.
- **One module, two engines.** The dispatcher must never leak LSM state into B-tree metrics or vice
  versa. Mitigation: `storage.ts` branches purely on `nodeId`; `storage.test.ts` asserts each node's
  inspect/metrics reflects only its own engine.
- **Side-by-side novelty.** No prior lab drives two nodes from one op. Mitigation: driver injects the
  same payload to both via two `external` calls at equal virtual time — deterministic, and the
  existing timeline/scrubber handle it unchanged.
