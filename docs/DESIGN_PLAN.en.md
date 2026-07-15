# DDIA Visualized — Design Plan

**An interactive learning lab that turns every idea in "Designing Data-Intensive Applications" into a visual simulation you can break and play with.**

Version 1.1 — handoff-ready. (English translation of `DESIGN_PLAN.md`.)

> **v1.1 changelog (post-review):** §6 converted to Tech Stack — Final Decisions: dropped XState (settled on hand-written pure reducers), React 18 → React 19, Framer Motion → the `motion` package, added a perf budget. §5 added the Timeline scrubber mechanism (hybrid snapshot + replay), Module contract v0, Determinism & input recording, and rAF batching for the UI bridge. §1 added Non-goals. §3 settled on an in-repo MDX knowledge base; marked the RAFT attack paper as citation-needed. §4 Ch9 names the linearizability checking algorithm. §9 added measurable Definitions of Done for Phase 0/1. §2 fixed the Oddity citation. Added Appendix — Open Questions.

> **v1.2 changelog (Phase 1 kickoff, 2026-07-10):** Story mode replaced by annotated replay (§3). §5: contract bumped to v0.2 (events + metrics carry virtual time); snapshot interval fixed at N = 500; deep-clone wording corrected; chaos-vocabulary status notes added. §9: Phase 0 DoD checked off; Phase 1 DoD replaced by v2 (spec: `docs/superpowers/specs/2026-07-10-phase1-lab-kit-design.md`). Appendix: (c) resolved → GitHub Pages; share URLs deferred; added (e) RNG stream split. English version is canonical from v1.2.

---

## 1. Product Vision

The problem with reading DDIA: the book describes *dynamic* systems (messages flying across the network, nodes dying, logs being replayed) through a *static* medium (text and figures). The reader has to run the simulation in their head — and that is precisely the hardest part.

DDIA Visualized inverts this: every concept in the book becomes a **simulation that runs in the browser**, where you don't just *watch* the system work but *intervene* in it — kill nodes, slow down the network, send concurrent writes — and observe the consequences. Core philosophy: **"Don't read about split-brain. Cause a split-brain yourself."**

What makes this different from just reading: every visualization is designed around a *trade-off question* and a *failure mode* — mapping directly onto the learning project's 3 guiding questions, and onto the attacker/AppSec mindset you are training (asking "how do I break it?" instead of "how does it run?").

### Non-goals — do not build

