# Ch8.1 — Unreliable Network Playground (leases, GC pauses, fencing tokens) — Design

**Status:** APPROVED (2026-07-16; user delegated decisions — "pick the most suitable").

**Goal:** Ship DDIA Chapter 8 (The Trouble with Distributed Systems) as one interactive
lab where a **lease-based lock service**, two **worker clients**, and a **shared store**
run over the engine's genuinely unreliable network (latency, loss, duplication,
partitions). The learner corrupts the store by GC-pausing a lease holder — the DDIA
figure 8-4 story — then turns on **fencing tokens** and watches the same failure get
rejected, then reproduces the corruption a third way with nothing but a **slow clock**.
DESIGN_PLAN §Phase 3 row 8's win condition — *"Fencing tokens: prove why lock + lease is
not enough"* — is the headline challenge.

Unlike Ch3/Ch7 (zero-effect modules), this module exercises the engine's full network
path: sends with latency/drop/duplicate, timers, partitions, kill/revive. Roadmap `8.1`
("Unreliable Network Playground") + `8.d` → `active`.

---

## 1. Scope

**In:**
- One pure module (contract v0.2): `src/modules/lease.ts` + shared vocab
  `src/modules/lease-shared.ts`. Topology `['Lock', 'W1', 'W2', 'Store']`.
