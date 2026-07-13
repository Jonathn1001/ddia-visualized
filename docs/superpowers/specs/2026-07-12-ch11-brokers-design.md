# Ch11.1 — Broker Semantics (Kafka log vs RabbitMQ queue vs Redis pub/sub) — Design

**Status:** SHIPPED + deployed 2026-07-13. **Structure changed at build time:** shipped as
**three separate flows** (11.1 Kafka Log, 11.2 RabbitMQ Queue, 11.3 Redis Pub/Sub, 11.d Debrief)
per user request — NOT the tabbed single-lab "Approach A" with a cross-broker scoreboard described
below (§6/§11). The scoreboard was dropped. Modules, contract, and the three challenges are as
specced; the Kafka §10 timer risk was resolved with fetch-ack liveness + broker-side auto-commit
(see commit history). Original design (approved brainstorm 2026-07-12) retained below for record.
**Goal:** Ship DDIA Chapter 11 (Stream Processing) as one interactive lab comparing the three broker
models the learner already knows by name: a **Kafka-style partitioned log**, a **RabbitMQ-style
destructive queue**, and **Redis pub/sub fan-out**. Same topology, same workload, three fates. The
learner discovers *why* delivery guarantees differ: they fall out of what the broker **stores** and
what the consumer **acknowledges**. Delivery-first lesson; consumption models are the explanation,
not a separate topic. Three engine-verified chaos challenges — one failure signature per broker.

Builds on the Phase-0 engine + Phase-1 kit; widens roadmap slot 11.1 ("Kafka-style log") into a
comparison per the 2026-07-11 protocols scoping (HTTP/TLS cut; API-styles lab queued as Ch4 next).

---

## 1. Scope

**In:**
- Three new pure modules (contract v0.2), one per broker:
  `src/modules/kafkalog.ts`, `src/modules/rabbitqueue.ts`, `src/modules/redispubsub.ts`.
- One new kit component `src/ui/kit/BrokerInternals.tsx`: SVG panel rendering the broker's inner
  state per mode (partition lanes + offsets / queue + unacked / subscriber fan-out).
- New lab page `src/ui/labs/brokers/BrokersLab.tsx` (11.1): mode tabs, ClusterView, BrokerInternals,
  workload button, cross-mode scoreboard, ChallengePanel (3 challenges), MetricsPanel,
  TimelineScrubber, ChaosToolbar.
- Ch11 debrief: `content/ch11/debrief.mdx` + `src/ui/labs/brokers/Debrief.tsx` (11.d), journal key
  `ddia:ch11:journal`, via shared `DebriefArticle`/`SurpriseJournal`.
- Catalog + routing: `ch11` chapter entries `11.1 Broker Semantics` + `11.d Debrief & Journal`;
  App PAGES `'11.1'`, `'11.d'` (book order enforced by existing catalog test).
- Unit + drain-scenario tests per module; fast-check properties per module; BrokerInternals render
  tests; a **pinned lesson test** guarding the three signature triples.

**Out (explicitly deferred):**
- **Windowing (tumbling/hopping)** — separate stream-processing lesson; future lab 11.2.
- **Redis Streams** — log-like semantics would muddy the pub/sub contrast; pub/sub only.
- Full Kafka rebalance protocol (heartbeats, generations, sticky assignment) — modeled as a single
  broker-driven session-timeout reassignment (§3).
- Producer-side semantics (idempotent producer, transactions) — exactly-once discussed in the
  Kafka challenge reveal and debrief, not simulated.
- Multiple consumer groups, >2 consumers, >2 partitions — fixed small topology.

---

## 2. Common conventions (all three modules)

**Topology.** Fixed `config.nodeIds = ['P', 'B', 'C1', 'C2']`: one producer, one broker, two
consumers. All modules share this shape so ClusterView looks identical across tabs and chaos ops
carry the same meaning (kill C1 = kill a consumer, in every mode).

**Workload.** The lab sends `{cmd: 'produce', key}` external events to `P` (keys `m0…m11` from a
lab-level counter, 12 per press — same sequence every mode, fair comparison). `P` forwards
`{msg: 'publish', id}` to `B`. What `B` does next is the whole lesson.

