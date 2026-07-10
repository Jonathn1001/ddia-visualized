# Ch5 Completion — Multi-Leader + Leaderless Quorum Labs Design

Date: 2026-07-10. Status: approved (brainstorm sections 1–4 approved in session).
Completes Chapter 5 (Replication) per DESIGN_PLAN §4: the two replication styles
deferred from the Phase 1 slice (`2026-07-10-phase1-lab-kit-design.md`).

## Decisions (from brainstorm)

- Conflict resolution: **LWW with visible data loss** — version vectors/siblings
  deferred to a later iteration.
- Leaderless scope: **quorum + read repair + sloppy quorum with hinted handoff**.
- Structure: **separate sidebar entries 5.2 and 5.3**, separate SimModules.
- Packaging: **one slice** — single spec + plan, tasks ordered 5.2 → 5.3, every
  task leaves a deployable state (master auto-deploys).

## Scope

### In

- `src/modules/multileader.ts` and `src/modules/leaderless.ts` — new SimModules
  (contract v0.2, zero engine changes; timeouts are module timers, LWW
  timestamps come from `event.time`).
- Labs `5.2 Multi-Leader` and `5.3 Leaderless Quorum`; catalog entries flip to
  `active`.
- Two engine-verified chaos challenges:
  - 5.2: *make an acknowledged write silently disappear* (`detectLostWrite`).
  - 5.3: *sloppy quorum loses an acknowledged write* (`detectLostAckedWrite`).
- **ChallengePanel generalized into the kit** — props `{title, storageKeyPrefix,
  check(): R | null, renderWin(r): ReactNode}`; the 5.1 stale-read challenge is
  refactored onto it. Predict-before-run and the attempt counter carry over
  unchanged.
- Property tests per module; debrief `5.d` extended with LWW and quorum-math
  (w+r>n) sections.

### Out (explicit)

- Version vectors / sibling values / merge UI.
- Anti-entropy background sync (a dropped multi-leader update diverges forever —
  the debrief names this as the lesson).
- Dynamic membership / configurable n (engine can't grow clusters at runtime —
  carry-forward item).
