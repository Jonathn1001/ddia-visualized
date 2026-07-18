# DDIA Visualized

Interactive learning labs that turn "Designing Data-Intensive Applications"
into browser simulations you can break: kill nodes, partition networks,
reorder messages — and watch what happens to your data.

**Live: <https://jonathn1001.github.io/ddia-visualized/>**

Design: [`docs/DESIGN_PLAN.en.md`](docs/DESIGN_PLAN.en.md) (canonical; Vietnamese v1.1 original: [`docs/DESIGN_PLAN.md`](docs/DESIGN_PLAN.md)).

## Status

**Nine chapters live — sixteen interactive labs.**

**Ch.3 — Storage Engines:**
- **3.1 LSM-Tree vs B-Tree** — the same keys drive both engines side-by-side; memtable → SSTable flush → compaction with bloom filters next to a page-splitting B-tree, and a write/read/space amplification scoreboard. Challenges: *crash mid-write — what does the WAL save?*, *disk-full — compaction stalls vs the split is refused*, *torn write — detect the corruption*.

**Ch.4 — Encoding & Dataflow** (three standalone API-style flows; same profile load, three shapes):
- **4.1 REST** — resource-oriented: 1 + N round trips, verbose JSON. Challenge: *drop a request → a partial page, not total failure*.
- **4.2 GraphQL** — one query, exact shape, hidden server-side N+1. Challenge: *drop the one query → the whole page fails (all-or-nothing)*.
- **4.3 gRPC** — compact binary, field-number schema evolution. Challenge: *bump the server to v2 (adds a field) → the v1 client still decodes*.

**Ch.5 — Replication:**
- **5.1 Replication Theater** — leader/followers, async/sync ack toggle. Challenge: *produce a stale read*.
- **5.2 Multi-Leader Conflicts** — two datacenters, last-write-wins. Challenge: *make an acknowledged write silently disappear*.
- **5.3 Leaderless Quorum** — Dynamo `w`/`r`, read-repair, sloppy quorum + hinted handoff. Challenge: *sloppy quorum loses an acked write*.

**Ch.6 — Partitioning:**
- **6.1 Consistent Hashing Ring** — virtual nodes, minimal migration. Challenge: *create a hotspot*.

**Ch.7 — Transactions:**
- **7.1 Isolation Anomaly Lab** — one preset schedule, four isolation levels running side-by-side (Read Uncommitted / Read Committed / Snapshot Isolation / Serializable-as-serial-execution); step the interleaving op-by-op and watch each anomaly die at a successive rung. Challenges: *read a lie (dirty read)*, *the vanishing increment (lost update)*, *nobody's on call (write skew under SI — Kleppmann's doctors)*.

**Ch.8 — The Trouble with Distributed Systems:**
- **8.1 Unreliable Network Playground** — a lease lock service, two check-then-act workers and a shared store over a genuinely unreliable network (latency/drop/duplicate/partition sliders). Challenges: *the lease is a lie (GC-pause the holder — DDIA fig 8-4)*, *fence it (same failure, fencing tokens on)*, *the clock lies too (corruption via a slow clock, no pause at all)*.

**Ch.9 — Consistency & Consensus:**
- **9.1 Raft + Linearizability Checker** — a five-node Raft cluster: randomized-timeout elections, log replication, the §5.4.2 commit restriction, and a client history table feeding a Wing–Gong linearizability checker. Challenges: *the minority cannot decide (partition the leader — its write hangs pending)*, *heal and repent (the dangling write is truncated away, logs converge)*, *catch the stale read (a deposed leader answers from the past — the checker proves the violation)*.

**Ch.10 — Batch Processing:**
- **10.1 MapReduce vs Dataflow** — the same URL-count job on two engines side by side: a MapReduce engine that materializes every map output to local disk behind a hard stage barrier, and a dataflow engine that streams records straight to reducers. Healthy, the pipeline finishes first; kill a worker and the trade flips. Challenges: *kill a mapper mid-task (its map re-runs elsewhere, output stays exact)*, *done isn't safe until fetched (a done-but-unfetched map dies with its disk and re-runs)*, *same kill, unequal damage (the dataflow side wastes more — no checkpoint to fall back on)*.
- **10.d What you just broke** — materialization vs pipelining, the skew you saw, joins as the deferred half of batch, and how Spark's lineage and Flink's checkpoints beat restart-from-input.