**Counting triple (the lesson, quantified).** Each consumer state keeps `processed: string[]`
(append-only, duplicates included — a multiset). Derived at metrics/inspect time, group-wide:
- `delivered` = unique ids across all consumers' `processed`;
- `duplicates` = count of ids appearing more than once across the group (extra occurrences);
- `lost` = produced ids that are neither processed nor in flight nor stored in the broker
  (meaningful when drained).

Signature triples after each broker's crash scenario: Kafka `dup > 0, lost = 0`; RabbitMQ
`dup ≥ 0 (redelivery), lost = 0`; Redis `dup = 0, lost > 0`.

**Timers.** Broker timeouts (redelivery, session check) use delayed self-messages — the same
mechanism as the Ch5 leaderless read-timeout. No `Date.now`, no RNG in modules; determinism
preserved. *Plan-time verification item:* confirm the exact engine API used by
`src/modules/leaderless.ts` for its timeout and reuse it verbatim (named risk, §10).

**Chaos mapping.** Existing ChaosToolbar only: `kill`/`revive` nodes, delay/drop messages. No new
chaos ops. Killed nodes stop reducing (engine semantics) — that alone produces every failure
signature this lab teaches.

---

## 3. Module `kafkalog.ts` — replayable log, offset commits, at-least-once

**Broker state (`B`).**
```
partitions: { p0: string[], p1: string[] }        // append-only logs of msg ids
assignment: { p0: NodeId, p1: NodeId }            // partition → consumer (starts p0→C1, p1→C2)
committed:  { p0: number, p1: number }            // group's committed offset per partition (next-to-read)
delivered:  { p0: number, p1: number }            // high-water of what B has pushed (next-to-push)
uncommittedSince: { p0: Tick|null, p1: Tick|null } // for session-timeout detection
```

**Consumer state (`C1`/`C2`).** `processed: string[]`, `sinceCommit: number`.

