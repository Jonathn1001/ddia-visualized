# Ch10.1 — MapReduce vs Dataflow — Design

**Status:** APPROVED (2026-07-16; all sections approved interactively).

**Goal:** Ship DDIA Chapter 10 (Batch Processing) as a twin-panel lab: the SAME
web-log URL-count job runs simultaneously on a **MapReduce** engine (hard stage
barrier, map output materialized to mapper-local disk, shuffle-by-fetch) and a
**dataflow** engine (pipelined streaming, no barrier, no intermediate disk). Healthy
runs let the dataflow side win on completion tick; a single worker kill flips the
story — MapReduce re-runs one task from materialized state, the dataflow pipeline
loses its in-flight lineage and restarts. The headline lesson: **materialization
buys cheap recovery; pipelining buys speed — and couples stages.**

DESIGN_PLAN §4 row 10 win condition — *"kill a worker mid-job — how does recovery
work?"* — is challenge 1. Roadmap `10.1` + `10.d` → `active`.

Interactive decisions (2026-07-16): twin panels in ONE lab (Ch3 pattern) · web-log
URL-count workload (DDIA fig 10-1) · joins debrief-only · Hadoop-faithful
mapper-local-disk recovery · SVG small-N rendering (Canvas particle vision dropped —
YAGNI, breaks lab consistency) · one module with two sub-engines (Approach A).

---

## 1. Scope

**In:**
- `src/modules/batch-shared.ts` — worker topology (**3 sim nodes** `['W1'..'W3']`,
  shared by both sub-engines), the fixed 24-record access log + 3-split layout, URL
  set + expected final counts, task/status/message payload types, timing constants.
- `src/modules/batch.ts` — one `SimModule<BatchState>`; **each node's state holds
  both sub-engine branches `{mr, df}`**, and every message payload is tagged with
  its side. One engine `kill`/`revive` on a node therefore hits both sides
  atomically by construction. (Deliberately NOT the ch3 shape — `storage.ts:20`
  routes one engine per *node*, which cannot host shuffle messages *between*
  workers; this per-node twin-branch shape is new.) Seeded deterministic task
  scheduling, engine timers for task progress, shuffle as SimNetwork messages,
  Hadoop-faithful MR recovery, restart-from-input dataflow recovery, per-side
  counters, `inspect`/`metrics` for the panels. Chaos declaration:
  `chaos: ['kill-node']` — ChaosToolbar renders kill + revive buttons from it.
- Lab `src/ui/labs/batch/BatchLab.tsx` (10.1): two `StagePanel`s (MR top, dataflow
  bottom), shared `run job` control, `ChaosToolbar` (kill/revive only — one action
  hits both sub-engines atomically), `MetricsPanel`, `ChallengePanel` ×3,
  forward-only `TimelineScrubber` (Ch8 lesson).
- `src/ui/labs/batch/StagePanel.tsx` — one side's stage lanes (map → shuffle →
  reduce), worker chips with task badges, MR-only local-disk row, SVG record dots on
  shuffle arcs, output table, progress strip.
- Debrief `content/ch10/debrief.mdx` + `Debrief.tsx` (10.d), journal `ddia:ch10:journal`.
- Catalog/App/README/DESIGN_PLAN wiring; unit + behavioral + property + pinned
  lesson tests.

**Out (deferred, named in debrief):** joins (sort-merge / broadcast hash /
partitioned hash — prose only), speculative execution, a killable JobTracker/master,
multi-job workflows (Hive/Pig chains), checkpointing (Flink barriers) and RDD
partition-granular recompute (Spark) — mentioned as the real fixes for the dataflow
restart, combiners, HDFS replication mechanics, **Hadoop's early shuffle fetch**
(real Hadoop starts reducer fetch per completed map; only `reduce()` waits for all —
simplified here to a hard barrier, an intended simplification).

---

## 2. The job (identical on both sides)

**Input:** a fixed 24-line access log on virtual HDFS, pre-split into 3 splits of 8
records. URL distribution deliberately skewed: `/home` ×10, `/about` ×6, `/cart` ×4,
`/faq` ×2, `/login` ×2. Skew is visible in reducer load; a hot-key straggler story
falls out for free (debrief material, not a challenge).

