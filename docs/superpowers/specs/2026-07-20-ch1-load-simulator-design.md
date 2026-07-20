# Ch1.1 — Load Simulator — Design

**Status:** APPROVED (2026-07-20; scope + Approach A approved interactively).

**Goal:** Ship DDIA Chapter 1 (Reliable, Scalable, Maintainable Applications) as a
**Scalability** lab: requests arrive at a service tier modelled as an **M/M/c queue**;
the reader drags a **load slider** and watches **p50 stay flat while p99 detonates** as
utilisation ρ → 1, then **rescues** the tail by adding a replica or a cache. The reader
feels the central Ch1 scalability truth: **an average tells you nothing — tail latency
is the number that breaks, and it breaks suddenly near capacity, driven by queueing and
service-time variance.**

DESIGN_PLAN §4 row 1 aha — *"Raise load until tail latency explodes; find the
bottleneck"* — is challenge **C1** (the knee + rescue). Roadmap `1.1` + `1.d` →
`active`.

**Interactive decisions (2026-07-20):**
- **Scalability-only lab.** Reliability (fault tolerance) and Maintainability
  (operability / simplicity / evolvability) are debrief prose, not interactive
  surfaces. The "add a replica" rescue already lightly touches availability.
  DESIGN_PLAN §8 reserves multi-widget budget for Ch2/Ch4, not Ch1.
- **Approach A — three challenges** including tail-latency amplification (fan-out),
  which is the one added engine cost (a parent/child join in the reducer). Covers the
  three canonical Ch1 scalability insights: the knee, variance-drives-the-tail, and
  fan-out amplification.
- **One honest model, no separate idealised distribution.** Fan-out sub-requests are
  real queued backend jobs sharing the same M/M/c; C3's params keep load low so the
  statistical max-of-N effect — not queueing — is what the reader sees.
- **Single authoritative sim node (`SVC`).** Ch1 has no network/kill chaos; the tier
  is one queue. `chaos: []` (no ChaosToolbar); every knob is an external command
  (the Ch12 precedent).

---

## 1. Scope

**In:**
- `src/modules/load-shared.ts` — topology (`nodeIds: ['SVC']`), the request/completion
  payload types, the state shape, timing/param constants (service mean, load levels,
  window size, SLA threshold, seed), and the pure reference helpers the property tests
  assert against: `percentile(samples, p)` and `interArrivalMean(loadLevel)`.
- `src/modules/load.ts` — one `SimModule<LoadState>` on node `SVC`. A self-rescheduling
  `arrival` timer generates requests at rate λ; each request (or, under fan-out, each of
  its N backend sub-requests) either hits the cache (bypass, ~1 tick) or enters the
  M/M/c queue; a `complete` timer frees a server, pulls the next queued job, and joins
  fan-out children into their parent's response time (the **max** of its children).
  `inspect`/`metrics` expose the queue, servers, and the rolling percentile window.
  All reader knobs are external commands (§3); `chaos: []`.
- Lab `src/ui/labs/load/LoadLab.tsx` (1.1): a load slider, a servers/cache/variance/
  fan-out control strip, the live `PercentilePanel`, a queue/servers visual, three
  `ChallengePanel`s, forward-only `TimelineScrubber` (Ch8 lesson).
- `src/ui/labs/load/PercentilePanel.tsx` — p50/p95/p99 bars (user vs backend), a
  throughput + queue-depth + utilisation readout, and an SLA line. Presentational
  (pure props), own jsdom tests — the Ch10 `StagePanel` / Ch12 `DerivedPanel` pattern.
- Debrief `content/ch01/debrief.mdx` + `Debrief.tsx` (1.d), journal `ddia:ch01:journal`.
- Catalog/App/README/DESIGN_PLAN wiring; unit + behavioral + property + pinned lesson
  tests.

**Out (deferred, named in debrief):** Reliability as an interactive surface (hardware/
software/human faults, fault-tolerance techniques) — prose only; Maintainability
(operability, simplicity, evolvability) — prose only; multi-tier / multi-hop request
graphs (single tier here); autoscaling / elastic capacity (the reader is the
autoscaler); priority queues / LIFO / SLO-aware scheduling; hedged requests as a *fix*
for C3 (named as the real-world remedy, not simulated); network latency between client
and service (service time only); Little's-law-based analytic prediction overlay (the
sim measures, it does not predict). All prose-only in the debrief.

---

## 2. The model

### Node & state

**One sim node, `SVC`** (`nodeIds: ['SVC']`) — the whole service tier. State
(plain serializable object):

