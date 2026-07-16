# Ch9.1 — Raft + Linearizability Checker — Design

**Status:** APPROVED (2026-07-16; user delegated decisions — "pick the most suitable").

**Goal:** Ship DDIA Chapter 9 (Consistency & Consensus) as the flagship lab: a
faithful-but-bounded **Raft** cluster (5 nodes — leader election, log replication,
commit advancement) driven over the engine's unreliable network, plus a
**linearizability checker** (Wing–Gong style, bounded history) that judges the lab's
OWN client history. The headline chaos: partition the leader into a minority mid-flight
— its writes never commit, the majority elects a successor (higher term), and on heal
the old leader steps down and its uncommitted tail is overwritten. The checker then
catches the subtler crime: a **stale read** served by a deposed leader is a
linearizability violation you can produce with your own hands.

DESIGN_PLAN §4 row 9 win condition — *"partition during an election; does the minority
accept writes?"* — is challenge 1. Roadmap `9.1` + `9.d` → `active`.

---

## 1. Scope

**In:**
- `src/modules/raft-shared.ts` — topology (`['N1'..'N5']`), timing constants,
  message/payload types, client-history row type.
- `src/modules/raft.ts` — one `SimModule<RaftState>`: follower/candidate/leader roles,
  randomized election timeouts (engine RNG → deterministic), heartbeats,
  RequestVote/AppendEntries with the paper's §5.1–5.4 rules (term checks, log
  up-to-date vote gate, prefix-match + conflict-truncate append, majority commit with
  the **current-term commit restriction** §5.4.2), client writes at the leader,
  client reads served from the leader's state machine WITHOUT a quorum round-trip
  (deliberate — the stale-read lesson), client history rows recorded on the node that
  serves each op.
- `src/modules/linearizable.ts` — pure checker, no sim dependency: single-register
  histories `{op: 'write'|'read', value, invokedAt, respondedAt}` → `{ok: true} |
  {ok: false, culprit: index}`; Wing–Gong recursive search with real-time precedence,
  memoized, hard-capped at `CHECK_CAP = 12` completed ops (the general problem is
  NP-hard — cap documented in UI copy).