**Ch.11 — Stream Processing** (three standalone broker flows; same workload, three delivery fates):
- **11.1 Kafka Log** — replayable log, offset commits, session-timeout replay. Challenge: *make the group process a message twice*.
- **11.2 RabbitMQ Queue** — destructive queue, per-message acks, ack-timeout redelivery + dead-letter. Challenge: *resurrect a message on the survivor*.
- **11.3 Redis Pub/Sub** — fan-out, fire-and-forget, no storage. Challenge: *lose a message forever*.

Each chapter ends in a **Debrief & Journal** page.

Phase 0 — deterministic simulation engine (`src/engine/`): discrete-event loop
with a virtual clock, seeded RNG, chaos-capable SimNetwork, snapshot/replay
scrubbing, and the `SimModule` plug-in contract (v0.2). A token ring with
retransmission (`src/modules/pingpong.ts`) is still browsable in the **0.1** tab.

## Using the labs

Open the [live site](https://jonathn1001.github.io/ddia-visualized/) (or run it locally — see [Develop](#develop)). Pick a lab from the **chapter sidebar** on the left; active labs are clickable, the rest are marked `soon`.

Every lab shares the same anatomy:

| Piece | What it does |
|---|---|
| **Cluster view** | The nodes and messages in flight. Dead nodes turn coral. |
| **Timeline scrubber** | Play / pause / step the simulation, or **drag backwards through time** to replay (hybrid snapshot + replay). |
| **Client controls** | Write / read keys at a chosen node. Lab-specific knobs too (e.g. `w`/`r`/sloppy and a coordinator picker in 5.3). |
| **Metrics panel** | Live countable numbers — stale reads, conflicts, load skew, hints outstanding, … |
| **Chaos toolbar** | Inject the faults the lab declares: **kill/revive** a node, **partition** (check the nodes to isolate, then **split**), **latency**, **drop %**, **duplicate %**. |
| **Chaos Challenge** | An engine-verified mission (see below). |

### Playing a Chaos Challenge

1. Read the mission (e.g. *"make an acknowledged write silently disappear"*).
2. Optionally type a **prediction** of how you'll cause it, then click **start attempt**.
3. Drive the simulation — issue writes/reads and inject chaos — to trigger the win condition.
4. The **engine verifies** the win (not a checkbox — it inspects real node state) and reveals your prediction against what actually happened.

Worked example — 5.2 lost write: *start attempt → write the same key at DC1 and DC2 → play*. Last-write-wins keeps one and silently discards the other; the engine catches the acked-but-discarded write and completes the challenge.

### Determinism & sessions

Same seed + same actions → identical run (verified by an event-log hash). All input enters through the event queue, so any session is **recordable and replayable**. **Export session** downloads your action log + "what surprised you" journal as JSON. **Reset (new seed)** rebuilds the lab with a fresh seed.

## Architecture

```
src/engine/    pure TypeScript sim core — zero React/DOM (lint-enforced)
src/modules/   one SimModule per lab (pingpong, replication, multileader,
               leaderless, hashring, kafkalog, rabbitqueue, redispubsub,
               rest, graphql, grpc)
src/ui/kit/    reusable Lab Kit — ClusterView, RingView, BrokerInternals,
               MetricsPanel, TimelineScrubber, ChaosToolbar, ChallengePanel,
               KVControls, SurpriseJournal
src/ui/        React 19 + Tailwind + Zustand; SimDriver rAF bridge
content/       per-chapter MDX debriefs
```

Each node is a **pure reducer** `(state, event) => [state', effects[]]` — the code
reads like the protocol pseudocode in the book. A lab is a thin assembly of a
module plus kit components; adding a lab means writing one pure module and wiring
one page.

## Develop

    npm install
    npm run dev         # Vite dev server
    npm test            # unit + property tests (fast-check)
    npm run coverage    # with 80% gate on engine+modules
    npm run lint
    npm run typecheck
    npm run build

CI (GitHub Actions) runs all gates plus a ≤ 500 KB gzip bundle budget, then
deploys `master` to GitHub Pages.
