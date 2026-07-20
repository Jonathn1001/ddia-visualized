# Ch2.1 — Model Shape-Shifter — Design

**Status:** APPROVED (2026-07-20; execution model + scenario scope approved interactively).

**Goal:** Ship DDIA Chapter 2 (Data Models & Query Languages) as the **capstone**
comparison lab: one fixed social-graph dataset stored three ways — **relational**
tables, denormalized **documents**, and a **graph** — runs the *same* query in all
three, and the reader **watches each execution step-by-step** (a graph BFS hop, a
document fetch, a relational row-probe) while a **live op-count** ticks up. Same
question, same answer, three wildly different costs. The reader feels the central Ch2
truth: **the data model is not a storage detail — it decides which questions are cheap
and which are agony, and the query you run most should pick your model.**

DESIGN_PLAN §4 row 2 aha — *"Query 'friends of friends' on the document model — feel the
pain of joins"* — is challenge **C1**. Roadmap `2.1` + `2.d` → `active`.

**Interactive decisions (2026-07-20):**
- **Stepped / animated, engine-driven** (not a static side-by-side widget). Each model's
  query execution is a *trace* the module animates by advancing a cursor per tick — the
  Ch12 advance-timer pattern — so the reader watches the graph finish in a few hops while
  the document model grinds through N+1 fetches. Reuses the step/play/scrubber machinery.
- **Three scenarios**: friends-of-friends (C1), many-to-many (C2), schema flexibility
  (C3) — Ch2's three big ideas.
- **Deviation from DESIGN_PLAN §8 acknowledged:** §8 pencils Ch2 as a "mini-widget."
  Sang chose the richer animated + three-scenario treatment for the final chapter of the
  book. Documented here as an intentional scope-up, not scope-creep.
- **Single authoritative sim node (`DM`)**, `chaos: []`, all reader actions are external
  commands (the Ch12/Ch1 precedent). Ch2 has no network/time/fault dimension.

**Clean split (the load-bearing idea):** pure **query engines** compute a trace;
the **module** only animates it. Cost is *real* (computed by walking the actual data
structures), never faked, and fully unit-testable without the engine.

---

## 1. Scope

**In:**
- `src/modules/models-shared.ts` — the fixed dataset in three shapes, the query/step/
  trace types, timing constants, challenge thresholds, and the three pure runners
  `runGraph / runDocument / runRelational(db, query) → Trace` the property + lesson tests
  assert against.
- `src/modules/models.ts` — one `SimModule<ModelsState>` on node `DM`. Holds the three
  traces + a per-model cursor; a `{t:'step'}` timer advances every not-done cursor one op
  and re-arms; `set-query` recomputes traces + resets cursors; `add-field` drives the
  schema-flex scenario. `inspect`/`metrics` expose per-model cost + the highlighted
  element. `chaos: []`.
- Lab `src/ui/labs/models/ModelShifterLab.tsx` (2.1): a query/scenario picker, three
  side-by-side `ModelPanel`s, step/play/forward-only scrubber, three `ChallengePanel`s.
- `src/ui/labs/models/ModelPanel.tsx` — one model's rendering (adjacency graph / doc
  cards / tables), highlighting the element the current cursor touches, with a running
  op-count. Presentational (pure props), own jsdom tests (the Ch10 StagePanel / Ch12
  DerivedPanel pattern).
- Debrief `content/ch02/debrief.mdx` + `Debrief.tsx` (2.d), journal `ddia:ch02:journal`.
- Catalog/App/README/DESIGN_PLAN wiring; unit + behavioral + property + pinned lesson
  tests.