```ts
interface LoadState {
  // knobs (set by external commands)
  loadLevel: number;      // 1..LOAD_MAX; higher = more load. interArrivalMean = round(K / loadLevel)
  servers: number;        // c  (add/remove replica)
  cacheHitRate: number;   // h in [0,1]  (add cache)
  varianceOn: boolean;    // service-time variance on/off
  fanout: number;         // N backend calls per user request (1 = off)

  // runtime
  inService: number;              // busy servers, 0..servers
  queue: SubReq[];                // FIFO of waiting backend sub-requests
  pending: Record<number, Parent>;// join table: parentId -> { remaining, arrivalT, maxLatency }
  nextId: number;

  // measurement (rolling windows, newest last, capped at WINDOW)
  userLatencies: number[];        // completed user-request response times
  backendLatencies: number[];     // completed backend sub-request service+wait times

  // accounting
  busyTicks: number;              // Σ inService·Δt  (for utilisation)
  lastEventT: number;

  // challenge epoch flags (Ch12 per-epoch gating; reset on the setup command)
  c1: { breached: boolean; rescued: boolean };
  c2: { hiTail: boolean; loTail: boolean };
  c3: { amplified: boolean };
}
```

`SubReq = { id, parentId, cached: boolean, service: number }`. `Parent = { remaining,
arrivalT, maxLatency }`. **Each sub-request's `service` time is drawn once, at arrival**
(not at service-start) and stored on the `SubReq` — this is what makes property (c)'s
coupling proof valid: the RNG draw sequence (inter-arrival, then per-sub cache-roll +
service-draw) is then identical across server counts, so c and c+1 replay the same
workload.

### Events (all timers; no network messages)

- **`{t:'arrival'}`** — self-reschedules at `now + expTick(interArrivalMean)`. On fire:
  mint a user request (parentId = `nextId++`), create `fanout` sub-requests sharing that
  parentId; for each sub-request roll cache (prob `h`): a **hit** (`service =
  CACHE_TICKS`) schedules `{t:'complete', id, parentId, cached:true}` at
  `now + CACHE_TICKS` (bypasses queue); a **miss** (`service = serviceTick()`, drawn
  now and stored on the SubReq) either starts service now (`inService < servers` →
  `inService++`, schedule `{t:'complete', id, parentId, cached:false}` at
  `now + sub.service`) or is pushed to `queue`.
- **`{t:'complete', id, parentId, cached}`** — a sub-request finished. If not cached:
  `inService--`; if `queue` non-empty **and** `inService < servers`, dequeue head,
  `inService++`, schedule its completion at `now + head.service` (its service was fixed
  at arrival). Then **join**: record this sub-request's latency
  (`now − parent.arrivalT`) into `backendLatencies`; `parent.remaining--`;
  `parent.maxLatency = max(parent.maxLatency, now − parent.arrivalT)`. When
  `remaining === 0`: push `parent.maxLatency` into `userLatencies`, delete
  `pending[parentId]`, update challenge flags (§4).

`serviceTick()` = `varianceOn ? expTick(SERVICE_MEAN) : SERVICE_MEAN`. `expTick(mean)` =
`max(1, round(-mean·ln(1 - rng.next())))` — rounded exponential, ≥ 1 tick, so the
scrubber timeline stays integer and clean. **Draw `u = 1 - rng.next()` (∈ `(0,1]`), not
`rng.next()` directly** — `rng.next()` returns `[0,1)` (`src/engine/rng.ts`), so a raw 0
would give `ln 0 = -∞` and an Infinity service time; `1 - next()` makes `u=1 → ln 1 = 0`
clamp cleanly to 1 tick. Every roll draws from the sim RNG → deterministic per
seed. Accounting: on **every** event, add `inService·(now − lastEventT)` to `busyTicks`
then set `lastEventT = now`.

**Derived metrics (from `inspect`/`metrics`):** p50/p95/p99 over the `userLatencies` and
`backendLatencies` windows; **throughput** = completions over the last `WINDOW`-worth of
ticks (cumulative completions / elapsed — never a raw per-tick 0/1, same rolling basis
as the percentiles); **queue depth** = `queue.length`; **utilisation** = the *measured*
`busyTicks / (servers · elapsed)` (property d). This measured utilisation is **distinct
from** the *analytic* ρ = λ/capacity below, which is used only as challenge-setup
intuition — named apart so the panel number and the challenge prose never contradict.

### Capacity intuition (drives challenge params)

Per-server rate μ = 1/`SERVICE_MEAN`. Tier capacity = `servers`/`SERVICE_MEAN`.
Utilisation ρ = λ/capacity where λ = 1/`interArrivalMean`. ρ ≥ 1 ⇒ the queue grows
without bound ⇒ p99 climbs past any SLA over time; ρ < 1 ⇒ bounded. C1 puts the reader
above the c=1 knee, then a replica drops them below the c=2 knee at the same λ.

