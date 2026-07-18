# Ch12.1 — Unbundled Database — Design

**Status:** APPROVED (2026-07-18; all sections approved interactively).

**Goal:** Ship DDIA Chapter 12 (The Future of Data Systems) as the capstone lab: a
single `upsert` write enters an **OLTP store**, becomes a record on an append-only
**changelog**, and fans out to three **derived views** — a **search index**, a
**cache**, and an **analytics** counter — that each consume the log at their own pace
and therefore **lag** the source. The reader watches one write propagate through the
whole system and feels the central Ch12 truth: **derived data is a lagging,
disposable projection of an append-only log that is the one source of truth.**

DESIGN_PLAN §4 row 12 aha — *"The index lags the source — what does the user see?"* —
is challenge 1 (stale read / read-your-writes). Roadmap `12.1` + `12.d` → `active`.

Interactive decisions (2026-07-18):
- **Fresh purpose-built module** — NOT literal reuse of prior `SimModule`s. "Compose
  the previous Labs" (DESIGN_PLAN) read thematically: this module echoes kafkalog's
  append-log and batch's replay concepts with its own clean nodes, and is testable in
  isolation like every prior chapter's single module.
- **Canonical CDC challenge triad** — stale read (RYW) / rebuild from log /
  exactly-once. Maps to the three biggest Ch12 ideas.
- **Single fan-out pipeline** layout (not a twin) — one source lane, three derived
  panels, one lag gauge each.
- **Single authoritative sim node** (`DB`) owns the log + all three view sub-states
  (decided at plan time, 2026-07-18). Ch12 has no kill/message-loss chaos, so the
  transport is not the lesson; a multi-node network would force awkward cross-node
  wipe/replay coordination for no pedagogical gain. Delivery is abstracted to a
  timer-paced per-view offset advance — an intended simplification, in the spirit of
  Ch10's hard-barrier shuffle. Real CDC is distributed (Debezium → Kafka →
  consumers); the debrief says so.

---

## 1. Scope

**In:**
- `src/modules/unbundled-shared.ts` — topology (sim nodes, see §2), the fixed key
  space + seed writes, the log-record and query payload types, the derived-view value
  shapes, timing constants, and the pure `derive*(log)` reference functions the
  property/rebuild tests assert against.
- `src/modules/unbundled.ts` — one `SimModule<UnbundledState>` on a single node
  `DB`. State holds the append-only `log` plus three view sub-states, each with its
  own `offset`, `paused`, `dedup`, and contents. A per-view `{t:'advance'}` timer
  (armed on the `init` event, re-armed every `ADVANCE_EVERY` ticks — the batch/
  ping-pong precedent) applies `log[offset]` and advances `offset` toward head unless
  the view is paused. Log append on write, wipe + rebuild-from-0, redelivery
  (re-apply the last record without advancing), per-view idempotence (skip a record
  whose offset < `offset`), `inspect`/`metrics` for the panels. All reader actions
  are external commands to `DB` (§3); `chaos: []` (no ChaosToolbar).
- Lab `src/ui/labs/unbundled/UnbundledLab.tsx` (12.1): source lane (Client → OLTP →
  Log offset tape), three `DerivedPanel`s, a query bar, `ChallengePanel` ×3,
  forward-only `TimelineScrubber` (Ch8 lesson).
- `src/ui/labs/unbundled/DerivedPanel.tsx` — one view's offset-vs-head lag gauge,
  contents (index terms / cache table / analytics tally), and per-view controls
  (pause/resume, wipe, crash-retry, idempotence toggle). Presentational (pure props),
  own jsdom tests — the Ch10 `StagePanel` pattern.
- Debrief `content/ch12/debrief.mdx` + `Debrief.tsx` (12.d), journal
  `ddia:ch12:journal`.
- Catalog/App/README/DESIGN_PLAN wiring; unit + behavioral + property + pinned lesson
  tests.

**Out (deferred, named in debrief):** multi-partition log ordering (single partition
here — total order is free); distributed transactions / XA and cross-view atomic
commit; real search-index internals (inverted index term analysis, ranking);
backpressure and consumer flow control; log compaction *mechanics* (mentioned as the
real rebuild story, not simulated); schema evolution of the changelog; secondary
indexes on the derived views. All prose-only in the debrief.

---

## 2. The module

### Scenario & data

A tiny product catalog. A write is `upsert(key, value)` where `key ∈ {p1..pN}` (small
fixed space, ~6 keys) and `value = { title: string, category: Category }` with
`Category` a 2–3 value enum (e.g. `'book' | 'toy' | 'tool'`). Seed writes preload a
few records so views have content on load; the challenges add fresh writes.