- `chaos: ['kill-node', 'partition', 'delay', 'drop', 'duplicate', 'clock-skew']` —
  the first five via the existing `ChaosToolbar`/`ControlAction` path; `clock-skew`
  and `gc-pause` as **module-interpreted `external` fault events** (Ch3 precedent:
  domain faults don't extend `ControlAction`).
- Lab page `src/ui/labs/lease/LeaseLab.tsx` (8.1): `ClusterView` (reused, in-flight
  messages visible), `LeasePanel` (holder/token/expiry truth vs each worker's belief),
  `StorePanel` (value, last token, write history with stale/rejected badges),
  `ChaosToolbar` (kill/partition/net sliders), `LeaseFaultBar` (acquire buttons,
  gc-pause, clock-skew, fencing toggle), `ChallengePanel` ×3, `TimelineScrubber`
  (this lab has real pending work — the scrubber earns its place here).
- Ch8 debrief `content/ch08/debrief.mdx` + `Debrief.tsx` (8.d), journal
  `ddia:ch08:journal`.
- Catalog `8.1`/`8.d` → active; App PAGES; README; DESIGN_PLAN Phase-3 partial note.
- Unit + property tests; pinned lesson test (the fencing matrix, §6).

**Out (deferred):**
- Lease renewal/heartbeats (fixed TTL only; a worker re-acquires manually).
- Byzantine faults, checksums (debrief mentions them).
- Multi-resource stores, more than 2 workers.
- Read operations on the store (writes tell the whole fencing story).
- True time-of-day clocks / NTP modeling — clock skew is a **rate** multiplier.

---

## 2. The protocol (bounded, DDIA-faithful)

**Lock (lease service).** Holds `holder`, `token` (monotonic counter), `expiresAt`
(its own — true — clock), and a FIFO wait queue. On `acquire`: if free → grant
`{token: ++n, ttl: LEASE_TTL}` and arm an expiry timer; else enqueue (an acquire
from the CURRENT holder means it no longer believes its lease — release and
re-serve). On expiry: release silently and grant to the next waiter. **No expiry
notice is pushed** *(execution deviation, verified: an active notice structurally
outran every rival write at any seed/rate, making the clock-skew lesson impossible
— and real lease clients track expiry on their own clocks anyway; that IS the
lesson)*. Workers learn the lease is gone only from their own clock or a fencing
reject.

**Worker (W1/W2).** States `idle → waiting → holding`. On user `acquire` command
(external) → send `acquire`. On `grant {token, ttl}`: record `grantAt = now`,
`token`, and start the **check → work → write** loop that is the whole lesson:

- every `WRITE_EVERY` ticks, a check-timer fires: the worker computes its LOCAL
  elapsed time `(now − grantAt) × rate` (`rate = 1` normally; a slow clock has
  `rate < 1`) and, if `< ttl`, enters `working` phase and arms a
  `WORK_TICKS` timer — the expensive work between checking the lease and using it;
- when the work timer fires it **sends the write without re-checking** —
  `{write, token, value}` → Store — exactly the check-then-act window of DDIA
  fig 8-4 (and of Ch7's `ensure`, one chapter earlier);
- when a local check fails, or an `expired` notice arrives, the worker returns to
  `idle` and stops writing.

**GC pause** (`external {fault: 'gc-pause', ticks}` on a worker): sets
`pausedUntil = now + ticks`. Any message or timer the worker receives while paused is
**re-emitted as a timer** firing at `pausedUntil`, preserving payloads — the process
backlog. The clock does NOT pause (that is the point): a paused worker that had
already passed its check wakes up and completes its write with a stale token.

**Clock skew** (`external {fault: 'clock-skew', rate}` on a worker): sets the worker's
clock rate. A slow clock (`rate: 0.5`) makes every local lease check pass for twice
the real duration — stale writes with no pause at all.

**Store.** Holds `value`, `lastToken`, `fencing: boolean` (toggled by an external),
`history: {token, writer, outcome}[]`. On `write {token}`:
- fencing ON: accept iff `token ≥ lastToken` (then `lastToken = token`), else send
  `reject` and record `outcome: 'rejected'`;
- fencing OFF: always accept; if `token < lastToken` record `outcome: 'stale'` and
  bump `staleAccepts` (the corruption counter); else `outcome: 'ok'`.

Constants: `LEASE_TTL = 60`, `WRITE_EVERY = 10`, `WORK_TICKS = 6`, defaults
`latency [1,10]`.

---

## 3. Anomaly surface — what the learner can actually break

1. **Pause-based stale write (fig 8-4).** W1 holds token 1 and is `working`;
   gc-pause it past expiry; Lock grants token 2 to W2, W2 writes (`lastToken 2`);
   W1 wakes, finishes, writes token 1 → fencing OFF: **accepted, stale** →
   corruption. Fencing ON: **rejected**.
2. **Skew-based stale write.** No pause: W1's `rate 0.5` keeps its checks passing
   after true expiry → same corruption while W1's panel still shows "holding".
3. **Playground chaos.** Drop/delay/duplicate sliders + partitions + kill: the
   `expired` notice can be lost (worker learns only from its own clock), a
   duplicated grant is harmless (same token), a partitioned worker's writes never
   arrive. All emergent from the engine — no special-casing.

---

## 4. Metrics + inspect

`metrics()`: `lock/tokens-granted`, `store/writes-ok`, `store/stale-accepts`,
`store/rejects`, `w1/paused` `w2/paused` (0/1). `inspect()` per node type:
- Lock: holder, token counter, true expiry countdown, queue.
- Worker: state (`idle/waiting/holding`), token, `working` badge, local-clock rate,
  paused-until, **belief**: "thinks lease valid" (its own check) vs Lock truth.
- Store: value, lastToken, fencing flag, history (latest ~10 rows w/ outcomes).

---

## 5. Challenges

1. **"The lease is a lie"** — fencing OFF. Win: `staleAccepts ≥ 1` AND a gc-pause
   was fired this attempt (Ch3's `crashed`-flag lesson: no auto-win). Predict:
   what does W1 do when it wakes?
2. **"Fence it"** — fencing ON. Win: `rejects ≥ 1` AND `staleAccepts` unchanged
   since fencing enabled AND a gc-pause fired. The same failure, now harmless.
3. **"The clock lies too"** — fencing OFF, no pause needed. Win: `staleAccepts ≥ 1`
   with NO gc-pause fired during the attempt (UI-tracked flag, Ch3 `crashed`-flag
   precedent) AND some worker has `rate ≠ 1`.

---

## 6. Pinned lesson test (the fencing matrix)

One scripted deterministic sequence driven through the real `Simulation` (no UI):
acquire W1 → run until W1 is `working` → gc-pause W1 for > remaining TTL → acquire
W2 → run until W2's first accepted write → run until W1's wake write arrives:
- fencing OFF: Store history contains W1's post-wake write with `outcome 'stale'`,
  `staleAccepts = 1`.
- fencing ON (same choreography, fencing toggled at t0): W1's post-wake write
  `outcome 'rejected'`, `staleAccepts = 0`, and W2's writes all `ok`.
- skew variant: no pause; `rate 0.5` on W1 at t0 → after true expiry and W2's grant,
  W1 produces a `stale` accept, fencing OFF.

**Property tests:** (a) token monotonicity — grants strictly increase; (b) fencing
safety — with fencing ON, accepted tokens are non-decreasing in Store history, for
any random fault script (pauses/skews/acquire storms); (c) determinism — same seed +
same external script → identical states; (d) at most one holder in Lock's own view
at any time (single-writer truth at the service).

---

## 7. File plan

New: `src/modules/lease-shared.ts`, `src/modules/lease.ts` (+ `.test.ts`,
`.property.test.ts`, `lease-lesson.test.ts`), `src/ui/labs/lease/LeaseLab.tsx`,
`LeasePanel.tsx`, `StorePanel.tsx`, `LeaseFaultBar.tsx` (+ tests), `Debrief.tsx`,
`content/ch08/debrief.mdx`.
Edited: `catalog.ts` (8.1/8.d active), `App.tsx` (PAGES + imports), `README.md`,
`docs/DESIGN_PLAN.en.md`.

---

## 8. Risks

- **Timer-deferral pause.** Re-emitting in-pause events as wake timers must preserve
  relative order. Mitigation: single wake time (`pausedUntil`) + engine heap FIFO for
  equal times; a unit test pins backlog ordering.
- **Choreography fragility in challenge 1.** The pause must land in the `working`
  window. Mitigation: `WORK_TICKS/WRITE_EVERY = 6/10` keeps the window wide; the
  worker's `working` badge tells the user when; the lesson test pins the scripted
  version deterministically.
- **Virtual-time reliance.** Unlike Ch7, time here DOES advance (sends/timers). The
  Ch7 clock lesson does not apply — but a regression test asserts `sim.time`
  actually advances under the default script, so the assumption is pinned.