---

## 3. Interaction & chaos

`chaos: []` (no ChaosToolbar). All knobs are **external commands to `SVC`**:

- **`{cmd:'set-load', level}`** — the load slider; sets `loadLevel` (next inter-arrival
  draws use the new mean). This is the primary lever.
- **`{cmd:'set-servers', c}`** — add/remove a replica (`servers = c`). Raising c lets a
  waiting job start immediately on the next event; lowering c never kills an in-flight
  job (they drain).
- **`{cmd:'set-cache', h}`** — cache hit rate; future arrivals bypass the queue with
  prob h.
- **`{cmd:'set-variance', on}`** — service-time variance on/off.
- **`{cmd:'set-fanout', n}`** — backend calls per user request.
- **Step / play** — advance ticks; arrivals fire, the queue fills/drains, percentiles
  move.

Each challenge's setup command also **resets that challenge's epoch flags** so a win only
counts when the reader drove the specific sequence in the current epoch (Ch3/Ch8/Ch12
no-auto-win lesson).

---

## 4. Challenges (engine-verified win conditions)

Percentiles are computed over the rolling `WINDOW` of the relevant latency array. Each
win is UI-flag-gated per epoch; each is a separate sim in the pinned lesson test,
asserted clause-by-clause. Params are chosen so the effect is **robust across seeds**
(the pinned test fixes the seed; the property tests cover the seed-independent
invariants).

| # | Name | Setup → win condition |
|---|------|-----------------------|
| **C1** | **The knee + rescue** (§4 signature) | c=1, variance on. Raise load past the knee (ρ > 1) → play → rolling **p99(user) > SLA** while **p50 stays < SLA** (`c1.breached`). Add a replica (c=2) at the same load → play → **p99(user) < SLA** (`c1.rescued`). **Win = breached ∧ rescued in one epoch.** |
| **C2** | **Variance drives the tail** | c large enough that ρ < 1, moderate load. Variance **ON** → play → **p99 ≥ VAR_TAIL_MULT · p50** (`c2.hiTail`). Toggle variance **OFF** → play → **p99 < LO_TAIL_MULT · p50** (tail collapses toward the mean) (`c2.loTail`). **Win = hiTail ∧ loTail in one epoch.** |
| **C3** | **Tail-latency amplification** | Low load (backend unsaturated so queueing is not the cause), variance on, fan-out **N ≥ FANOUT_MIN**. Play → the median *user* request now feels the backend tail: **p50(user) ≥ p95(backend)** (`c3.amplified`). Reduce fan-out to 1 → p50(user) ≈ p50(backend) again (shown live; the amplification win is the flag). **Win = amplified observed in one epoch.** |

---

## 5. UI, debrief, wiring

**LoadLab** — single-tier layout:
- **Control strip (top):** the **load slider** (1..LOAD_MAX) front and centre; a
  servers stepper, a cache-hit slider, a variance toggle, a fan-out stepper.