- Hash ring / key partitioning (Ch6's lab).
- CRDTs.

## Module: multileader.ts

- **Topology:** 2 nodes `DC1`, `DC2` — both leaders, no followers.
- **Write:** external to either node → apply locally
  `data[key] = {value, ts: event.time, origin: self}` → **ack immediately**
  (multi-leader is async by nature; history `{type:'ack', key, ts, time}`) →
  replicate `{rep:'update', key, value, ts, origin}` to the peer.
  Fire-and-forget: no retransmission.
- **LWW rule:** incoming update wins iff `(ts, origin) > (current.ts,
  current.origin)` lexicographically — virtual-time ties broken by nodeId,
  fully deterministic. The loser is recorded as
  `{type:'discarded', key, value, ts, origin}` in the receiver's history.
  The discard record IS the visible data loss.
- **Read:** external read at either node → history
  `{type:'read', node, key, returnedTs, time}`.
- **Verifier `detectLostWrite(states)`:** a discarded entry `d` at any node
  whose `(key, ts, origin)` matches an ack at `d.origin` → an acknowledged
  write silently vanished. Symmetry guarantees the losing concurrent write is
  discarded at exactly one node while acked at its origin.
- **Metrics:** `conflicts-detected` (discard count), `acked-writes`,
  `divergent-keys` (keys where DC1.data ≠ DC2.data), `writes-per-sec`.

## Module: leaderless.ts

- **Topology:** 5 nodes `A B C D E`. Home replicas for every key = `A, B, C`
  (fixed). `D, E` are sloppy fallbacks only.
- **Params:** `{ w: 2, r: 2, sloppy: false }`; UI sliders w/r ∈ 1..3, sloppy
  toggle. Changing params rebuilds the sim (same pattern as 5.1's mode toggle).
- **Write path:** external to any node (the coordinator) → coordinator assigns
  `ts = event.time`, tracks the pending op, sends `{store, key, value, ts,
  opId}` to all 3 home replicas (itself included via a normal send). Replica
  applies per-key LWW, replies `{storeAck, opId}`. At **w** acks the client ack
  is recorded: `{type:'ack', key, ts, time}`.
- **Op timeout (200 virtual ms, module timer):**
  - `sloppy: false` → op fails; history `{type:'failed-write', key, time}`.
    Strict quorum sacrifices availability — visible in metrics.
  - `sloppy: true` → coordinator re-sends the store to fallbacks `D, E`, each
    tagged `hint: <a home replica that has not acked>`. A fallback stores the
    value in its `hintBuffer` and acks; **fallback acks count toward w** —
    that is the sloppy quorum.
- **Hinted handoff:** a fallback holding hints retries delivery to the hint
  target every 100 virtual ms; on `storeAck` from the home replica the hint is
  dropped.
- **Read path:** coordinator sends `{get, key, opId}` to the 3 home replicas,
  waits for **r** responses, returns the max-ts value; history
  `{type:'read', ...}`. **Read repair:** any responder that returned an older
  ts gets the newest value pushed back (`store`).
- **Verifier `detectLostAckedWrite(states, deadNodes)`:** an ack `{key, ts}`
  recorded at any coordinator while no *alive* node holds that `(key, ts)` in
  `data` or `hintBuffer` → an acknowledged write is gone. Canonical win: cut
  off home replicas, sloppy-ack via hints, kill the fallback before handoff.
- **Metrics:** `acked-writes`, `failed-writes`, `read-repairs`,
  `hints-outstanding`.

## UI

- **Kit refactor:** `src/ui/kit/ChallengePanel.tsx` (generic). The
  replication-specific panel is deleted; lab pages pass their verifier and win
  renderer. localStorage keys keep the existing scheme
  (`<prefix>:attempt`, `<prefix>:prediction:<n>`); 5.1 keeps its prefix so
  stored attempts survive the refactor.
- **`MultiLeaderLab`:** kit assembly + client controls with "write @ DC1" /
  "write @ DC2" and per-node reads.
- **`LeaderlessLab`:** kit assembly + w/r sliders, sloppy toggle, coordinator
  picker, per-key write/read controls.
- `ClusterView`, `MetricsPanel`, `TimelineScrubber`, `ChaosToolbar` unchanged.
- Page headers (eyebrow/title/thesis) follow the shell registry pattern.

## Testing

- **Unit (multileader):** LWW under both arrival orders; discard recorded;
  acked-loss detected by verifier; divergence metric counts a dropped update.
- **Unit (leaderless):** quorum ack counting reaches w; strict-mode timeout
  records failed-write; sloppy path acks via fallback hint; handoff completes
  after heal; read repair updates stale replica; r-quorum read returns max ts.
- **Property (fast-check, 50 runs each):**
  1. Multi-leader: with no drops, both DCs converge to identical `data` after
     quiescence.
  2. `detectLostWrite` never fires when all writes target a single leader.
  3. Leaderless: sequential ops (each waits for quiescence), `w + r > n`, no
     chaos → every read returns the latest acked value.
  4. `detectLostAckedWrite` never fires without kills/partitions.
- Determinism guard: both modules run under the existing same-seed → same-hash
  discipline (they draw no RNG; all ordering comes from the queue).

## DoD

- [ ] 5.2 and 5.3 live on GitHub Pages, sidebar entries active.
- [ ] Both challenges engine-verified (no grading by eye), with
      predict-before-run.
- [ ] ≥ 3 live metrics per lab.
- [ ] All 4 property tests green.
- [ ] Coverage ≥ 80% (engine+modules) holds; CI green.
- [ ] Debrief 5.d extended (LWW conflict + quorum math).

## Build order (each step deployable)

1. Generalize ChallengePanel into kit; migrate 5.1 onto it.
2. `multileader.ts` (TDD) + property tests.
3. `MultiLeaderLab` page + lost-write challenge + catalog flip 5.2.
4. `leaderless.ts` (TDD) + property tests.
5. `LeaderlessLab` page + sloppy-loss challenge + catalog flip 5.3.
6. Debrief extension + DESIGN_PLAN note (Ch5 complete).
