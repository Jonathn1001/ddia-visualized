# Phase 1 v2 — "Lab Kit + Replication Slice" Design

Date: 2026-07-10. Status: approved (brainstorm sections 1–4 approved in session).
Supersedes the Phase 1 shape described in `docs/DESIGN_PLAN.en.md` §7/§9 (v1.1);
those sections get a v1.2 sync as part of this work (see "Design-doc updates").

## Goals & constraints (from brainstorm)

- Primary learner: **the author, while building** — features optimize for
  self-learning, not first-time visitors.
- Coverage stays **all 12 chapters, uneven depth** (full labs for hard chapters,
  mini-widgets for easy ones), but this phase ships one slice.
- Priorities: learning effectiveness, ship faster/smaller, engine quality.
  Portfolio polish explicitly deprioritized.
- **Goal: a hosted version on GitHub Pages** (resolves DESIGN_PLAN Appendix (c):
  deploy target = GitHub Pages).

## Scope

### In

- Vite + React 19 + TypeScript strict + Tailwind + Zustand + `motion` app shell
  (per DESIGN_PLAN §6, unchanged).
- **Lab Kit** — reusable components: `ClusterView`, `ChaosToolbar`,
  `MetricsPanel`, `TimelineScrubber`, plus the sim↔React bridge
  (`SimDriver`, `simStore`).
- **Replication lab v1: leader-follower only**, async/sync toggle.
  Multi-leader and leaderless quorum are follow-up iterations, not this slice.
- **One chaos challenge**, engine-verified: *"Produce a stale read."*
- Pedagogy: **predict-before-run** prompt and **surprise journal** in the
  debrief (both persisted to `localStorage`).
- Short Debrief page (MDX) for Chapter 5.
- Engine changes pulled by need (contract v0.2): `inFlight()`,
  `LoggedEvent.delivered`/`dropReason`, `metrics` time parameter.
- **CI** (GitHub Actions): typecheck + lint + coverage gate + scrub benchmark.
  Committing `.github/workflows/` was explicitly approved (exception to the
  global "no config files" git policy — no secrets in it).
- **Deploy to GitHub Pages**: deploy workflow publishes the Vite build after CI
  passes; Vite `base` set for project pages (`/<repo-name>/`).

### Out (explicit)

- **Story mode — dropped globally.** Replaced by a future *annotated replay*
  concept: record a sandbox session via the existing action log, annotate it in
  MDX. Authoring annotations doubles as active recall for the builder.
- Multi-leader and leaderless replication.
- Web Worker (defer until profiling demands; rAF batching first).
- Share URLs `?seed=&scenario=` (defer; action-log export/import suffices for
  self-use). Moves to DESIGN_PLAN Appendix as deferred.
- RNG stream split (defer to Phase 3 per `phase1-carry-forward.md`).

### Prerequisite

GitHub Pages requires the repo pushed to GitHub with Pages enabled
(Source: GitHub Actions). Repo currently has no remote — creating/pushing the
public repo is a user-confirmed step at execution time.

## Architecture

```
src/
  engine/          # unchanged discipline: zero React (lint-enforced)
  modules/
    pingpong.ts
    replication.ts # new SimModule: leader-follower
  ui/
    kit/           # reusable Lab Kit
      ClusterView.tsx      # SVG nodes + in-flight message dots
      ChaosToolbar.tsx     # renders from module.chaos[]
      MetricsPanel.tsx     # Recharts, live samples
      TimelineScrubber.tsx # wraps TimelineRecorder
    bridge/
      SimDriver.ts         # rAF loop: steps sim at speed multiplier, batches
      simStore.ts          # Zustand store, narrow selectors
    labs/
      replication/         # lab page assembling kit + module
  content/
    ch05/debrief.mdx
```

Data flow, one direction:

```
user action → action log → sim.control()/external() → engine steps (SimDriver, rAF)
→ batched snapshot {nodes, inFlight, metrics, logTail} → Zustand → components (selectors)
```

- Engine stays main-thread. `SimDriver` steps N events per frame according to a
  speed setting; pause = stop stepping. Scrub = `recorder.scrubTo()` followed by
  one store publish.
- Every user intervention goes through the action log first (DESIGN_PLAN §5
  "input recording" holds), so replay/export stays free.
- Lint fence extends: `src/ui/**` may import the engine; the engine may never
  import `src/ui/**`.

## Engine changes (contract v0.2)

| Change | What | Consumer |
|---|---|---|
| `sim.inFlight()` | read-only view over the queue: `{from, target, deliverAt, payload}[]` | ClusterView message dots |
| `LoggedEvent.delivered: boolean` + `dropReason?: 'dead-node' \| 'partition'` | mark deliveries silently skipped today | challenge verifier + honest timeline |
| `metrics(states, time)` | add virtual-time param | throughput/lag rates in MetricsPanel |