- **Queue visual (middle):** `servers` server slots (busy/idle) + the FIFO queue as a
  row of waiting dots; arrivals animate in, completions animate out (motion, ≤ the perf
  budget's node count).
- **PercentilePanel (right/bottom):** p50 / p95 / p99 bars for **user** and (when
  fan-out > 1) **backend**, an **SLA line**, and a throughput + queue-depth +
  utilisation readout. Presentational, pure props, own jsdom tests.
- **ChallengePanel ×3:** predict → drive → win banner (mirrors Ch10/Ch12 wiring).
- **Forward-only TimelineScrubber** (Ch8 lesson — no rewind past the tape head).

**Debrief (1.d, `content/ch01/debrief.mdx`)** — mirrors `raft/Debrief.tsx`, journal key
`ddia:ch01:journal`. Covers, in order: **Scalability** — load parameters, describing
performance with *percentiles not averages*, the p95/p99/p999 tail, why the tail is
what users feel and what SLAs target, the queueing knee (response time vs load),
head-of-line blocking, service-time variance, and **tail-latency amplification** (the
fan-out max-of-N argument, and hedged requests as the real remedy). Then the two themes
the lab does *not* simulate, as prose: **Reliability** — faults vs failures; hardware,
software, and human errors; fault-tolerance and deliberate fault injection (Netflix
Chaos Monkey) — with a back-reference to the chaos labs (Ch5/Ch8/Ch9) as this book's
"cause the fault yourself" surface; **Maintainability** — operability, simplicity
(accidental complexity, good abstractions), evolvability. Real systems: Twitter's
fan-out-on-write timeline (the book's home example — write vs read amplification),
Amazon's p99.9 SLA rationale, tail-tolerant systems (Dean & Barroso, "The Tail at
Scale"). Terms: latency vs response time, percentile / p99 / tail latency, throughput,
load parameter, utilisation, head-of-line blocking, tail-latency amplification, SLA/SLO.

**Wiring:** catalog already ships `{ id:'1.1', label:'Load Simulator', status:'soon' }`
with **no `1.d`** — so: flip `1.1` → `active`, **add** `1.d`, and update the existing
`catalog.test.ts` ch1 assertion (currently expects `soon`); App PAGES entries with the
aliased import `LoadDebrief` (the per-lab convention); README ch1 block + counter bump;
DESIGN_PLAN Phase 5 progress note (ch1 shipped; only ch2 remains).

---

## 6. Testing strategy (TDD, mirrors Ch12)

- **`load-shared.ts`** — topology, param constants, payload/state types, and the pure
  `percentile()` + `interArrivalMean()` references. Pinned test (exact percentile
  indexing on known arrays; monotonic interArrivalMean vs load level).
- **`load.ts`** — behavioral gate tests:
  - **queue fills & drains** — arrivals with no free server enqueue; completions pull
    the queue head; **no new job starts while `inService ≥ servers`** (with `servers`
    constant, `inService ≤ servers` holds; lowering `servers` mid-flight lets in-flight
    jobs drain rather than being killed, so the guard is on *starting*, not on the count).
  - **cache bypass** — with h=1 no job ever enters `queue`; latencies ≈ CACHE_TICKS.
  - **fan-out join** — a user request completes only after all N sub-requests; its
    recorded latency = max child latency.
- **Property suite** (a counterexample is a real bug: shrink, report, fix minimally,
  document):
  - (a) **percentile ordering** — for any run, p50 ≤ p95 ≤ p99 ≤ max over each window.
  - (b) **response ≥ service** — every recorded latency ≥ its service time (wait ≥ 0);
    no user latency is less than any of its children.
  - (c) **server-count monotonicity (coupling)** — replay the *identical* arrival +
    service-time stream (same seed, same command times) with c and c+1 servers; every
    request completes no later under c+1 (more capacity never hurts anyone under FIFO).
  - (d) **utilisation bound** — busyTicks / (servers · elapsed) ≤ 1 at all times.
- **Pinned lesson test** — the three challenge scenarios, each its own sim at a fixed
  seed, asserted clause-by-clause (breach-then-rescue; hiTail-then-loTail; amplified).
- **PercentilePanel** — jsdom presentational tests (bar heights, SLA line, user-vs-
  backend rows, empty/warmup state).
- **LoadLab** — smoke + challenge-wiring tests.

Gate each task: `npx vitest run && npx tsc -b && npm run build`. Ship gate adds a
browser DoD walk (vite + playwright) driving ≥ C1 to its live win banner, 0 console
errors.

---

## 7. File plan

- `src/modules/load-shared.ts` (+ `.test.ts`)
- `src/modules/load.ts` (+ `.test.ts`, `.property.test.ts`, `load-lesson.test.ts`)
- `src/ui/labs/load/LoadLab.tsx` (+ `.test.tsx`)
- `src/ui/labs/load/PercentilePanel.tsx` (+ `.test.tsx`)
- `src/ui/labs/load/Debrief.tsx`
- `content/ch01/debrief.mdx`
- Edits: `src/ui/shell/catalog.ts` (+ `catalog.test.ts`), App PAGES, `README.md`,
  `docs/DESIGN_PLAN.md` + `.en.md`.

## 8. Risks / notes

- **Fan-out load confounder** — N sub-requests multiply backend load by N. C3 must run
  at low arrival so the amplification the reader sees is the max-of-N statistic, not
  queueing; the pinned test enforces backend ρ < 1 during C3. Documented in the debrief
  (real fan-out *does* also raise load — a second reason to keep fan-out small).
- **Seed-robust win thresholds** — challenge multipliers (`SLA`, `VAR_TAIL_MULT`,
  `FANOUT_MIN`) are tuned so C1/C2/C3 win reliably at the fixed lesson seed with margin.
  The *invariants* (property suite) are seed-independent; the *thresholds* (lesson test)
  are seed-pinned — the same split as every prior chapter.
- **Warmup / empty window** — percentiles over a near-empty window are noisy; the panel
  shows a "warming up" state until `WINDOW_MIN` completions, and win-flags only latch
  after the window is full (no lucky early win).
- **ρ > 1 unbounded queue** — running above the knee grows the queue indefinitely; the
  visual caps the drawn dots (shows "+N more") and metrics report true depth. This is
  the intended "explode" behaviour, not a bug.
- **Percentile cost** — sort of a ≤ WINDOW array per metrics() call; WINDOW is small
  (e.g. 200) → cheap, within the perf budget.