### The log (source of truth)

A single append-only partition owned by the `DB` node. Each write appends one
record:

```ts
interface LogRecord { offset: number; key: Key; value: RecordValue }
// head H = log.length; offsets are 0..H-1
```

Single partition ⇒ a total order for free (multi-partition ordering is a named cut).

### The three derived views (differ in shape, so the lesson lands three ways)

Each view is a **pure function of the log prefix it has consumed** — this is what
makes rebuild (C2) and exactly-once (C3) provable. `unbundled-shared.ts` exports the
reference derivers used by tests:

- **SearchIndex** — `term → Set<Key>` (title tokens → keys). A lookup can **miss** a
  key the source already has. `deriveSearch(prefix)`.
- **Cache** — `key → latest value`. A get can be **stale** (old value or absent).
  `deriveCache(prefix)`.
- **Analytics** — `category → count`, a monotonic per-category tally. Can
  **double-count** under redelivery. `deriveAnalytics(prefix)`.

### Views, offsets, lag

Each view holds its own `offset` (next log index to consume); **lag = H − offset** —
the core gauge, one per view. A per-view `{t:'advance'}` timer applies `log[offset]`
and advances `offset` toward head each `ADVANCE_EVERY` ticks, unless the view is
`paused` (lag then grows). Idempotence (`dedup`), when on, skips applying a record
whose offset `< offset` — making a redelivery of the last record a no-op.

### Topology

**One sim node, `DB`** (`nodeIds: ['DB']`), owns `log` + the three view sub-states.
No network, no cross-node messages — the pacing is internal `timer` effects. The
three-lane fan-out is a UI rendering of `DB`'s inspect tree, not three sim nodes. The
node list is fixed in `unbundled-shared.ts` during Task 1.

---

## 3. Interaction & chaos

All reader actions are **external commands to `DB`** (no ChaosToolbar; per-view
buttons live in each `DerivedPanel`).

**Reader actions:**
- **Write** — `{cmd:'write', key, value}` → appends to `log`, head `H` advances. The
  log (source of truth) reflects it immediately; derived views do not.
- **Query a view** — read-only, computed in the UI from the view's contents in
  `inspect`: `search.index[term]`, `cache.map[key]`, `analytics.tally[cat]`. Answer
  reflects only that view's consumed prefix → staleness is visible. No event.
- **Step / play** — advance ticks; the per-view `advance` timers apply records, lags
  shrink.

**Per-view controls (external commands to `DB`, carrying the target view):**
- **Pause / resume** — `{cmd:'pause'|'resume', view}` freezes/unfreezes that view's
  offset advance; lag grows on demand (C1, C2 setup).
- **Wipe** — `{cmd:'wipe', view}` clears contents + resets `offset → 0`; the advance
  timer rebuilds it from the log (C2).
- **Redeliver** — `{cmd:'redeliver', view}` re-applies `log[offset-1]` once *without*
  advancing `offset` (a crash-retry reprocessing the last record) (C3).
- **Idempotence toggle** — `{cmd:'toggle-dedup', view}`; the **fix** for C3.

---

## 4. Challenges (engine-verified win conditions)

Each win is **UI-flag-gated per epoch** (Ch3/Ch8 no-auto-win lesson — a challenge
wins only when the reader drove the specific sequence, not on load). Each is a
separate sim in the pinned lesson test, asserted clause-by-clause (the
challenge-verifier contract).

| # | Name | Setup → win condition |
|---|------|-----------------------|
| **C1** | **Stale read (RYW)** | Search view paused (lagging). Write new key `k`. Query the index for a term of `k` **before** catch-up → **miss** while the `log` already holds `k` (the read-your-writes anomaly). Resume → play → same query now **hits**. **Win = miss-then-hit both observed in one epoch.** |
| **C2** | **Rebuild from log** | Wipe Cache (empty / wrong). The advance timer replays from offset 0 → play to catch-up. **Win = `cache.map` deep-equals `deriveCache(fullLog)` and `offset === head`** — the log is truth, derived data disposable. |
| **C3** | **Exactly-once** | Idempotence OFF: redeliver the last record to Analytics → its tally **over-counts** (`> deriveAnalytics(log)`). Toggle dedup ON, redeliver again → tally stays **exact**. **Win = double-count seen off, exact on, in one epoch.** |

---

## 5. UI, debrief, wiring

**UnbundledLab** — single-pipeline layout:
- **Source lane (top):** Client → OLTPStore → Log. Log renders as a horizontal offset
  tape (records `0..H`), head marked.