**Flow.**
- `publish{id}` → append to `p0`/`p1` by `hash(id) % 2` (reuse engine `fnv1a`; no avalanche needed —
  partition skew is not this lab's lesson) → push `deliver{id, partition, offset}` to the assigned
  consumer; bump `delivered`.
- Consumer on `deliver`: append id to `processed`, increment `sinceCommit`. **Auto-commit interval:**
  only when `sinceCommit ≥ COMMIT_EVERY (= 3)` does it send `commit{partition, offset}` and reset the
  counter. Up to 2 processed-but-uncommitted messages at any moment — **that is the crash window**,
  faithful to Kafka's auto-commit interval.
- Broker on `commit`: advance `committed[p]`, clear `uncommittedSince[p]`.
- **Session timeout / rebalance:** when B pushes a `deliver`, it also schedules a
  `sessionCheck{partition}` self-message (delay `SESSION_TIMEOUT` ticks). On `sessionCheck`: if
  `committed[p]` still lags `delivered[p]` and no commit arrived since the check was scheduled,
  the assigned consumer is presumed dead → reassign `p` to the surviving consumer and **replay**:
  re-push `deliver` for every offset from `committed[p]` to end of log. Replayed ids the dead
  consumer had already processed get processed again by the survivor → duplicates. Nothing is ever
  lost: the log is still there. **No-progress guard:** at most one reassignment per partition per
  stall — after reassigning, B sets `stalled[p] = true` and `sessionCheck` becomes a no-op for `p`
  until the next `commit` or `publish` on `p` clears the flag (prevents an infinite
  replay/sessionCheck loop when *both* consumers are dead).
- Revived consumer stays idle (partition remains with the survivor) — stated simplification; the
  challenge and lesson need no re-join.

**Metrics:** the counting triple + `committed offsets` (per partition) + `log size`.

## 4. Module `rabbitqueue.ts` — destructive queue, per-message acks, at-least-once

**Broker state (`B`).**
```
queue: string[]                                    // FIFO of msg ids awaiting delivery
unacked: { [id]: { consumer: NodeId, redelivered: boolean } }
rr: 0 | 1                                          // round-robin pointer
```

**Consumer state.** `processed: string[]`.

**Flow.**
- `publish{id}` → enqueue → immediately dequeue-and-push `deliver{id, redelivered}` to the next
  round-robin consumer; move id into `unacked`. When B pushes a `deliver`, it schedules
  `checkAck{id}` self-message (delay `ACK_TIMEOUT` ticks).
- Consumer on `deliver`: append to `processed`, send `ack{id}`.
- Broker on `ack`: delete from `unacked` (message is *gone* — destructive read, the anti-log).
- Broker on `checkAck{id}`: if id still in `unacked` → requeue at head with `redelivered: true`,
  deliver to the *other* consumer. A consumer killed after processing but before its ack arrived
  produces a duplicate; a consumer killed before processing produces plain redelivery (no dup).
  Either way `lost = 0`. **Delivery limit** (mirrors AMQP `x-delivery-limit`, = 5): a message
  redelivered 5 times parks in a `deadLetter: string[]` list — kept, visible in BrokerInternals,
  not counted lost (prevents an infinite requeue/checkAck loop when *both* consumers are dead).
- Revived consumer simply receives future round-robin deliveries (broker never tracks liveness —
  the ack timeout is the only failure detector, faithful to AMQP delivery-timeout behavior).

**Metrics:** the counting triple + `queue depth` + `unacked count` + `redeliveries`.

## 5. Module `redispubsub.ts` — fan-out, fire-and-forget, at-most-once

**Broker state (`B`).** `published: string[]` (ids only — for the lost metric; *no message storage*).

**Consumer state.** `processed: string[]`.

**Flow.**
- `publish{id}` → record id in `published` → push `notify{id}` to **both** consumers (fan-out: every
  subscriber gets every message — vs competing consumers in §4). No ack. No timer. No replay.
- Consumer on `notify`: append to `processed`. A dead subscriber's `notify` is never processed —
  the message is gone forever. Revived subscriber receives only *future* publishes.
- `duplicates` is structurally 0; `lost` = published ids missed by a dead subscriber. Note the
  fan-out wrinkle: "lost" counts per-subscriber misses — a message C1 got but C2 missed is lost
  *for C2*. Metric label: `lost (subscriber-misses)`.

**Metrics:** the counting triple + `subscribers live`.

---

## 6. UI

**`BrokerInternals.tsx` (kit).** One SVG component, `mode: 'kafka' | 'rabbit' | 'redis'` prop,
rendered **from `inspect` of published states only** (HRInspect discipline; `statesOf()` never in
render path). Per mode:
- *kafka:* two partition lanes of message cells; committed-offset pointer per lane; cells between
  committed and delivered tinted amber (the crash window); replayed cells re-highlight.
- *rabbit:* one queue lane; unacked cells amber with owning consumer tag; redelivered cells `↺`.
- *redis:* subscriber list with live/dead dots; per-publish fan-out marks; misses render as cells
  falling into a void slot (lost).
`data-*` attrs on cells/pointers for tests (`data-offset`, `data-unacked`, `data-lost`), following
RingView's `data-vnode`/`data-key` precedent. Node colors from the existing `NODE_COLORS` palette.

**`BrokersLab.tsx` (11.1).**
- Tabs **Kafka / RabbitMQ / Redis** — switching swaps the module and rebuilds the sim (Ch6
  epoch-rebuild pattern: driver in state, built in effect, `if (!driver) return null`; seed
  `11000 + epoch`). Tab state, scoreboard, and challenge progress live outside the driver.
- **Produce 12** button: sends `produce` events `m0…m11`; counter continues (`m12…`) on repeat press
  within a run; resets with the sim.
- **Scoreboard** (lab-local component): 3 rows (one per broker) × produced / delivered / duplicates /
  lost. A row fills from its mode's metrics when that run drains; the row dims when that tab's sim
  is rebuilt (stale). Persists across tab switches for the session; not persisted to localStorage.
- Headline readout, Ch6 style: e.g. "Kafka: 12 delivered · 3 duplicates · 0 lost".
- ChallengePanel shows only the active tab's challenge.

**Catalog/routing.** `ch11` → `11.1 Broker Semantics`, `11.d Debrief & Journal`, both active; App
PAGES entries; `content/ch11/debrief.mdx`; `HashRingDebrief` pattern reused for `BrokersDebrief`.

---

## 7. Challenges (engine-verified, ChallengePanel keys `ddia:ch11:*`)

1. **Kafka — "Make it twice"** (`ddia:ch11:kafka-dup`). Produce messages, kill a consumer inside the
   auto-commit window, let the rebalance replay. **Win:** group `duplicates ≥ 1`. Reveal: this is
   at-least-once; *exactly-once* is dedup/idempotence layered on top (consumer-side ids,
   transactional offsets) — the broker alone never gives it.
2. **RabbitMQ — "Resurrect a message"** (`ddia:ch11:rabbit-redeliver`). Kill a consumer holding an
   unacked message; watch the ack timeout requeue it. **Win:** a `redelivered`-flagged message is
   processed by the surviving consumer (redeliveries ≥ 1 with processing evidence). Reveal:
   per-message ack vs Kafka's per-offset commit — finer-grained, same at-least-once ceiling.
3. **Redis — "Lose it forever"** (`ddia:ch11:redis-lost`). Kill a subscriber, publish, revive it,
   drain. **Win:** drained with `lost ≥ 1`. Reveal: nothing was stored, so nothing can be replayed —
   at-most-once is a *storage* decision, not a delivery bug.

Win detection = pure predicate over `inspect` of published states (Ch6 hotspot pattern). Each
challenge is only evaluable in its own tab/mode.

---

## 8. Testing

- **TDD per module** (RED→GREEN): reducer units — kafka append/deliver/commit-interval/
  sessionCheck-rebalance-replay; rabbit enqueue/rr-deliver/ack-delete/checkAck-requeue-redeliver;
  redis fan-out/miss counting. Drain-scenario tests assert each signature triple after the scripted
  crash (kill C1 at the right tick, run to drain, assert triple).
- **fast-check properties:**
  - kafka: *conservation* — under any kill schedule, every produced id is processed at least once
    by the group once drained (no loss, ever);
  - rabbit: every produced id is, at drain, processed or still queued/unacked (no silent loss);
  - redis: each consumer's `processed` ⊆ ids published while that consumer was live, and
    `duplicates = 0` structurally.
- **Pinned lesson test** (Ch6 revert-bite lesson): one test per module running the default crash
  scenario and asserting the exact signature triple shape (`kafka: dup>0 ∧ lost=0`, etc.) — guards
  against any future reducer edit silently flattening the contrast the lab exists to teach. Prove
  each pin bites (temporarily break the reducer, watch it fail) during implementation.
- **UI:** BrokerInternals renders from inspect fixtures per mode (offsets/unacked/lost cells
  visible via `data-*`); App nav test extends to 11.1/11.d; scoreboard fills on drain and dims on
  rebuild; catalog order test already pins ch11 position.

## 9. Definition of Done

- All three challenges winnable in a real browser walk (Playwright), win verified by engine
  predicate, reveal text shown.
- Same seed → same triple (determinism test per module).
- Coverage ≥ 80% gate holds; gzip bundle < 500 KB; zero console errors/warnings on the walk.
- Scoreboard shows the three signature triples after running the standard workload + scripted
  crash in each tab.

## 10. Risks / plan-time verification

- **Timer mechanism** (§2): confirm the delayed self-message API from `leaderless.ts` read-timeout
  and reuse it; if the engine offers no self-delay, fall back to counting ticks via a broker-side
  `tick` message loop — decide in the plan, not mid-implementation.
- **Rebalance reducer** is the subtlest piece (mirrors Ch6 `applyMembership` staleness lessons):
  guard against double-reassignment when `sessionCheck` fires after a late commit arrives.
- **Redis lost-metric semantics** (per-subscriber misses) must match the scoreboard label or the
  numbers will confuse — locked in §5.
- Scoreboard staleness: dim-on-rebuild only; no cross-session persistence (decided).

## 11. Decision log (brainstorm 2026-07-12)

- Core lesson: **both** guarantees + consumption models, **delivery-first** framing.
- Redis: **pub/sub only** (Streams cut — would blur the contrast).
- **Windowing cut** (future 11.2); **simple rebalance kept** (needed by the Kafka challenge).
- **Three challenges**, one per broker.
- Structure: **Approach A** — one lab, mode tabs, three small modules, persistent scoreboard;
  rejected B (three separate labs — kills comparison) and C (one combined sim — crowded, risky).