Hash note: the `delivered` field changes hash inputs. Safe — no hashes are
persisted anywhere; determinism tests compare run-to-run. `pingpong.ts` gets
the `metrics` signature bump.

## Replication module

`src/modules/replication.ts`, implementing `SimModule`:

- Topology: 1 leader + 2 followers (config param `followers`).
- **Write path:** client write arrives as an `external` event at the leader →
  leader appends `{seq, key, value}` to its log → `send` replication messages to
  followers → followers apply in `seq` order.
- **Mode toggle** (module param): `async` = leader acks immediately after local
  append; `sync` = leader acks only after all followers confirm.
- **Read path:** `external` read to any node returns that node's current value
  plus its `seq`. Follower reads can be stale — lag emerges naturally from
  SimNetwork latency; nothing is faked.
- State: plain JSON per node `{role, log[], data{}, lastAppliedSeq}` plus
  ack/read history for verification.
- Metrics (uses the new time param): replication lag per follower
  (leader seq − follower seq), write throughput (acks/window), stale-read count.

## Chaos challenge: "Produce a stale read"

- Win condition = a pure function over `eventLog` + node states: a read returned
  seq `s` while a write with seq `s' > s` was acked *before* the read was
  issued. Engine-verified; no grading by eye.
- Player tools: delay/partition via ChaosToolbar.
- No loss condition — the challenge stays open until won; a "reset attempt"
  button replays with a fresh seed.

## Pedagogy wiring

- **Predict-before-run:** starting a challenge attempt shows a one-line prompt
  ("how will you cause it?"), skippable. Stored in `localStorage` keyed
  `challenge:attempt`. On win, shown beside the actual event sequence —
  prediction vs reality.
- **Surprise journal:** Debrief textarea ("what surprised you"), persisted to
  `localStorage`, included in the action-log JSON export.

## Testing

- Engine changes: unit tests in the existing style — `inFlight()`
  snapshot-consistency, `delivered`/`dropReason` on kill and partition paths,
  `metrics` time param.
- Replication module: unit tests plus property tests (fast-check):
  1. *sync-mode write acked ⇒ never lost when 1 follower dies* (kept from the
     old Phase 1 DoD);
  2. follower log is always a prefix of the leader log.
- Challenge verifier: property test — never false-positives on chaos-free runs.
- UI: light. Vitest + testing-library for kit logic only (ChaosToolbar renders
  declared capabilities; scrubber calls `scrubTo`; store batching). No pixel or
  E2E tests this phase.
- Determinism guard extended: same seed + action log → same store snapshots.

## Phase 1 DoD v2 (replaces DESIGN_PLAN §9 Phase 1 list)

- [ ] Replication lab (leader-follower) sandbox + chaos runs in the browser.
- [ ] "Stale read" challenge, engine-verified win.
- [ ] MetricsPanel shows ≥ 3 live numbers (lag, throughput, stale-read count).
- [ ] Predict-before-run + surprise journal persist across reload.
- [ ] Property test: sync-acked write survives 1 follower death.
- [ ] CI green: typecheck + lint + coverage ≥ 80% + 10k-scrub benchmark.
- [ ] Bundle ≤ 500 KB gzip (perf budget §6, measured in CI).
- [ ] Site live on GitHub Pages URL, deployed by CI from master.

## Design-doc updates (DESIGN_PLAN v1.2 sync)

- Story mode → annotated-replay note (§3, §8).
- §9 Phase 0 boxes checked; Phase 1 DoD swapped for v2 above.
- Drift fixes from the 2026-07-10 review: §5 storage-chaos open-question note +
  carry-forward link; reorder = emergent + clock-skew = Phase 3 note;
  "structural sharing" → deep-clone wording; snapshot interval N = 500 recorded;
  Appendix gains (e) RNG stream split.
- Appendix (c) resolved: deploy target = GitHub Pages.
- Share URLs moved to Appendix as deferred.

## Build order (each step leaves a working state)

1. Engine v0.2 fixes + pingpong bump (pure TS, no UI yet).
2. CI workflow.
3. Vite + React shell + lint fence extension.
4. Bridge (SimDriver + store) proven on **pingpong** — dots fly before
   replication exists.
5. Lab Kit components against pingpong.
6. Replication module (TDD, property tests).
7. Replication lab page assembling the kit.
8. Challenge + verifier + predict-before-run.
9. Debrief MDX + journal.
10. DESIGN_PLAN v1.2 sync.
11. GitHub repo push + Pages deploy workflow (user confirms repo creation).

Rationale for 4–5: pingpong as the kit testbed proves the kit reusable from
day one instead of retrofitting reuse later.
