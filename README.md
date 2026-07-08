# DDIA Visualized

Interactive learning labs that turn "Designing Data-Intensive Applications"
into browser simulations you can break: kill nodes, partition networks,
reorder messages — and watch what happens to your data.

Design: [`docs/DESIGN_PLAN.en.md`](docs/DESIGN_PLAN.en.md) (Vietnamese original: [`docs/DESIGN_PLAN.md`](docs/DESIGN_PLAN.md)).

## Status

Phase 0 — deterministic simulation engine (`src/engine/`): discrete-event
loop with a virtual clock, seeded RNG, chaos-capable SimNetwork,
snapshot/replay timeline scrubbing, and the `SimModule` plug-in contract.
Demo module: a token ring with retransmission (`src/modules/pingpong.ts`).

## Develop

    npm install
    npm test            # unit + property tests
    npm run coverage    # with 80% gate
    npm run lint
    npm run typecheck