**Tasks:** 3 map tasks (one per split; map = extract URL, emit `(url, 1)`), 2 reduce
tasks (partition = `hash(url) % 2`; reduce = count per URL). Expected final output —
`/home 10, /about 6, /cart 4, /faq 2, /login 2` — is a shared constant; the output
table is right or wrong at a glance, and tests assert it exactly.

**Cluster:** 3 sim nodes (`W1`–`W3`); each hosts both sub-engines' worker state
(§1). The scheduler (JobTracker analogue) is abstract, immortal module state — not a
killable node; master failure is a named cut. Scheduling is deterministic; the
engine's seeded RNG governs only per-message network latency.

- **MR side (one task slot per worker):** lowest-numbered idle worker takes the
  lowest-numbered runnable task. Phases are sequential (barrier), so 3 workers never
  see more than 3 runnable tasks.
- **Dataflow side (two task slots per worker):** all five operators are placed up
  front — reducers pinned first (`r0→W1`, `r1→W2`), then maps by the same
  lowest-idle rule (`m0→W3`, `m1→W1`, `m2→W2`). Reducers exist from tick 0, so every
  streamed record has a live destination; no barrier, no deadlock.

**Task execution:** a running task consumes ticks via engine timers (per-record
cost × records in the split/partition). `run job` is an external event, entering via
the 1-tick timer hop (Ch9 lesson); **one job per epoch** — the button disables once
fired, and a fresh run means reset (new epoch, standard driver-in-effect, seed
`10000 + epoch`). Dataflow restarts (§4) happen within the same job and do not
re-enable the button.

---

## 3. MapReduce sub-engine (Hadoop-faithful)

- **Map:** worker reads its split from HDFS (durable, always available), runs the
  map task, writes output **partitioned by reducer** to its OWN local disk. Local
  disk lives and dies with the worker.
- **Barrier:** shuffle begins only when ALL 3 map tasks report done.
- **Shuffle:** each reducer fetches its partition from each mapper's local disk —
  fetch request/response as SimNetwork messages (the visible record dots).
- **Reduce:** when a reducer holds all 3 partition files, it sorts/groups/counts
  (ticks), writes final output to HDFS. Job done when both reduce outputs land.

**Recovery:**
- Kill worker with a task **in flight** → scheduler re-runs that task on an idle
  worker (map re-reads its split from HDFS; reduce re-fetches from surviving disks).
- Kill mapper **after done, before all fetches** → local disk gone → the *completed*
  map task re-runs elsewhere. Tracked as `lostAfterDone`. "Done ≠ safe until fetched."
- Kill reducer mid-fetch/reduce → reduce task re-runs; re-fetches; any dead mapper's
  partition forces that map task to re-run first.
- Revive → worker rejoins idle with an EMPTY local disk.
- Only killed work is lost; completed-and-fetched work is never redone.

## 4. Dataflow sub-engine (pipelined, no checkpoint)

- **No barrier, no local disk:** as a mapper processes each record it streams the
  mapped `(url, 1)` straight to the owning reducer worker as a message. Reducers
  fold arriving records into an in-memory aggregate. When all streams close, reducers
  write output. Healthy run finishes ahead of MR (no barrier wait, no disk ticks).
- **Recovery = restart:** a running dataflow task streams from its first tick, so
  killing any worker holding a running task or reducer state poisons downstream
  in-memory lineage (a re-run mapper would double-count records the reducer already
  folded; a dead reducer loses its aggregate). Killing an idle worker costs nothing.
  A poisoning kill restarts the job from the input:
  `restarts += 1`, all partial state cleared, this attempt's task-execution ticks
  added to `ticksWasted`. Restart begins automatically on the next scheduling tick
  using only live workers; **if zero workers are live, the restart waits for the
  first revive**. This is the honest un-checkpointed contrast; Spark/Flink
  mitigations are debrief prose.

**Both sides:** a job always completes as long as ≥1 worker is live per side (tasks
queue on fewer workers; killing all 3 pauses the job until a revive).

---

## 5. Challenges (engine-verified, UI-flag-gated — Ch3/Ch8/Ch9 lesson)