- **No backend / API server** — everything runs client-side, deployed as a static site.
- **No user accounts / auth.**
- **No persistence** beyond `localStorage` + file export/import (action logs, scenarios).
- **No mobile layout** — desktop-first; small viewports show a blocking notice (like dbviz's `DesktopOnlyGate`).
- **No real database engine / production-accurate implementation** — this is an educational simulation: faithful to the original papers + TLA+ specs, not a re-creation of any specific system's implementation details.

## 2. Prior Art Research — what others have built, and where the gap is

A survey of existing projects on the internet reveals a fragmented ecosystem with plenty of valuable lessons:

**The Secret Lives of Data (thesecretlivesofdata.com)** — the gold standard of the genre. A guided-tutorial visualization of Raft that walks the viewer through each phase of the algorithm with SVG animation and step-by-step narration. Lesson: a **story-driven walkthrough** is extremely effective for first contact with an algorithm. Limitation: Raft only, no free-form interaction.

**RaftScope (raft.github.io)** — a Raft cluster running right in the browser, 5 servers on the left, their logs on the right, with direct user interaction. The Raft site itself acknowledges Secret Lives of Data as the "more guided and less interactive" approach, better suited as a gentler starting point. Lesson: a **free-form sandbox** is the second layer of learning, after the guided tour.

**visual.ofcoder.com** — extends the idea: Basic-Paxos, Multi-Paxos, Raft, and even Basic-Kafka. Proves the format scales to multiple algorithms, including messaging systems.

**CloudScope (University of Maryland)** — a distributed systems simulator using discrete event simulation for message passing between replicas, describing the network with a JSON topology, generating workloads, and rendering with SVG/JavaScript animation. The most important architectural lesson: **separate the simulation engine from the visualization layer** — the engine runs discrete events, the UI is just one consumer of the event stream.

**Oddity (Doug Woos, University of Washington)** — a graphical debugger for distributed systems, used to reproduce a real bug in Raft reconfiguration. Lesson: the ability to **control message ordering** (delay, drop, reorder) is the single deepest insight-generating tool.

**Data structure visualizers** (USF's B+Tree visualizer, the LSM-tree topic repos on GitHub) — scattered around but divorced from the context of "why a database chooses this structure".

**Market gap:** there is already a GitHub topic `designing-data-intensive-applications` with a few React/TypeScript visualization repos, but no project yet that (a) covers all 12 chapters as one coherent journey, (b) combines all 3 modes guided/sandbox/chaos, and (c) ties every simulation to trade-off and failure analysis in the true spirit of DDIA. That is this project's niche.

## 3. Design Concept: each chapter = one Lab with 3 modes

Each concept is packaged as a **Lab**. Every Lab shares the same 3-layer structure, moving from passive to active:

**Mode 1 — Story (guided walkthrough).** Secret Lives of Data style: step-by-step animation with narration; the user clicks Next to walk through the canonical scenario. Answers guiding question #1: *how is data stored, read, written, propagated?* *(v1.2: Story mode is dropped as a built deliverable — replaced by **annotated replay**: a recorded sandbox session (action log) annotated in MDX. The primary learner is the builder; authoring annotations is itself active recall.)*

**Mode 2 — Sandbox (free play).** RaftScope style: a live cluster/data structure; the user sends requests, adds data, tweaks parameters (node count, quorum size, memtable threshold...) and watches the system react. A **metrics panel** displays real-time numbers (throughput, latency, disk reads, replication lag) to answer question #2: *what is the system trading away?*

**Mode 3 — Chaos (fault injection).** The project's signature, inspired by Jepsen and Oddity: the user gets a Chaos Toolbar to **kill nodes, partition the network, delay/drop/duplicate/reorder messages, skew clocks**. Each Lab ships with 2–3 **Chaos Challenges** as missions: *"Produce a stale read"*, *"Lose an acknowledged write"*, *"Cause a split-brain"*. Answers question #3: *when the system partially fails, is the data still correct?* — and this doubles as adversarial-thinking practice for your AppSec goal (a 2026 paper even analyzed RAFT through the lens of replay/forgery attacks `[citation needed — recover the link]` — an interesting future extension).

After each Lab comes a **Debrief** page: trade-off summary, real-system examples (what Postgres does, what Cassandra does, what Kafka does), terminology, and a link to the corresponding chapter notes. Chapter notes live **in-repo as MDX** at `content/chapters/chNN/` — the same MDX pipeline as the Debrief (§5); syncing to external systems is covered in Appendix — Open Questions.

## 4. Chapter → Visualization Map

| Ch. | Book topic | Lab visualization | Signature chaos challenge |
|---|---|---|---|
| 1 | Reliability, Scalability, Maintainability | **Load simulator**: a simple web system; drag a slider to raise traffic, watch where p50/p95/p99 latency breaks; add a cache/replica to rescue it | Raise load until tail latency explodes; find the bottleneck |
| 2 | Data models | **Model shape-shifter**: the same data (a social graph) rendered as relational tables / JSON documents / a graph; run the same query on all 3 models, compare step counts | Query "friends of friends" on the document model — feel the pain of joins |
| 3 | Storage engines | **LSM-tree vs B-tree side-by-side**: type key-values, watch memtable → SSTable flush → compaction, bloom filter checks; next to it a B-tree splitting pages. A disk I/O counter for every operation | Crash mid-write — what does the WAL save? Compare write amplification on both sides |
| 4 | Encoding & evolution | **Schema evolution playground**: encode a record with JSON/Avro/Protobuf, inspect the byte layout; change the schema, let an old reader read new data | Delete a required field — where does the old reader blow up? |
| 5 | Replication | **Replication theater**: leader-follower with an async/sync toggle, multi-leader with conflicts, leaderless with quorum r/w sliders | Produce a stale read via replication lag; write conflict on multi-leader; sloppy quorum losing data |
| 6 | Partitioning | **Consistent hashing ring**: add/remove nodes and watch keys move; compare hash vs range partitioning; hot-key heatmap | Create a hotspot with a skewed workload; rebalance when a node dies |
| 7 | Transactions | **Isolation anomaly lab**: two transactions running concurrently on a drag-and-drop timeline; arrange the operations yourself to produce dirty reads, lost updates, write skew; switch isolation levels to see which anomalies get blocked | Reproduce write skew under snapshot isolation (Kleppmann's on-call doctors problem) |
| 8 | Trouble with distributed systems | **Unreliable network playground**: send messages over a network with delay/loss/reordering; a process pause (GC) makes a leader "think it's still alive"; clock skew between nodes | Fencing tokens: prove why lock + lease is not enough |
| 9 | Consistency & consensus | **Linearizability checker + Raft**: enter a read/write history, the tool checks whether it's linearizable (checker uses the Wing–Gong/Lowe algorithm with bounded history size — the general problem is NP-hard); full Raft election/log replication sandbox | Cause a network partition during an election; does the minority partition accept writes? |
| 10 | Batch processing | **MapReduce flow**: data flowing through map → shuffle → reduce as particle animation; compared against a dataflow engine (dropping materialization between stages) | Kill a worker mid-job — how does recovery work? |
| 11 | Stream processing | **Kafka-style log**: producers/consumer groups on a partitioned log, offsets moving, consumer rebalancing; windowing (tumbling/hopping) over an event stream | Consumer crashes after processing but before committing its offset → duplicates; what is exactly-once? |
| 12 | Future of data systems | **Unbundled database**: compose the previous Labs into one CDC pipeline: OLTP write → changelog → search index + cache + analytics; watch a single write propagate through the whole system | The index lags the source — what does the user see? |

Selection principle: every Lab must answer all 3 guiding questions, and every visualization must have **at least one countable number** (disk I/O, message count, lag in ms) — because a trade-off only "sinks in" when it is quantified.

## 5. Technical Architecture

The biggest lesson from CloudScope and Oddity: **the simulation engine must be completely separated from rendering**, and it must be **deterministic**.

```
┌─────────────────────────────────────────────────┐
│  UI Layer (React + Tailwind + Motion)            │
│  - SVG/Canvas renderers per lab                  │
│  - Timeline scrubber, Chaos toolbar, Metrics     │
└──────────────▲──────────────────────────────────┘
               │ event stream (subscribe)
┌──────────────┴──────────────────────────────────┐
│  Simulation Core (pure TypeScript, zero React)   │
│  - Discrete event loop + virtual clock           │
│  - Seeded PRNG → every run is reproducible       │
│  - SimNetwork: deliver/delay/drop/partition      │
│  - Node = pure reducer state machine (hand-made) │
└──────────────▲──────────────────────────────────┘
               │ implements
┌──────────────┴──────────────────────────────────┐
│  Protocol/Structure modules (1 module / chapter) │
│  lsm-tree · btree · replication · raft · 2pc ... │
└─────────────────────────────────────────────────┘
```

The key decisions:

**Discrete event simulation with a virtual clock.** No real `setTimeout`. Everything is an event in a priority queue ordered by virtual time. Benefits: (a) fast-forward/slow-motion/pause at will, (b) the **timeline scrubber** — drag backwards through time to replay every step, the killer feature for learning, (c) testable with ordinary unit tests.

**Timeline scrubber — mechanism: hybrid snapshot + replay.** Snapshot the entire sim state every N events (N = 500, validated by the Phase 0 scrub benchmark); scrubbing to time *t* = restore the nearest snapshot ≤ *t*, then deterministically replay up to *t*. The constraint this imposes on the whole engine: **state must be immutable and serializable** (plain objects; the engine deep-clones via `structuredClone` on snapshot/restore), and every side effect may only arise through the event queue — no out-of-band mutation.

**Determinism via seeded RNG.** Same seed + same action sequence = same result. Enables: sharing a scenario by URL, writing Chaos Challenges with verifiable answers, and replaying bugs.

**Determinism & input recording.** Every user action (sending a write, killing a node, dragging a slider) enters the simulation as an **event with a virtual timestamp through the event queue** — never a direct state mutation. As a result, every sandbox session can be captured as an action log. Sharing has two tiers: (a) **URL** `?seed=42&scenario=split-brain` for pre-built scripted scenarios; (b) **action-log export/import as JSON** for free-form sandbox sessions — a URL cannot hold an arbitrary action sequence.

**Nodes are explicit state machines — hand-written pure reducers.** Each node is a pure reducer `(state, event) => [state', effects[]]`: receive an event → return new state + a list of effects (messages to send, timers to set). This is exactly the actor model, and exactly how the book describes the protocols — the code will read like the pseudocode in the papers. **Decision: no XState.** Reasons: (a) no repo in the current stack uses XState (verified across every `package.json` in `~/Projects/Personal`); (b) XState v5 runs actors/delays on real timers by default — embedding it into a discrete event loop with a virtual clock requires a custom clock, directly contradicting the "no real `setTimeout`" principle above; (c) the "statecharts render themselves into diagrams" benefit is overstated — the Stately inspector is a dev tool, not a free in-app embed. If Phase 3 (Raft) shows the statecharts are complex enough to need tooling, run an XState-under-virtual-clock spike then (see Appendix — Open Questions).

**Module contract — deliverable #1 of Phase 0.** "Every later lab is just a plug-in" is only true when the contract is explicit. v0.2 (validated by the Phase 0 engine and the Phase 1 replication lab, `src/engine/module.ts`):

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

The chaos vocabulary splits into two families: **network chaos** (kill node, partition, delay/drop/duplicate/reorder messages, clock skew — for the distributed labs) and **storage chaos** (crash-mid-write, torn write, disk-full — for the Chapter 3 lab, which has no network). Each module declares the capabilities it supports via `chaos: ChaosCapability[]`; the Chaos Toolbar renders dynamically from that declaration. The contract is validated by the first two labs (replication — network; LSM/B-tree — storage) before it is considered stable. *(v1.2 status: `reorder` is not a `ChaosCapability` — reordering emerges from randomized per-message latency. `clock-skew` and the storage family are declared vocabulary without an engine delivery path yet; decide before Ch3/Ch8 — see `docs/superpowers/plans/phase1-carry-forward.md`.)*

**Simulation runs in a Web Worker** for heavy labs (batch processing, large clusters) to keep the UI smooth; events are batched back to the main thread via postMessage.

**UI bridge — batching against re-render storms.** High-frequency sim events do not pour straight into React: they are batched through `requestAnimationFrame` before being written into the Zustand store, and components subscribe via narrow selectors. (Per the re-renders guideline in `~/.claude/docs/react-best-practices.md`.)

**Rendering:** SVG + Motion for most labs (nodes, message dots, log entries — you're already fluent in Framer Motion/`motion`); Canvas only when thousands of elements are needed (the MapReduce particle flow). No full D3 — borrow only `d3-scale`/`d3-shape` where needed.

**Metrics panel:** Recharts, fed by the simulation core.

**Debrief content:** MDX — write notes as markdown while embedding simulation components right inside the article.

## 6. Tech Stack — Final Decisions (matches your current stack)

- **Vite + React 19 + TypeScript strict.** (React 19 is already the norm in the newest projects: `trybuy-fe` `^19.1.1`, `fitness-tracker` `^19.2.6`.)
- **Tailwind** for UI chrome.
- **`motion`** (the current package name of Framer Motion since late 2024) for animation.
- **No XState** — protocol state machines are hand-written pure reducers; full rationale in §5.
- **Zustand** as the simulation ↔ React state bridge (lighter than Redux for this subscribe-heavy use case), receiving updates pre-batched through rAF (§5).
- **Vitest** for the simulation core — **every protocol module must have a property-based test** (fast-check): e.g. "after any random sequence of partitions/heals, Raft never has 2 leaders in the same term". This is both a correctness insurance policy and a mini-lesson in how Jepsen verifies real systems.
- **Static deploy** to Vercel/GitHub Pages — everything runs client-side, no backend needed.

**Perf budget:**

- Bundle ≤ 500 KB gzip for the app shell + engine (excluding MDX content; each lab lazy-loads per route).
- 60 fps with ≤ 50 SVG nodes animated concurrently; beyond that threshold → switch to Canvas.
- Simulation core ≥ 10k events/s in a Web Worker.

## 7. Roadmap

**Phase 0 — Engine (1–2 weeks).** Event loop, virtual clock, seeded RNG, SimNetwork with delay/drop/partition, timeline recorder (snapshot + replay, §5), **module contract v0 (§5)**. Demo with a 3-node ping-pong. *This is the decisive part — do it well, and every later lab is just a plug-in.*

**Phase 1 — Vertical slice: Chapter 5 Replication (2–3 weeks).** Replication is the first lab because it is the heart of DDIA and exercises the whole engine. Full 3 modes + debrief + 3 chaos challenges. Shipping this slice validates the entire concept. *(v1.2 note: shipped 2026-07-10 — leader-follower slice first, then the multi-leader and leaderless follow-up labs; Ch5 complete.)*

**Phase 2 — Storage engines: Chapter 3 (2 weeks).** LSM vs B-tree side-by-side with I/O counters. The difference: this lab is about a data structure, not a network — forcing the engine to be general (and validating the storage-chaos family of the module contract). *(shipped 2026-07-15 — 3.1 LSM/B-tree side-by-side with a write/read/space-amp scoreboard + 3.d debrief; three storage-chaos challenges [crash-mid-write, disk-full, torn-write] wired as `external` fault events; validated the storage-chaos family end-to-end. Ch3 complete.)*

**Phase 3 — Distributed core: Chapters 6, 8, 9 (4–6 weeks).** Partitioning ring → unreliable network → Raft + linearizability checker. The hardest and most valuable cluster.

**Phase 4 — Transactions: Chapter 7 (2–3 weeks).** The isolation anomaly lab with the drag-and-drop timeline.

**Phase 5 — Data flow: Chapters 10, 11, 12 + Chapters 1, 2, 4 (4 weeks).** Finish with the "unbundled database" lab composing everything together.

Suggested working rhythm: **read the chapter → write the notes → build that chapter's lab**. Building is the strongest form of active recall — you cannot code Raft election without truly understanding it, and every gap in understanding surfaces the moment a test fails.

## 8. Risks & Mitigations

**Scope creep** is risk number one — 12 chapters × 3 modes is a lot. Prevention: hard boundaries in Non-goals (§1); Story mode can be just sandbox + a pre-written script (same engine, different data), and accept that some chapters (2, 4) only need a mini-widget instead of a full lab. **Protocol correctness**: don't improvise Raft from memory — stick to the original paper + the TLA+ spec, and let property tests be the referee. **Animation perfectionism**: ship with "good enough to understand" animation first, pretty later; the value is in the simulation, not the easing curves.

## 9. Definition of Success

### Overall success criteria (qualitative)

The project succeeds when: (1) you can explain every lab to someone else without looking at the book — the learning goal; (2) every lab has a chaos challenge that you yourself have "lost" at least once — meaning the simulation is honest enough to teach you something new; (3) the public repo with a demo link becomes a portfolio piece demonstrating distributed systems competence + adversarial thinking for a Backend/AppSec Engineer profile.

### Definition of Done — Phase 0 (measurable)

- [x] Same seed + same action log → identical event-log hash across 100 consecutive runs (automated test).
- [x] Scrubbing backwards across 10k events to any point < 100 ms (benchmark in CI).
- [x] 3-node ping-pong demo passes property tests (fast-check) under random delay/drop/reorder.
- [x] Simulation core has 0 dependencies on React/DOM (enforced by an import lint rule).
- [x] Module contract v0 validated by at least 1 mock module (ping-pong) implementing the full interface.
- [x] Simulation core coverage ≥ 80%.

### Definition of Done — Phase 1 (measurable)

*(v1.2 — replaced by the Lab Kit slice DoD; spec: `docs/superpowers/specs/2026-07-10-phase1-lab-kit-design.md`.)*

- [x] Replication lab (leader-follower) sandbox + chaos runs in the browser.
- [x] "Stale read" chaos challenge with an engine-verified win condition (no grading by eye).
- [x] Metrics panel shows ≥ 3 live numbers (replication lag, write throughput, stale-read count).
- [x] Predict-before-run and surprise journal persist across reload (localStorage).
- [x] Property test: a write acknowledged under sync replication is never lost when 1 follower dies.
- [x] Debrief page published with the Chapter 5 notes (in-repo MDX).
- [x] CI green: typecheck + lint + coverage ≥ 80% (engine+modules) + 10k-scrub benchmark.
- [x] Bundle ≤ 500 KB gzip (measured in CI).
- [x] Site live on GitHub Pages, deployed by CI from master.

## Appendix — Open Questions (deferred)

- **(a) Content language for labs/debriefs:** English (portfolio reach — §9 says the public repo is a portfolio piece) vs Vietnamese (learning speed). Decide before Phase 1 since it shapes the whole content pipeline.
- **(b) Knowledge base sync:** should the in-repo MDX notes sync to an external system (graphify/Notion), or is the repo the single source of truth?
- **(c) Deploy target — RESOLVED (v1.2):** GitHub Pages, deployed by GitHub Actions from master. Custom domain still open.
- **(d) XState spike in Phase 3:** when the statecharts get complex (Raft election), is it worth re-trying XState under the virtual clock — only consider if the pure reducers start becoming hard to read.
- **(e) RNG stream split:** module logic and network chaos share one SeededRng stream — a reducer's extra draw shifts downstream network fates for the same seed. Split into decoupled streams if per-module hash stability matters. Decide before Phase 3 (Raft election jitter). See `docs/superpowers/plans/phase1-carry-forward.md`.
- **(f) Share URLs `?seed=&scenario=`:** deferred from Phase 1 (v1.2) — action-log export/import covers the self-learning use case; revisit when labs get an audience.