- Lab `src/ui/labs/raft/RaftLab.tsx` (9.1): `ClusterView`, `RaftView` (5 logs
  side-by-side, RaftScope-style: term/role badges, entries colored by term, commit
  line), `HistoryPanel` (client ops + "check linearizability" button + verdict),
  `ChaosToolbar` (kill/partition/delay/drop/duplicate), client controls (write value /
  read at a chosen node's leader-belief), `ChallengePanel` ×3, forward-only
  `TimelineScrubber` (Ch8 lesson).
- Debrief `content/ch09/debrief.mdx` + `Debrief.tsx` (9.d), journal `ddia:ch09:journal`.
- Catalog/App/README/DESIGN_PLAN wiring; unit + property + pinned lesson tests.

**Out (deferred, named in debrief):** log compaction/snapshots, membership change,
PreVote, leadership transfer, read-index/lease reads (mentioned as THE fix for the
stale read), multi-register histories, ≥6-node clusters.

---

## 2. Raft model (paper-faithful, bounded)

**State (`RaftState`, per node):** `role: 'follower'|'candidate'|'leader'`,
`term`, `votedFor`, `log: {term, value, seq}[]` (1-indexed semantics via array),
`commitIndex`, `lastApplied`, `kv: number` (single register — the applied value),
leader-only `nextIndex`/`matchIndex` maps, `votes` set (candidate), counters
(`electionsWon`, `heartbeatsSent`, `entriesCommitted`), `history: HistoryRow[]`
(client ops this node served), `electionTimer: number` (a nonce guarding stale
timeout events).

**Timers.** Election timeout: `rng.int(ELECTION_MIN, ELECTION_MAX)` (150–300),
re-armed with a fresh nonce on every heartbeat/vote-grant/step-down; a timeout event
carrying a stale nonce is ignored. Heartbeat: leader every `HEARTBEAT = 50`.

**Election (§5.2).** Timeout → `candidate`: term+1, vote self, RequestVote{term,
lastLogIndex, lastLogTerm} to all. Voters grant iff term ≥ theirs, votedFor free (or
same), and candidate log is at least as up-to-date (§5.4.1). Majority (3) → leader:
init nextIndex = own log length + 1, immediate empty heartbeat. Any message with a
HIGHER term → adopt term, step down to follower, clear votedFor (set only when voting).

**Replication (§5.3).** Leader external `{cmd:'write', value}` → append
`{term, value}` locally, record history invoke, AppendEntries to all. Follower append
rule: reject if term < mine or prevLog mismatch; else truncate conflicts, append,
adopt leaderCommit (min with own log). Leader on majority match for an index **of its
own term** (§5.4.2): advance commitIndex, apply to `kv`, respond the client history
row (`respondedAt`, `ok`). A write whose entry is truncated (deposed leader) gets its
history row completed as `lost` when the node later learns a conflicting commit —
bounded implementation: when the entry at its recorded index no longer matches its
seq, mark `lost` at that node's next apply step.

**Reads.** External `{cmd:'read'}` at a node: if it BELIEVES it is leader, respond
immediately from `kv` (history row invoke=respond=now). Not leader → row `redirect`
(no value). A deposed-but-unaware leader (minority partition) happily serves its old
`kv` — the linearizability bait.

**No new engine features.** kill/revive/partition/heal/net reuse `ControlAction`.

---

## 3. Linearizability checker

`checkLinearizable(history: CompletedOp[]): Verdict` — single register, initial value
0. Wing–Gong: search all orderings consistent with real-time precedence (op A precedes
B iff A.respondedAt < B.invokedAt); a read must return the value of the latest
linearized write (or 0). Minimal-path memoization on (linearized-set bitmask, register
value). Cap: only the last `CHECK_CAP = 12` completed ops are checked (UI says so).
`culprit`: the op that no extension could seat.

Pure, exhaustively unit-tested: classic YES cases (sequential, concurrent overlap
allowing reorder) and NO cases (stale read after an acknowledged overwrite, read of a
never-written value, two reads observing opposite orders of one write).

---

## 4. Challenges

1. **"The minority cannot decide"** — partition the current leader (+1 node) away
   from the majority; write at the old leader; majority elects a new leader (higher
   term); write at the new leader commits. Verify (engine): old leader's write row
   never `ok` while partitioned AND a new leader exists in the majority with a
   committed entry of a newer term. Predict-before-run.
2. **"Heal and repent"** — heal the partition: old leader steps down (higher-term
   AppendEntries), its uncommitted tail is truncated, the minority write's row turns
   `lost`, logs converge. Verify: all live nodes' logs identical prefix through max
   commitIndex, the minority row `lost`, no `ok` row's entry missing anywhere.
3. **"Catch the stale read"** — during the partition (before challenge 2 heals it):
   write at the NEW leader (commits), then read at the OLD leader (serves its stale
   kv), then "check linearizability". Verify: checker returns `ok: false` on the
   combined history. The win copy names read-index/lease reads as the real-world fix
   and terms-as-fencing-tokens as the Ch8 callback.

**Pinned lesson test:** one scripted partition→elect→write-both→read-stale→heal
sequence through the real Simulation asserting the full matrix: minority never
commits, exactly one leader per term ever, committed entries survive heal, checker
flags the stale read, checker passes the same history minus the stale read.

**Property tests (fast-check over random fault scripts):** (a) Election Safety — at
most one leader per term across the whole run (track grants); (b) Log Matching —
any two nodes' logs agree on every index where terms match; (c) Leader Completeness
— an entry committed at term T appears in the log of every later-term leader;
(d) State Machine Safety — applied prefixes never diverge; (e) determinism; (f) the
checker itself: any history generated by a run with NO reads at non-leaders is
linearizable (writes+leader-reads only), and random permutation-stress on the checker
against a brute-force reference for ≤6 ops.

---

## 5. Metrics + inspect

`metrics()`: `raft/leaders-alive`, `raft/max-term`, `raft/committed`,
`raft/elections-won`, per-node `nX/log-length`. `inspect()` per node: role, term,
votedFor, log (term-colored entries + commitIndex), kv, history rows served here.
Lab-level: merged history (all nodes, sorted by invokedAt) feeds the checker + panel.

---

## 6. File plan

New: `src/modules/raft-shared.ts`, `raft.ts` (+ `.test.ts`, `.property.test.ts`,
`raft-lesson.test.ts`), `src/modules/linearizable.ts` (+ `.test.ts`),
`src/ui/labs/raft/RaftLab.tsx`, `RaftView.tsx`, `HistoryPanel.tsx` (+ tests),
`Debrief.tsx`, `content/ch09/debrief.mdx`.
Edited: `catalog.ts` (9.1/9.d active), `App.tsx`, `README.md`,
`docs/DESIGN_PLAN.en.md` (Phase 3 complete note).

---

## 7. Risks

- **Election livelock under partitions/drops.** Randomized timeouts (150–300 vs
  latency 1–10) give Raft's standard convergence; property (a) tolerates repeated
  elections, asserts safety not liveness; the lesson test uses a generous event
  budget and asserts eventual leadership in the majority.
- **Timer-nonce staleness.** Every re-arm bumps `electionTimer`; a timeout event
  must carry the nonce it was armed with — pinned by a unit test (heartbeat then
  stale timeout → no election).
- **Checker blowup.** NP-hard in general; capped at 12 ops with memoization —
  worst-case bitmask space 2^12 × values; property (f) cross-checks vs brute force
  at ≤6.
- **History `lost` marking.** Bounded rule (seq mismatch at apply time) may lag the
  truncation by a few events; the lesson test pins the eventual state, not the exact
  tick.
- **Read semantics honesty.** Serving reads without quorum is a DELIBERATE fidelity
  cut that creates the lesson; debrief + win copy must (and do) name the real fixes.
