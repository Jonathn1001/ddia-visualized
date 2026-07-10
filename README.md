# DDIA Visualized

Interactive learning labs that turn "Designing Data-Intensive Applications"
into browser simulations you can break: kill nodes, partition networks,
reorder messages — and watch what happens to your data.

**Live: <https://jonathn1001.github.io/ddia-visualized/>**

Design: [`docs/DESIGN_PLAN.en.md`](docs/DESIGN_PLAN.en.md) (canonical; Vietnamese v1.1 original: [`docs/DESIGN_PLAN.md`](docs/DESIGN_PLAN.md)).

## Status

**Phase 1 — Replication lab (Ch5) shipped.**

- **Replication lab**: leader-follower cluster with an async/sync ack toggle,
  per-node reads/writes, live metrics (replication lag, acked writes,
  stale-read count), and a chaos toolbar (kill, partition, latency, drop).
- **Chaos Challenge**: *produce a stale read* — win condition verified by the
  engine, with a predict-before-run prompt (write your hypothesis, then compare
  against what actually happened).
- **Debrief**: Chapter 5 notes (MDX) + a "what surprised you" journal, exported
  together with the action-log session.
- **Timeline scrubber**: drag backwards through time; hybrid snapshot + replay.

Phase 0 — deterministic simulation engine (`src/engine/`): discrete-event loop
with a virtual clock, seeded RNG, chaos-capable SimNetwork, snapshot/replay
scrubbing, and the `SimModule` plug-in contract (v0.2). First module: a token
ring with retransmission (`src/modules/pingpong.ts`), still browsable in the
**pingpong** tab.

## Architecture

```
src/engine/    pure TypeScript sim core — zero React/DOM (lint-enforced)
src/modules/   one SimModule per lab (pingpong, replication)
src/ui/        React 19 + Tailwind + Zustand; SimDriver rAF bridge + Lab Kit
content/       per-chapter MDX debriefs
```

Every run is deterministic: same seed + same action log → identical event-log
hash. All user input enters the sim through the event queue, so any session is
recordable and replayable.

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