- **Three DerivedPanels:** each shows name, `offset` vs head `H`, a **lag gauge**
  (`H − offset`), the view's contents, and per-view controls (pause/resume, wipe,
  redeliver, idempotence toggle).
- **Query bar:** issue a lookup/get/count (read-only, computed from the view's
  contents); see the answer against the current, possibly-stale, view.
- **ChallengePanel** ×3: predict → drive → win banner (mirrors Ch10 `ChallengePanel`
  wiring exactly).
- **DerivedPanel** is presentational (pure props), own jsdom tests (Ch10 `StagePanel`
  pattern).

**Debrief (12.d, `content/ch12/debrief.mdx`)** — mirrors `raft/Debrief.tsx`, journal
key `ddia:ch12:journal`. Covers, in order: the headline (log = source of truth, views
= disposable lagging projections); the lag you watched (RYW anomaly, why derived data
is *always* eventually consistent); rebuild = the log replaces backups (Kafka log
compaction, Kafka-Streams/Samza local-state rebuild); exactly-once = idempotence keyed
on offset (**the end-to-end argument** — dedup belongs at the endpoint, not the
middleware); the named cuts (§1 Out). Real systems: Debezium / Kafka Connect CDC,
Kafka Streams, Materialize, Samza. Terms: changelog, derived data, materialized view,
log compaction, idempotence, offset, read-your-writes, end-to-end argument.

**Wiring:** catalog `12.1` + `12.d` → `status:'active'`; `catalog.test.ts` ch12 test
(mirror the ch10/ch11 shape); App PAGES entries after `'11.d'`; README ch12 block +
counter bump ("Ten chapters live — …labs"); DESIGN_PLAN Phase 5 progress note. This
completes Phase 5's "finish with the unbundled-database lab composing everything."

---

## 6. Testing strategy (TDD, mirrors Ch10)

- **`unbundled-shared.ts`** — topology, fixture (fixed key space, seed writes),
  payload/value types, timing constants, and the pure `deriveSearch/deriveCache/
  deriveAnalytics(prefix)` references. Pinned test.
- **`unbundled.ts`** — behavioral gate tests:
  - **lag matrix** — write → derived views trail head; catch-up on play; a paused
    consumer's lag grows and holds.
  - **rebuild** — wipe → replay from 0 → view deep-equals the reference derivation.
  - **redelivery** — crash-retry double-counts analytics with dedup OFF; exact with
    dedup ON.
- **Property suite** — invariants (a counterexample is a real bug: shrink, report, fix
  minimally, document):
  - (a) **eventual consistency** — every view after full catch-up equals its
    reference derivation over the whole log.
  - (b) **rebuild exactness** — wipe at any time + replay from 0 is exact.
  - (c) **exactly-once** — with idempotence on, any redelivery sequence leaves
    analytics equal to the reference (idempotent under replay).
- **Pinned lesson test** — the three challenge scenarios, each its own sim, asserted
  clause-by-clause.
- **DerivedPanel** — jsdom presentational tests (lag gauge, contents, controls,
  paused/wiped states).
- **UnbundledLab** — smoke + challenge-wiring tests.

Gate each task: `npx vitest run && npx tsc -b && npm run build`. Ship gate adds a
browser DoD walk (vite + playwright) driving ≥ C1 to its live win banner, 0 console
errors.

---

## 7. File plan

- `src/modules/unbundled-shared.ts` (+ `.test.ts`)
- `src/modules/unbundled.ts` (+ `.test.ts`, `.property.test.ts`, `unbundled-lesson.test.ts`)
- `src/ui/labs/unbundled/UnbundledLab.tsx` (+ `.test.tsx`)
- `src/ui/labs/unbundled/DerivedPanel.tsx` (+ `.test.tsx`)
- `src/ui/labs/unbundled/Debrief.tsx`
- `content/ch12/debrief.mdx`
- Edits: `src/ui/shell/catalog.ts` (+ `catalog.test.ts`), App PAGES, `README.md`,
  `docs/DESIGN_PLAN.md` + `.en.md`.

## 8. Risks / notes

- **Analytics as the double-count victim** — the exactly-once lesson needs a
  non-idempotent aggregate (a monotonic counter). Cache (last-write-wins) and
  SearchIndex (set union) are *naturally* idempotent, so C3 targets Analytics
  specifically; the design leans on this on purpose.
- **Delivery cadence vs. legibility** — consumers pull one record per cadence tick so
  lag is watchable; if all three catch up too fast to observe C1, the pause knob is
  the guaranteed setup (challenge does not rely on race timing).
- **Metrics readability** — if a per-consumer lag+offset chart is noisy, keep lag in
  the panel gauges and show only head `H` + total pending in `metrics()`.
