# Phase 1 Carry-Forward — engine friction to decide before labs land

Captured from the Phase 0 whole-branch review (2026-07-08). None require a breaking
change to `SimModule<S,P>` for Phase 1 replication specifically, but each is concrete
friction for the harder labs. Decide/document before the relevant lab.

## Contract & architecture

- **Shared RNG stream couples module logic to network chaos.** `reduce` and
  `network.plan` draw from the same `SeededRng`. Adding one rng draw inside a reducer
  shifts every downstream network latency/drop for the same seed. Also: reordering two
  `send` effects in a reducer changes which latency each message draws — deterministic,
  but not cosmetic to the hash. Either document this in the module-authoring guide, or
  split into decoupled streams (module-logic RNG vs network RNG) if per-module stability
  matters. *(Decide before Phase 3 Raft, where election-timeout jitter lives in reduce.)*

- **No public accessor for in-flight events.** `Simulation` exposes `pending` and the
  delivered `eventLog`, but the message queue is `protected`. The §5 "message dots flying
  across the network" renderer needs in-flight messages (from/target/delivery-time). Add a
  read-only `inFlight()` over `queue.toArray()` — no contract change. *(Phase 1 renderer
  reaches for this first.)*

- **`LoggedEvent` can't distinguish delivered vs partition-blocked/dead-node.** Both are
  logged; the skip is silent. The timeline will animate a message "arriving" that was
  dropped at delivery. Add `delivered: boolean` (or `dropReason`) to `LoggedEvent`.
  *(Affects "lose an acknowledged write" chaos-challenge grading in Phase 1.)*

- **Storage chaos (Phase 2) has no path to `reduce`.** `crash-mid-write`/`torn-write`/
  `disk-full` are declared in `ChaosCapability` but `control` events never reach modules by
  design. The escape hatch exists: `external(target, payload)` reaches `reduce` as an
  `'external'` event. Designate `external` as the module-specific chaos channel (or add a
  `{ type: 'module'; payload }` `ControlAction` variant) and write it down. *(Before Ch3.)*

- **No timer cancellation; no dynamic membership.** Raft resets its election timer on every
  heartbeat — the contract forces the self-invalidating-timer pattern (pingpong's
  `pendingToken !== retransmit`), workable but boilerplate-heavy. And `states` is populated
  only in the constructor, so Ch6 (add/remove node) and Ch9 (Raft reconfiguration) can't
  grow the cluster at runtime. Both Phase 3, both addable without breaking the contract.

- **`metrics(states)` has no `time` or history.** Phase 1 DoD wants throughput and lag
  (rates), which need a time window. Consider passing `time` (and the previous sample) to
  `metrics` so every lab doesn't reinvent rate computation.

- **"Plain serializable object" for `S`/`P` is convention, not enforced.** `structuredClone`
  clones a `Map`/`Set`/`Date` (so `snapshot` won't throw), but a `Map` in a *payload*
  silently `JSON.stringify`s to `{}`, defeating `hashEventLog` content-sensitivity; a
  function/class instance makes `structuredClone` throw at runtime. Add a dev-mode assertion
  in `snapshot()`/`schedule()` (round-trip `JSON.stringify` off the production path) or a
  prominent note in the authoring guide.

## Minor consistency

- **`applyControl` `'net'` doesn't deep-clone `a.opts`.** `Object.assign(this.network.opts,
  a.opts)` aliases a retained `opts.latency` array until the next snapshot, inconsistent with
  the deep-clone discipline used in `partition`/`snapshot`/`restore` (Task 4 decision). One-line
  `structuredClone` fix when next touching `sim.ts`.

## Carried Minors (non-blocking, from per-task gates)

- `network.test.ts`: snapshot test doesn't mutate a nested group element (deep-clone already
  asserted via the `partition` test — redundant, add opportunistically).
- `recorder.ts`: `scrubTo` backward-branch `break` assumes `snapshots` stays index-ascending
  (performance-only invariant, not correctness — add a one-line comment).
- Coverage is aggregate-only; `fixtures.ts` (test-support, never ships) sits at 50% funcs and
  drags the aggregate *down*, so shipping code is above the reported 92%. Optionally exclude
  `src/engine/fixtures.ts` from coverage `include`.
- DESIGN_PLAN §5 doc block omits the `P = unknown` default type param that real `module.ts`
  has (cosmetic doc fidelity).