**Out (deferred, named in debrief):** write/update/delete query paths (read queries
only — schema-flex is the one write, and only its *storage shape* is shown, not a
transactional write path); real query planners / cost-based optimisation (the traces are
one fixed execution strategy per model, not "what Postgres would choose"); indexes (every
lookup is a scan/probe at unit cost — no B-tree/hash-index acceleration modelled, which
is Ch3's subject); the network/replication cost of a distributed query; MapReduce and the
declarative-vs-imperative *query-language* execution (named in prose, not animated — that
is Ch10's lab); triple-stores / SPARQL / Datalog (Cypher-style traversal is the only
graph query shown); more than one starting user's worth of fixture depth. All prose-only
in the debrief.

---

## 2. The model

### Dataset & the three shapes

A tiny fixed social network — **6 users** `u1..u6` (alice, bob, carol, dan, eve, frank),
undirected **friendships** (a many-to-many relation), and **posts** with a `category`
that users **like** (a second many-to-many). Friendships:

```
alice–bob, alice–carol, bob–dan, carol–eve, carol–frank, dan–eve
```

so `friends-of-friends(alice)` = `{dan, eve, frank}` (bob & carol's friends, minus alice
and minus her own direct friends).

**Posts & likes (the m2m fixture, pinned):** 4 posts — `t1,t2` in category **`tech`**,
`c1` in `cooking`, `g1` in `garden`. Likes: `bob→t1`, `dan→t2`, `frank→t1`, `carol→c1`,
`eve→g1`, `alice→c1`. So **`likes-in-category('tech')` = `{bob, dan, frank}`** (the users
who like `t1` or `t2`); `carol`, `eve`, `alice` like only non-tech posts and are excluded.
Every runner must return exactly this set — that is what property (a) asserts.

The same facts stored three ways:

- **Graph** — `adjacency: Record<Id, Id[]>` for friendships; posts/likes as edges;
  categories as node properties. Traversal is a first-class operation.
- **Document** — one denormalized doc per user `{ id, name, friendIds: Id[], likes:
  PostId[] }`; posts as separate docs `{ id, category }`. A doc stores *ids*, not nested
  objects, so following a relationship means a **second fetch** — the join lives in
  application code.
- **Relational** — normalized tables `users(id,name)`, `friendships(a,b)` (join table),
  `posts(id,category)`, `likes(userId,postId)`. A relationship is a **join** over the
  join table.

The fixture is fixed in `models-shared.ts`; the same underlying facts populate all three
shapes so equality across models is meaningful.

### Queries → traces (the pure engines)

```ts
type ModelId = 'relational' | 'document' | 'graph';
type QueryId = 'fof' | 'm2m';               // friends-of-friends | likes-in-category
interface Step { kind: 'hop' | 'fetch' | 'probe'; touched: Id[]; note: string }
interface Trace { steps: Step[]; result: Id[]; roundTrips: number }
```

- `runGraph(db, q)` — a single traversal over adjacency; each edge followed is a **hop**
  step. **`roundTrips = 1`** (one query, the engine follows pointers in-process).
- `runDocument(db, q)` — fetch the root doc, then one **fetch** per related id — the N+1;
  `m2m` has no join, so it scans every user doc and fetches each liked post's doc. **Each
  fetch is a `roundTrips`** — `roundTrips = steps.length` (there is no join; every hop is
  a separate application-issued query).
- `runRelational(db, q)` — one join over the join table; each row examined is a **probe**
  step. **`roundTrips = 1`** (one declarative query).

**Why `roundTrips`, not raw op-count, is the challenge metric (load-bearing):** counting
internal ops (hops/fetches/probes) does *not* make the document model the loser — for
FoF the document does ~6 fetches while the relational join probes ~7 rows and the graph
walks ~5 edges, so document is not even the max. The N+1 problem is a **round-trip**
problem: the document model issues one application query *per entity* because it cannot
join, while relational and graph answer in **one** query. `roundTrips` is the honest
countable number (each is a network RTT — what actually costs latency), and it is the
number that makes the DDIA lesson true. The animated `steps` still show the internal work
(so the graph's cheap in-engine hops are visible against the document's expensive
per-fetch round trips); the **challenge gates on `roundTrips`**.

Every runner returns the **same `result`** for the same query (asserted by the property
suite); only `roundTrips` and the `steps` differ. `result` is a **sorted** `Id[]` so
equality is order-independent.

### State, stepping, schema-flex

```ts
interface ModelsState {
  self: NodeId;
  query: QueryId; root: Id;                       // current scenario
  traces: Record<ModelId, Trace>;                 // recomputed on set-query
  cursor: Record<ModelId, number>;                // ops consumed so far, 0..steps.length
  schema: { nicknameAdded: boolean };             // C3 write-side scenario
  ch: { c1: boolean; c2: boolean; c3: boolean };  // latched challenge flags
}
```

A `{t:'step'}` timer (armed on the `init` event, re-armed every `STEP_EVERY` ticks while
**any** cursor `< its trace.steps.length`) advances each not-done cursor by one — models
race, the fast one idles while the slow one grinds. `done(model) = cursor[model] ===
traces[model].steps.length`. The panel shows the **animation op-count** `cursor[model]` /
`steps.length` (internal work) and the **headline `roundTrips`** (the challenge metric).

### Topology

**One sim node, `DM`** (`nodeIds: ['DM']`), owns everything. No network, no messages —
the three-panel view is a UI rendering of `DM`'s inspect tree, not three sim nodes.

---

## 3. Interaction & chaos

`chaos: []` (no ChaosToolbar). All reader actions are **external commands to `DM`**:

- **`{cmd:'set-query', query, root?}`** — pick the scenario (and, for `fof`, the start
  user); recomputes all three traces, resets all cursors to 0, and **resets that query's
  challenge epoch** (`c1` for `fof`, `c2` for `m2m`) so a win only counts when the reader
  drove this run (the Ch3/Ch8/Ch12 no-auto-win lesson).
- **`{cmd:'add-field'}`** — the schema-flex write: sets `schema.nicknameAdded = true`;
  the document/graph shapes absorb it with **0 migration steps**, relational shows the
  ALTER/NULL-backfill cost. Latches `c3`.
- **`{cmd:'reset-schema'}`** — clears `nicknameAdded` (lets C3 be retried).
- **Step / play** — advance ticks; cursors advance, op-counts climb, models finish at
  different times.

---

## 4. Challenges (engine-verified win conditions)

Each win is UI-flag-gated per epoch; each is a separate sim in the pinned lesson test,
asserted clause-by-clause. Thresholds are fixture-fixed (deterministic — no seed
sensitivity here, since the dataset is fixed and the traces are pure).

| # | Name | Setup → win condition |
|---|------|-----------------------|
| **C1** | **Friends-of-friends: the join tax** (§4 signature) | `set-query fof` → play to completion. All three return `{dan,eve,frank}` — **same answer** — but **`document.roundTrips ≥ FOF_MULT · graph.roundTrips`** (document ~6 round trips vs graph's 1 traversal). **Win = all done ∧ the round-trip gap.** |
| **C2** | **Many-to-many: documents can't join** | `set-query m2m` → play to completion. Same answer set, but **`document.roundTrips ≥ M2M_MULT · relational.roundTrips`** — the document model has no join, so it scans every user doc and fetches each liked post (~12 round trips); the join table and the graph answer in one query. **Win = all done ∧ the round-trip gap.** |
| **C3** | **Schema flexibility: read vs write** | `add-field` (adds `nickname` to one user). **`migration.document === 0 ∧ migration.graph === 0 ∧ migration.relational > 0`** — schema-on-read absorbs the new field per-document; schema-on-write needs an ALTER + NULLs for every existing row. **Win = the field added with 0 document migration.** |

---

## 5. UI, debrief, wiring

**ModelShifterLab** — three-panel comparison:
- **Control strip:** a scenario picker (`friends-of-friends` / `likes-in-category` /
  `add a field`), and for FoF a start-user select.
- **Three `ModelPanel`s side by side** — Relational (tables + the join table), Document
  (doc cards, ids shown as unresolved links), Graph (an adjacency/node view). Each
  highlights the element the current cursor `touched`, shows its **op-count**
  (`cursor / cost`), a **done** badge, and the result set when finished. Rendering is
  `variant`-dispatched inside `ModelPanel` (one focused sub-render per shape; the graph
  SVG is the heaviest piece).
- **Step / play / forward-only `TimelineScrubber`** (Ch8 lesson) — shown for the two
  **query** scenarios (`fof`, `m2m`). For the **`add a field`** scenario (C3) there is no
  trace to animate: the transport is hidden/disabled and the panels show an immediate
  before/after of the storage shape, so a reader never presses play expecting motion that
  never comes.
- **`ChallengePanel` ×3** — predict → drive → win banner, reading `inspect().ch.c1/c2/c3`
  (the Ch1/Ch12 wiring; the module latches the flags).
- `MetricsPanel` — the three op-counts over time (graph flat-lines early, document climbs).

**Debrief (2.d, `content/ch02/debrief.mdx`)** — mirrors `raft/Debrief.tsx`, journal key
`ddia:ch02:journal`. Covers, in order: the headline (the model decides which questions
are cheap); **relational vs document** — the object-relational impedance mismatch,
normalization vs denormalization, one-to-many (docs win — locality) vs many-to-many (docs
lose — no join); **the graph model** — many-to-many as a first-class citizen, traversals,
Cypher-style declarative queries; **schema-on-read vs schema-on-write** — flexibility vs
guarantees; **declarative vs imperative** query languages (SQL/Cypher vs hand-rolled
loops), with a forward-pointer to Ch10 MapReduce as the imperative extreme; the named cuts
(§1 Out). Real systems: PostgreSQL/MySQL (relational), MongoDB/Couchbase (document),
Neo4j/`Cypher` + RDF/SPARQL (graph); the note that most real stacks are **polyglot** —
the right model per workload. Terms: relational / document / graph model, normalization,
denormalization, one-to-many, many-to-many, object-relational mismatch, schema-on-read,
schema-on-write, declarative vs imperative query, locality, N+1.

**Wiring:** catalog already ships `{ id:'2.1', label:'Model Shape-Shifter', status:'soon'
}` with **no `2.d`** — so flip `2.1` → `active`, **add** `2.d`, and **add a new ch2 test**
to `catalog.test.ts` (there is no ch2-specific test today, only the order-list entry —
mirror the ch1/ch12 tests asserting `['2.1','2.d']` both `active`); App
PAGES entries with aliased imports `ModelShifterLab` + `ModelsDebrief`; README ch2 block +
counter bump ("Twelve chapters live — …"); DESIGN_PLAN.en §7 note (**the whole book is
done**). This is the final chapter — the roadmap's Phase 5 completes here.

---

## 6. Testing strategy (TDD, mirrors Ch1/Ch12)

- **`models-shared.ts`** — the fixture, the trace types, and the three pure runners.
  Pinned test: exact `result` sets + exact `cost` for FoF(alice) and the m2m query.
- **`models.ts`** — behavioral gate tests:
  - **stepping** — `init` arms the step timer; each tick advances every not-done cursor by
    one; a finished model's cursor holds at `steps.length` while others advance.
  - **set-query** — recomputes traces + resets cursors; switching scenarios is clean.
  - **schema-flex** — `add-field` sets `nicknameAdded`; relational migration cost > 0,
    document/graph = 0; `reset-schema` clears it.
- **Property suite** (a counterexample is a real bug: shrink, report, fix minimally,
  document):
  - (a) **same answer, three models** — for every `query ∈ {fof, m2m}` and every root user,
    `runGraph`, `runDocument`, `runRelational` return the **identical sorted result set**.
  - (b) **trace determinism** — a runner called twice on the same `(db, query)` yields an
    identical trace.
  - (c) **cursor safety** — the step timer never advances a cursor past its
    `trace.steps.length`, and `cost === steps.length` for every trace.
- **Pinned lesson test** — the three challenge scenarios, each its own sim, asserted
  clause-by-clause (C1/C2 cost ratios after play-to-completion; C3 migration split).
- **ModelPanel** — jsdom presentational tests (the three shapes render; the touched
  element highlights; the op-count + done badge show).
- **ModelShifterLab** — smoke + challenge-wiring tests.

Gate each task: `npx vitest run && npx tsc -b && npm run build`. Ship gate adds a browser
DoD walk (vite + playwright) driving ≥ C1 to its live win banner, 0 console errors.

---

## 7. File plan

- `src/modules/models-shared.ts` (+ `.test.ts`)
- `src/modules/models.ts` (+ `.test.ts`, `.property.test.ts`, `models-lesson.test.ts`)
- `src/ui/labs/models/ModelShifterLab.tsx` (+ `.test.tsx`)
- `src/ui/labs/models/ModelPanel.tsx` (+ `.test.tsx`)
- `src/ui/labs/models/Debrief.tsx`
- `content/ch02/debrief.mdx`
- Edits: `src/ui/shell/catalog.ts` (+ `catalog.test.ts`), App PAGES, `README.md`,
  `docs/DESIGN_PLAN.md` + `.en.md`.

## 8. Risks / notes

- **C1/C2 wins are deterministic, not seed-based** — the fixture is fixed and the runners
  pure, so the cost ratios always hold; the epoch reset on `set-query` is what enforces
  "the reader drove it" (not seed variance). This is the intended difference from the
  stochastic Ch1 lab; the property suite still covers the seed-independent invariant
  (result-set equality) and the lesson test pins the exact ratios.
- **Fixture must guarantee the ratios** — friendships/likes are chosen so FoF gives
  `document.roundTrips (~6) ≥ 2× graph.roundTrips (1)` and m2m gives
  `document.roundTrips (~12) ≥ 2× relational.roundTrips (1)` with margin. Since graph and
  relational are always 1 round trip, the ratios are robust; if a runner refactor changes
  `roundTrips`, the pinned lesson test catches it — re-tune the fixture, not the threshold.
- **C3 is a write-shape scenario, not a traversal** — it has no animated trace; it toggles
  `schema.nicknameAdded` and the panels re-render the storage shapes. Keep its "migration
  cost" honest: relational cost = 1 ALTER + the count of existing rows that get a NULL,
  document/graph = 0. Documented in the debrief as schema-on-read vs schema-on-write.
- **Op-count legibility under play** — `STEP_EVERY` paces one op per model per cadence
  tick so the race is watchable; if all three finish too fast to see, the step button and
  the scrubber make it inspectable frame-by-frame (challenges don't rely on race timing —
  they gate on *completion*, not on catching a mid-race frame, avoiding the Ch12 C2
  batching bug).
- **Pre-attempt latch (accepted, consistent with Ch1)** — C1/C2 read the module-latched
  flag and the default query is `fof`, so a reader who plays FoF to completion *before*
  starting the C1 attempt latches `c1` and then instant-wins the attempt. This is the same
  module-flag behaviour as every prior lab; the `set-query` epoch reset makes the guided
  flow (pick scenario → predict → play) clean, and it is not worth special-casing.
- **Result-set equality is the one true invariant** — everything else (cost, step order)
  is model-specific. Property (a) is the assertion that most protects the lesson's honesty:
  if two models disagreed on the answer, the "same question, different cost" story would be
  a lie.