1. **"Kill a mapper mid-task"** (`ddia:ch10:rerun`) — win: MR job completed AND
   `mr.tasksReexecuted ≥ 1` AND the kill fired this epoch while the victim's task was
   `running` (UI kill flag + module-recorded task status at kill time).
2. **"Done isn't safe until fetched"** (`ddia:ch10:lostdisk`) — win: MR job completed
   AND `mr.lostAfterDone ≥ 1` (module counts a task that was `done` re-running
   because its un-fetched local disk died). UI flag gates on a user-driven kill this
   epoch.
3. **"Same kill, unequal damage"** (`ddia:ch10:damage`) — win: BOTH jobs completed
   AND ≥1 kill fired while both jobs were running AND
   `df.ticksWasted > mr.ticksWasted`. One kill, two prices.

Verifiers read `driver.sim.getState` only — never UI state. Hints teach the
choreography (run job → step into mid-map → kill → play out → compare counters).

---

## 6. Metrics + inspect

Per side, in `metrics()` (six counters, MetricsPanel renders both columns):
`recordsMaterialized` (MR disk writes; always 0 on df) · `shuffleInFlight` ·
`tasksReexecuted` · `restarts` (always 0 on mr) · `ticksWasted` · `completionTick`
(null until done).

**`ticksWasted` definition — task-execution ticks discarded by kills.** Idle and
barrier-wait ticks never count.
- MR: partial execution ticks of a killed running task, plus the full original
  execution ticks of any `done` task whose un-fetched output died with its disk
  (each `lostAfterDone` re-run counts its first attempt's ticks).
- Dataflow: on each restart, the sum of all task-execution ticks spent in the
  aborted attempt (per-worker running totals, snapshotted at restart).

`inspect()` per side: worker states (task, status, disk contents count), stage
progress, output rows so far — everything `StagePanel` renders, UI reads no module
internals.

---

## 7. File plan

```
src/modules/batch-shared.ts       topology, log fixture, splits, types, constants
src/modules/batch.ts              SimModule, two sub-engines, recovery, counters
src/modules/batch.test.ts         scheduling, barrier, disk loss, restart, output
src/modules/batch.property.test.ts fast-check: completion, correctness, damage
                                  inequality, determinism (30s timeouts — Ch9 lesson)
src/modules/batch-lesson.test.ts  pinned challenge-matrix choreography
src/ui/labs/batch/StagePanel.tsx  (+ .test.tsx) one side's lanes/chips/disk/output
src/ui/labs/batch/BatchLab.tsx    (+ .test.tsx) assembly, challenges, controls
src/ui/labs/batch/Debrief.tsx     10.d wrapper
content/ch10/debrief.mdx          debrief prose
catalog/App/README/DESIGN_PLAN    wiring (10.1/10.d active, counters, Phase 4 note)
```

**Property suite invariants:** (a) under any kill/revive script keeping ≥1 live
worker per side, both jobs eventually complete; (b) on completion, output counts
equal the expected constant exactly — both sides, always; (c) under a single-kill
script whose kill fires while both jobs are still running AND **triggers a dataflow
restart** (`df.restarts ≥ 1`), `mr.ticksWasted ≤ df.ticksWasted` — a kill the
pipeline shrugs off (victim held no running df task or reducer state) makes no
claim, since MR can still lose an un-fetched map output to the same kill; (d) same
script + seed → identical states (determinism).

---

## 8. Risks

- **Two sub-engines in one reducer** — state shape discipline: `{mr, df}` branches
  must not share mutable structures; a shared-reference bug would silently couple
  the panels. Mitigation: separate top-level keys, deep-freeze in dev tests,
  determinism property.
- **Dataflow restart loops** — a kill during every restart could starve completion;
  the property suite bounds scripts, and restart uses only live workers, so any
  quiet period completes the job. The UI cannot generate infinite kills per tick.
- **Barrier/timer choreography** — same class as Ch7/Ch8 timer lessons; client ops
  enter via external events, and the Ch9 1-tick-timer-hop lesson applies to
  `run job`.
- **Six-counter metrics panel width** — two columns × six rows; if cramped, drop
  `shuffleInFlight` from the panel (keep in inspect).
