# Ch9 Raft + Linearizability Checker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship DDIA Ch9 as lab `9.1` — a five-node Raft cluster (election, log replication, §5.4.2 commit restriction) over the unreliable network, with a Wing–Gong linearizability checker judging the lab's own client history — plus debrief `9.d`.

**Architecture:** One `Simulation<RaftState>` with `nodeIds: ['N1'..'N5']`; one pure module `src/modules/raft.ts` (all five nodes run the same reducer; roles are state). Election timeouts use the engine RNG (deterministic); timer nonces guard staleness. A separate pure checker `src/modules/linearizable.ts` has zero sim dependency. Chaos = existing `ControlAction` (kill/partition/net) — no engine changes. Spec: `docs/superpowers/specs/2026-07-16-ch9-raft-linearizability-design.md`.

**Tech Stack:** TypeScript, React, SimDriver/useSimStore bridge, ClusterView/ChaosToolbar/ChallengePanel/TimelineScrubber kit, vitest, fast-check, MDX.

## Global Constraints

- Pure module: reducer `structuredClone(prev)` then mutate; RNG only via the `rng` param (`rng.int(min, maxExclusive)`, `rng.next()`); no Date.now/Math.random.
- Effects only `{type:'send'|'timer'}`. The `init` event arrives through `reduce` (kind `'init'`) — that is where the first election timer is armed.
- Constants: `ELECTION_MIN = 150`, `ELECTION_MAX = 300`, `HEARTBEAT = 50`, `MAJORITY = 3`, `CHECK_CAP = 12`.
- UI tests: `// @vitest-environment jsdom`, `afterEach(cleanup)`, container/data-attr queries, NO jest-dom; theme tokens ink/panel/line/dim/fg/set/sign/warn; `btn`/`btnPrimary`/`inputBox` from kit/classes.
- Content dir `content/ch09/`; storage keys `ddia:ch09:*` (challenges `ddia:ch09:minority|heal|stale`, journal `ddia:ch09:journal`).
- Forward-only scrub (Ch8 lesson): `onScrub={(i) => { if (i >= view.processed) driver.scrubTo(i); }}`.
- `sim.external()` never self-processes; tests gate with `runSteps`/`until` helpers.
- Tests `npx vitest run <file>`; `npx tsc -b`; `npx eslint <files>`; commit specific files; conventional commits.

---

### Task 1: Shared vocabulary + the linearizability checker

**Files:**
- Create: `src/modules/raft-shared.ts`, `src/modules/linearizable.ts`
- Test: `src/modules/linearizable.test.ts` (+ a small shape test inside it for raft-shared)

**Interfaces (later tasks import exactly these):** `RAFT_NODES`, `MAJORITY`, `ELECTION_MIN`, `ELECTION_MAX`, `HEARTBEAT`, `CHECK_CAP`, types `Entry`, `RaftMsg`, `RaftExternal`, `RaftTimer`, `RaftPayload`, `HistoryRow`; checker `CompletedOp`, `Verdict`, `checkLinearizable`.

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/linearizable.test.ts
import { expect, test } from 'vitest';
import { checkLinearizable, type CompletedOp } from './linearizable';
import { RAFT_NODES, CHECK_CAP } from './raft-shared';

const w = (value: number, invokedAt: number, respondedAt: number): CompletedOp => ({ op: 'write', value, invokedAt, respondedAt });
const r = (value: number, invokedAt: number, respondedAt: number): CompletedOp => ({ op: 'read', value, invokedAt, respondedAt });

test('raft topology is five nodes', () => {
  expect(RAFT_NODES).toHaveLength(5);
});

test('empty and write-only histories are linearizable', () => {
  expect(checkLinearizable([]).verdict).toBe('ok');
  expect(checkLinearizable([w(1, 0, 5), w(2, 10, 15)]).verdict).toBe('ok');
});

test('sequential write-then-read of that value is ok; of another value is a violation', () => {
  expect(checkLinearizable([w(7, 0, 5), r(7, 10, 15)]).verdict).toBe('ok');
  const bad = checkLinearizable([w(7, 0, 5), r(9, 10, 15)]);
  expect(bad.verdict).toBe('violation');
  expect(bad.culprit).toBe(1);
});

test('a read may see either value while concurrent with the write', () => {
  expect(checkLinearizable([w(1, 0, 20), r(0, 5, 10)]).verdict).toBe('ok'); // read linearized before the write
  expect(checkLinearizable([w(1, 0, 20), r(1, 5, 10)]).verdict).toBe('ok'); // or after
});

test('the classic stale read: acknowledged overwrite, then a read of the old value', () => {
  // w(1) done; w(2) done strictly after; then a read strictly after both returns 1 → violation
  const bad = checkLinearizable([w(1, 0, 5), w(2, 10, 15), r(1, 20, 25)]);
  expect(bad.verdict).toBe('violation');
  expect(bad.culprit).toBe(2);
});

test('reads observing opposite orders of two concurrent writes: one order works → ok', () => {
  // writes concurrent; two sequential reads both see 2 then both see 2 → fine
  expect(
    checkLinearizable([w(1, 0, 30), w(2, 0, 30), r(2, 40, 45), r(2, 50, 55)]).verdict,
  ).toBe('ok');
  // but 2-then-1 with the reads strictly ordered AND after both writes is a violation
  const bad = checkLinearizable([w(1, 0, 10), w(2, 12, 20), r(2, 30, 35), r(1, 40, 45)]);
  expect(bad.verdict).toBe('violation');
});

test('initial register value is 0: a leading read of 0 is fine, of anything else is not', () => {
  expect(checkLinearizable([r(0, 0, 5)]).verdict).toBe('ok');
  expect(checkLinearizable([r(3, 0, 5)]).verdict).toBe('violation');
});

test('histories beyond the cap are refused, not judged', () => {
  const many: CompletedOp[] = [];
  for (let i = 0; i < CHECK_CAP + 1; i++) many.push(w(i, i * 10, i * 10 + 5));
  expect(checkLinearizable(many).verdict).toBe('too-long');
});
```

- [ ] **Step 2: RED** — modules unresolved.

- [ ] **Step 3: Implement**

```ts
// src/modules/raft-shared.ts
// Ch9 — Raft vocabulary: five nodes, paper-faithful message shapes, client history.
import type { NodeId } from '../engine/events';

export const RAFT_NODES: NodeId[] = ['N1', 'N2', 'N3', 'N4', 'N5'];
export const MAJORITY = 3;

/** Election timeout range and heartbeat period, in virtual ticks (latency is 1–10). */
export const ELECTION_MIN = 150;
export const ELECTION_MAX = 300;
export const HEARTBEAT = 50;

/** The linearizability checker refuses longer histories (the problem is NP-hard). */
export const CHECK_CAP = 12;

export interface Entry {
  term: number;
  value: number;
  /** Unique per (writer, write): lets a client row detect its entry was truncated. */
  seq: string;
}

export type RaftMsg =
  | { kind: 'req-vote'; term: number; lastLogIndex: number; lastLogTerm: number }
  | { kind: 'vote'; term: number; granted: boolean }
  | { kind: 'append'; term: number; prevIndex: number; prevTerm: number; entries: Entry[]; leaderCommit: number }
  | { kind: 'append-resp'; term: number; ok: boolean; matchIndex: number };

export type RaftExternal = { cmd: 'write'; value: number } | { cmd: 'read' };

export type RaftTimer = { t: 'election'; nonce: number } | { t: 'heartbeat'; nonce: number };

export type RaftPayload = RaftMsg | RaftExternal | RaftTimer;

export interface HistoryRow {
  id: string; // `${node}:${n}` — unique across the cluster
  node: NodeId;
  op: 'write' | 'read';
  value: number | null;
  invokedAt: number;
  respondedAt: number | null;
  outcome: 'pending' | 'ok' | 'lost' | 'redirect';
  /** write rows: where the entry landed, to detect truncation later. */
  index?: number;
  seq?: string;
}
```

```ts
// src/modules/linearizable.ts
// Wing–Gong style linearizability check for a single integer register (initial 0).
// Search over linearization orders consistent with real-time precedence, memoized
// on (chosen-set bitmask, register value). Exponential in general — hence the cap.
import { CHECK_CAP } from './raft-shared';

export interface CompletedOp {
  op: 'write' | 'read';
  value: number;
  invokedAt: number;
  respondedAt: number;
}

export type Verdict = { verdict: 'ok' } | { verdict: 'violation'; culprit: number } | { verdict: 'too-long' };

export function checkLinearizable(ops: CompletedOp[]): Verdict {
  if (ops.length > CHECK_CAP) return { verdict: 'too-long' };
  const n = ops.length;
  if (n === 0) return { verdict: 'ok' };
  // precedes[j] = bitmask of ops that must be linearized before op j
  const precedes: number[] = ops.map((oj) => {
    let mask = 0;
    for (let i = 0; i < n; i++) if (ops[i].respondedAt < oj.invokedAt) mask |= 1 << i;
    return mask;
  });
  const full = (1 << n) - 1;
  const seen = new Set<string>();
  // track the deepest frontier for culprit reporting
  let bestMask = 0;
  const dfs = (mask: number, reg: number): boolean => {
    if (mask === full) return true;
    const key = `${mask}:${reg}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (popcount(mask) > popcount(bestMask)) bestMask = mask;
    for (let j = 0; j < n; j++) {
      if (mask & (1 << j)) continue;
      if ((precedes[j] & mask) !== precedes[j]) continue; // a predecessor not yet seated
      const o = ops[j];
      if (o.op === 'read') {
        if (o.value !== reg) continue; // cannot seat this read now
        if (dfs(mask | (1 << j), reg)) return true;
      } else {
        if (dfs(mask | (1 << j), o.value)) return true;
      }
    }
    return false;
  };
  if (dfs(0, 0)) return { verdict: 'ok' };
  // culprit: the smallest-indexed op not seated in the deepest reachable frontier
  for (let j = 0; j < n; j++) if (!(bestMask & (1 << j))) return { verdict: 'violation', culprit: j };
  return { verdict: 'violation', culprit: n - 1 };
}

function popcount(x: number): number {
  let c = 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
}
```

- [ ] **Step 4: GREEN + tsc + eslint. Step 5: Commit**

```bash
git add src/modules/raft-shared.ts src/modules/linearizable.ts src/modules/linearizable.test.ts
git commit -m "feat(modules): Ch9 vocabulary + Wing–Gong linearizability checker (capped)"
```

---

### Task 2: The complete Raft module

**Files:**
- Create: `src/modules/raft.ts`
- Test: `src/modules/raft.test.ts`

The FULL module lands here (elections, replication, commit, history); Tasks 3–6 are behavioral gates that append tests and fix only what fails. This mirrors the Ch8 strategy that surfaced plan bugs early.

**Interfaces:** `RaftState`, `raft: SimModule<RaftState, RaftPayload>`, `mergedHistory(states): HistoryRow[]`, `completedOps(rows): CompletedOp[]` (feeds the checker; excludes `redirect`/`pending`/`lost` reads-and-writes appropriately: `ok` rows only). `metrics`/`inspect` stubs until Task 7.

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/raft.test.ts
import { expect, test } from 'vitest';
import { Simulation } from '../engine';
import { raft, type RaftState } from './raft';
import { ELECTION_MAX, RAFT_NODES, type RaftPayload } from './raft-shared';

export function fresh(seed = 9000) {
  const sim = new Simulation<RaftState, RaftPayload>({
    module: raft,
    config: { nodeIds: RAFT_NODES },
    seed,
  });
  sim.runSteps(RAFT_NODES.length); // inits arm election timers
  return sim;
}

export const st = (sim: ReturnType<typeof fresh>, id: string) => sim.getState(id);
export const leaders = (sim: ReturnType<typeof fresh>) => RAFT_NODES.filter((n) => st(sim, n).role === 'leader');

/** Run until cond or event budget dry (loud on failure). */
export function until(sim: ReturnType<typeof fresh>, cond: () => boolean, budget = 5000) {
  for (let i = 0; i < budget && !cond(); i++) {
    if (sim.pending === 0) break;
    sim.runSteps(1);
  }
  if (!cond()) throw new Error(`until(): not reached (time=${sim.time}, pending=${sim.pending})`);
}

test('a five-node cluster elects exactly one leader', () => {
  const sim = fresh();
  until(sim, () => leaders(sim).length === 1);
  const lead = leaders(sim)[0];
  expect(st(sim, lead).term).toBeGreaterThanOrEqual(1);
  // everyone converges on the same term via heartbeats
  until(sim, () => RAFT_NODES.every((n) => st(sim, n).term === st(sim, lead).term), 3000);
  expect(leaders(sim)).toHaveLength(1);
});

test('heartbeats suppress new elections while the leader lives', () => {
  const sim = fresh();
  until(sim, () => leaders(sim).length === 1);
  const term = Math.max(...RAFT_NODES.map((n) => st(sim, n).term));
  sim.runUntil(sim.time + ELECTION_MAX * 4);
  expect(leaders(sim)).toHaveLength(1);
  expect(Math.max(...RAFT_NODES.map((n) => st(sim, n).term))).toBe(term);
});

test('killing the leader triggers a re-election with a higher term', () => {
  const sim = fresh();
  until(sim, () => leaders(sim).length === 1);
  const old = leaders(sim)[0];
  const oldTerm = st(sim, old).term;
  sim.control({ type: 'kill', node: old });
  until(sim, () => leaders(sim).some((l) => l !== old), 8000);
  const neo = leaders(sim).find((l) => l !== old) as string;
  expect(st(sim, neo).term).toBeGreaterThan(oldTerm);
});

test('a stale election timeout (old nonce) does not start an election', () => {
  const sim = fresh();
  until(sim, () => leaders(sim).length === 1);
  // followers keep re-arming on every heartbeat; run a long time — terms stay put
  const term = Math.max(...RAFT_NODES.map((n) => st(sim, n).term));
  sim.runUntil(sim.time + ELECTION_MAX * 6);
  expect(Math.max(...RAFT_NODES.map((n) => st(sim, n).term))).toBe(term);
});

test('a client write at the leader commits and applies on a majority', () => {
  const sim = fresh();
  until(sim, () => leaders(sim).length === 1);
  const lead = leaders(sim)[0];
  sim.external(lead, { cmd: 'write', value: 42 });
  until(sim, () => st(sim, lead).commitIndex >= 1, 4000);
  expect(st(sim, lead).kv).toBe(42);
  until(sim, () => RAFT_NODES.filter((n) => st(sim, n).commitIndex >= 1).length >= 3, 4000);
  const row = st(sim, lead).history.find((h) => h.op === 'write');
  expect(row?.outcome).toBe('ok');
});

test('a write at a follower is redirected, not appended', () => {
  const sim = fresh();
  until(sim, () => leaders(sim).length === 1);
  const follower = RAFT_NODES.find((n) => st(sim, n).role === 'follower') as string;
  sim.external(follower, { cmd: 'write', value: 7 });
  sim.runSteps(1);
  expect(st(sim, follower).log).toHaveLength(0);
  expect(st(sim, follower).history[0]?.outcome).toBe('redirect');
});
```

- [ ] **Step 2: RED** — cannot resolve `./raft`.

- [ ] **Step 3: Implement**

```ts
// src/modules/raft.ts
// Ch9 — Raft (Ongaro & Ousterhout §5), bounded: five fixed nodes, no snapshots,
// no membership change. Every node runs this reducer; role is state. Election
// timeouts draw from the engine RNG (deterministic); timer nonces kill stale
// timeouts. Reads are served from the leader's applied register WITHOUT a quorum
// round — deliberately: that gap is the linearizability lesson.
import type { NodeId } from '../engine/events';
import type { Effect, InspectorTree, MetricSample, SimModule } from '../engine/module';
import type { SeededRng } from '../engine/rng';
import {
  ELECTION_MAX,
  ELECTION_MIN,
  HEARTBEAT,
  MAJORITY,
  RAFT_NODES,
  type Entry,
  type HistoryRow,
  type RaftMsg,
  type RaftPayload,
  type RaftTimer,
} from './raft-shared';

export interface RaftState {
  id: NodeId;
  role: 'follower' | 'candidate' | 'leader';
  term: number;
  votedFor: NodeId | null;
  log: Entry[];
  commitIndex: number; // 1-based count of committed entries
  lastApplied: number;
  kv: number; // the applied register
  next: Record<string, number>;
  match: Record<string, number>;
  votes: NodeId[];
  electionNonce: number;
  heartbeatNonce: number;
  history: HistoryRow[];
  historyN: number;
  electionsWon: number;
}

type Ev = { kind: 'init' | 'message' | 'timer' | 'external'; self: NodeId; from?: NodeId; time: number; payload: RaftPayload };

const peers = (self: NodeId): NodeId[] => RAFT_NODES.filter((n) => n !== self);

const lastLogIndex = (s: RaftState): number => s.log.length;
const lastLogTerm = (s: RaftState): number => (s.log.length ? s.log[s.log.length - 1].term : 0);

function armElection(s: RaftState, rng: SeededRng, fx: Effect[]): void {
  s.electionNonce += 1;
  fx.push({ type: 'timer', delay: rng.int(ELECTION_MIN, ELECTION_MAX + 1), payload: { t: 'election', nonce: s.electionNonce } });
}

function armHeartbeat(s: RaftState, fx: Effect[]): void {
  s.heartbeatNonce += 1;
  fx.push({ type: 'timer', delay: HEARTBEAT, payload: { t: 'heartbeat', nonce: s.heartbeatNonce } });
}

/** Any sign of a higher term → become that term's follower (paper rule, all RPCs). */
function adoptTerm(s: RaftState, term: number): void {
  s.term = term;
  s.role = 'follower';
  s.votedFor = null;
  s.votes = [];
}

function appendFor(s: RaftState, to: NodeId): RaftMsg {
  const nextIdx = s.next[to] ?? s.log.length + 1;
  const prevIndex = nextIdx - 1;
  const prevTerm = prevIndex > 0 ? s.log[prevIndex - 1].term : 0;
  return {
    kind: 'append',
    term: s.term,
    prevIndex,
    prevTerm,
    entries: s.log.slice(prevIndex),
    leaderCommit: s.commitIndex,
  };
}

function broadcastAppends(s: RaftState, fx: Effect[]): void {
  for (const p of peers(s.id)) fx.push({ type: 'send', to: p, payload: appendFor(s, p) });
}

/** Apply committed entries to the register; settle any write rows we own. */
function applyAndSettle(s: RaftState, now: number): void {
  while (s.lastApplied < s.commitIndex) {
    s.lastApplied += 1;
    s.kv = s.log[s.lastApplied - 1].value;
  }
  for (const row of s.history) {
    if (row.op !== 'write' || row.outcome !== 'pending' || row.index === undefined) continue;
    const entry = s.log[row.index - 1];
    if (entry && entry.seq === row.seq) {
      if (s.commitIndex >= row.index) {
        row.outcome = 'ok';
        row.respondedAt = now;
      }
    } else if (s.commitIndex >= row.index || !entry) {
      // our entry is gone (truncated by a newer leader) — the write is lost
      row.outcome = 'lost';
      row.respondedAt = now;
    }
  }
}

function becomeLeader(s: RaftState, fx: Effect[]): void {
  s.role = 'leader';
  s.electionsWon += 1;
  s.next = {};
  s.match = {};
  for (const p of peers(s.id)) {
    s.next[p] = s.log.length + 1;
    s.match[p] = 0;
  }
  broadcastAppends(s, fx); // immediate empty heartbeat asserts authority
  armHeartbeat(s, fx);
}

function handleTimer(s: RaftState, p: RaftTimer, rng: SeededRng, fx: Effect[]): void {
  if (p.t === 'election') {
    if (p.nonce !== s.electionNonce || s.role === 'leader') return; // stale or irrelevant
    s.role = 'candidate';
    s.term += 1;
    s.votedFor = s.id;
    s.votes = [s.id];
    armElection(s, rng, fx); // retry timer for split votes
    for (const pr of peers(s.id)) {
      fx.push({ type: 'send', to: pr, payload: { kind: 'req-vote', term: s.term, lastLogIndex: lastLogIndex(s), lastLogTerm: lastLogTerm(s) } });
    }
  } else {
    if (p.nonce !== s.heartbeatNonce || s.role !== 'leader') return;
    broadcastAppends(s, fx);
    armHeartbeat(s, fx);
  }
}

function handleMsg(s: RaftState, p: RaftMsg, from: NodeId, now: number, rng: SeededRng, fx: Effect[]): void {
  if (p.term > s.term) adoptTerm(s, p.term);

  switch (p.kind) {
    case 'req-vote': {
      let granted = false;
      if (p.term === s.term && (s.votedFor === null || s.votedFor === from)) {
        // §5.4.1: candidate's log must be at least as up-to-date as ours
        const upToDate = p.lastLogTerm > lastLogTerm(s) || (p.lastLogTerm === lastLogTerm(s) && p.lastLogIndex >= lastLogIndex(s));
        if (upToDate) {
          granted = true;
          s.votedFor = from;
          armElection(s, rng, fx); // granting a vote resets our patience
        }
      }
      fx.push({ type: 'send', to: from, payload: { kind: 'vote', term: s.term, granted } });
      break;
    }
    case 'vote': {
      if (s.role === 'candidate' && p.term === s.term && p.granted && !s.votes.includes(from)) {
        s.votes.push(from);
        if (s.votes.length >= MAJORITY) becomeLeader(s, fx);
      }
      break;
    }
    case 'append': {
      if (p.term < s.term) {
        fx.push({ type: 'send', to: from, payload: { kind: 'append-resp', term: s.term, ok: false, matchIndex: 0 } });
        break;
      }
      // valid leader for our term: candidates stand down, followers stay patient
      if (s.role !== 'follower') s.role = 'follower';
      armElection(s, rng, fx);
      const prevOk = p.prevIndex === 0 || (s.log.length >= p.prevIndex && s.log[p.prevIndex - 1].term === p.prevTerm);
      if (!prevOk) {
        fx.push({ type: 'send', to: from, payload: { kind: 'append-resp', term: s.term, ok: false, matchIndex: 0 } });
        break;
      }
      // paper §5.3: skip entries we already have; truncate ONLY at the first
      // conflict (same index, different term). Never blind-replace — a delayed
      // or duplicated old append must not shear a newer (possibly committed) tail.
      {
        let i = 0;
        while (i < p.entries.length && s.log.length > p.prevIndex + i && s.log[p.prevIndex + i].term === p.entries[i].term) i++;
        if (i < p.entries.length) s.log = s.log.slice(0, p.prevIndex + i).concat(p.entries.slice(i));
      }
      if (p.leaderCommit > s.commitIndex) s.commitIndex = Math.min(p.leaderCommit, s.log.length);
      applyAndSettle(s, now);
      fx.push({ type: 'send', to: from, payload: { kind: 'append-resp', term: s.term, ok: true, matchIndex: p.prevIndex + p.entries.length } });
      break;
    }
    case 'append-resp': {
      if (s.role !== 'leader' || p.term !== s.term) break;
      if (p.ok) {
        s.match[from] = Math.max(s.match[from] ?? 0, p.matchIndex);
        s.next[from] = s.match[from] + 1;
        // §5.4.2: only entries of the CURRENT term commit by counting
        for (let idx = s.commitIndex + 1; idx <= s.log.length; idx++) {
          if (s.log[idx - 1].term !== s.term) continue;
          const replicas = 1 + peers(s.id).filter((pr) => (s.match[pr] ?? 0) >= idx).length;
          if (replicas >= MAJORITY) s.commitIndex = idx;
        }
        applyAndSettle(s, now);
      } else {
        s.next[from] = Math.max(1, (s.next[from] ?? s.log.length + 1) - 1);
        fx.push({ type: 'send', to: from, payload: appendFor(s, from) });
      }
      break;
    }
  }
}

function handleExternal(s: RaftState, p: RaftPayload, now: number, fx: Effect[]): void {
  if (!('cmd' in p)) return;
  s.historyN += 1;
  const id = `${s.id}:${s.historyN}`;
  if (p.cmd === 'write') {
    if (s.role !== 'leader') {
      s.history.push({ id, node: s.id, op: 'write', value: p.value, invokedAt: now, respondedAt: now, outcome: 'redirect' });
      return;
    }
    const seq = id;
    s.log.push({ term: s.term, value: p.value, seq });
    s.history.push({ id, node: s.id, op: 'write', value: p.value, invokedAt: now, respondedAt: null, outcome: 'pending', index: s.log.length, seq });
    broadcastAppends(s, fx);
  } else {
    if (s.role !== 'leader') {
      s.history.push({ id, node: s.id, op: 'read', value: null, invokedAt: now, respondedAt: now, outcome: 'redirect' });
      return;
    }
    // served straight from the applied register — no quorum round. The gap.
    s.history.push({ id, node: s.id, op: 'read', value: s.kv, invokedAt: now, respondedAt: now, outcome: 'ok' });
  }
}

export const raft: SimModule<RaftState, RaftPayload> = {
  id: 'raft-consensus',
  chaos: ['kill-node', 'partition', 'delay', 'drop', 'duplicate'],

  init(nodeId) {
    return {
      id: nodeId,
      role: 'follower',
      term: 0,
      votedFor: null,
      log: [],
      commitIndex: 0,
      lastApplied: 0,
      kv: 0,
      next: {},
      match: {},
      votes: [],
      electionNonce: 0,
      heartbeatNonce: 0,
      history: [],
      historyN: 0,
      electionsWon: 0,
    };
  },

  reduce(state, event, rng) {
    const ev = event as Ev;
    const s = structuredClone(state);
    const fx: Effect[] = [];
    if (ev.kind === 'init') {
      armElection(s, rng, fx);
    } else if (ev.kind === 'timer' && 't' in (ev.payload as object)) {
      handleTimer(s, ev.payload as RaftTimer, rng, fx);
    } else if (ev.kind === 'message' && 'kind' in (ev.payload as object) && ev.from) {
      handleMsg(s, ev.payload as RaftMsg, ev.from, ev.time, rng, fx);
    } else if (ev.kind === 'external') {
      handleExternal(s, ev.payload, ev.time, fx);
    }
    return [s, fx];
  },

  metrics(): MetricSample[] {
    return []; // Task 7
  },

  inspect(state) {
    return { id: state.id, role: state.role } as unknown as InspectorTree; // Task 7
  },
};

/** All client rows across the cluster, oldest-first — the checker's input source. */
export function mergedHistory(states: Map<NodeId, RaftState>): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (const s of states.values()) rows.push(...s.history);
  return rows.sort((a, b) => a.invokedAt - b.invokedAt || a.id.localeCompare(b.id));
}

/** Only completed, value-bearing ops participate in the linearizability check. */
export function completedOps(rows: HistoryRow[]): { op: 'write' | 'read'; value: number; invokedAt: number; respondedAt: number }[] {
  return rows
    .filter((r) => r.outcome === 'ok' && r.respondedAt !== null && r.value !== null)
    .map((r) => ({ op: r.op, value: r.value as number, invokedAt: r.invokedAt, respondedAt: r.respondedAt as number }));
}
```

Note on the `append` case: the skip-matching-prefix loop is load-bearing under `duplicate`/`delay` chaos — an old append re-arriving must be a no-op when the follower's log already extends past it with matching terms. An empty heartbeat (`entries: []`) never truncates anything; a follower's dangling tail from a deposed term is removed only when a real conflicting entry arrives at that index. If a gate test fails around here, fix toward the paper, not toward the test.

- [ ] **Step 4: GREEN + tsc + eslint. Step 5: Commit**

```bash
git add src/modules/raft.ts src/modules/raft.test.ts
git commit -m "feat(modules): Raft — elections, replication, §5.4.2 commit, client history"
```

---

### Task 3: Behavioral gate — partitions and the minority

**Files:** `src/modules/raft.test.ts` (append; module fixes only for real bugs)

- [ ] **Step 1: Append**

```ts
// append to src/modules/raft.test.ts
test('a minority-partitioned leader cannot commit; the majority elects a successor', () => {
  const sim = fresh();
  until(sim, () => leaders(sim).length === 1);
  const old = leaders(sim)[0];
  const others = RAFT_NODES.filter((n) => n !== old);
  const buddy = others[0];
  const majority = others.slice(1); // three nodes
  sim.control({ type: 'partition', groups: [[old, buddy], majority] });
  sim.external(old, { cmd: 'write', value: 99 });
  // the majority elects a new leader with a higher term
  until(sim, () => majority.some((n) => st(sim, n).role === 'leader'), 20000);
  const neo = majority.find((n) => st(sim, n).role === 'leader') as string;
  expect(st(sim, neo).term).toBeGreaterThan(st(sim, old).term - 1);
  // the old leader's write is stuck pending — a minority cannot decide
  const row = st(sim, old).history.find((h) => h.op === 'write');
  expect(row?.outcome).toBe('pending');
  expect(st(sim, old).commitIndex).toBe(0);
});

test('healing the partition deposes the old leader and truncates its tail; the lost write is marked', () => {
  const sim = fresh();
  until(sim, () => leaders(sim).length === 1);
  const old = leaders(sim)[0];
  const others = RAFT_NODES.filter((n) => n !== old);
  const majority = others.slice(1);
  sim.control({ type: 'partition', groups: [[old, others[0]], majority] });
  sim.external(old, { cmd: 'write', value: 99 }); // will be lost
  until(sim, () => majority.some((n) => st(sim, n).role === 'leader'), 20000);
  const neo = majority.find((n) => st(sim, n).role === 'leader') as string;
  sim.external(neo, { cmd: 'write', value: 7 }); // will commit
  until(sim, () => st(sim, neo).commitIndex >= 1, 6000);
  sim.control({ type: 'heal' });
  // old leader steps down and converges on the new log
  until(sim, () => st(sim, old).role === 'follower' && st(sim, old).kv === 7, 20000);
  until(sim, () => st(sim, old).history.find((h) => h.op === 'write')?.outcome === 'lost', 6000);
  // no committed entry lost anywhere
  for (const n of RAFT_NODES) {
    const s = st(sim, n);
    if (s.commitIndex >= 1) expect(s.log[0].value).toBe(7);
  }
});
```

- [ ] **Step 2: Run.** Green = Task 2 faithful; failures = module bugs, fix minimally and document (likely suspects: empty-heartbeat truncation, commit restriction, `lost` settle timing).

- [ ] **Step 3: Commit** — `test(modules): pin minority-cannot-commit and heal-truncates-the-tail`

---

### Task 4: Behavioral gate — election safety under churn

**Files:** `src/modules/raft.test.ts` (append)

- [ ] **Step 1: Append**

```ts
// append to src/modules/raft.test.ts
test('kill and revive cycles never yield two leaders in one term', () => {
  const sim = fresh(9007);
  const leadersByTerm = new Map<number, Set<string>>();
  const snapshotLeaders = () => {
    for (const n of RAFT_NODES) {
      const s = st(sim, n);
      if (s.role === 'leader') {
        const set = leadersByTerm.get(s.term) ?? new Set();
        set.add(n);
        leadersByTerm.set(s.term, set);
      }
    }
  };
  until(sim, () => leaders(sim).length >= 1);
  snapshotLeaders();
  for (let round = 0; round < 3; round++) {
    const lead = leaders(sim)[0];
    if (lead) sim.control({ type: 'kill', node: lead });
    for (let i = 0; i < 3000 && sim.pending > 0; i++) {
      sim.runSteps(1);
      snapshotLeaders();
    }
    if (lead) sim.control({ type: 'revive', node: lead });
    for (let i = 0; i < 3000 && sim.pending > 0; i++) {
      sim.runSteps(1);
      snapshotLeaders();
    }
  }
  for (const [, set] of leadersByTerm) expect(set.size).toBe(1);
});

test('a revived old leader with a stale term steps down on first contact', () => {
  const sim = fresh();
  until(sim, () => leaders(sim).length === 1);
  const old = leaders(sim)[0];
  sim.control({ type: 'kill', node: old });
  until(sim, () => leaders(sim).some((l) => l !== old), 20000);
  sim.control({ type: 'revive', node: old });
  until(sim, () => st(sim, old).role === 'follower', 20000);
  const neo = leaders(sim).find((l) => l !== old) as string;
  expect(st(sim, old).term).toBeGreaterThanOrEqual(st(sim, neo).term - 1);
});
```

- [ ] **Step 2: Run; fix real bugs only. Step 3: Commit** — `test(modules): pin election safety under kill/revive churn`

---

### Task 5: Behavioral gate — log matching under conflict

**Files:** `src/modules/raft.test.ts` (append)

- [ ] **Step 1: Append**

```ts
// append to src/modules/raft.test.ts
test('logs converge: any two nodes agree at every index they share (after quiet time)', () => {
  const sim = fresh(9011);
  until(sim, () => leaders(sim).length === 1);
  const l1 = leaders(sim)[0];
  sim.external(l1, { cmd: 'write', value: 1 });
  sim.external(l1, { cmd: 'write', value: 2 });
  until(sim, () => st(sim, l1).commitIndex >= 2, 6000);
  // partition the leader alone with an uncommitted dangling write
  const others = RAFT_NODES.filter((n) => n !== l1);
  sim.control({ type: 'partition', groups: [[l1], others] });
  sim.external(l1, { cmd: 'write', value: 3 }); // dangles
  until(sim, () => others.some((n) => st(sim, n).role === 'leader'), 20000);
  const l2 = others.find((n) => st(sim, n).role === 'leader') as string;
  sim.external(l2, { cmd: 'write', value: 4 });
  until(sim, () => st(sim, l2).commitIndex >= 3, 8000);
  sim.control({ type: 'heal' });
  until(sim, () => st(sim, l1).kv === st(sim, l2).kv && st(sim, l1).log.length === st(sim, l2).log.length, 20000);
  // log matching: same index → same term → same value
  for (const a of RAFT_NODES) {
    for (const b of RAFT_NODES) {
      const la = st(sim, a).log;
      const lb = st(sim, b).log;
      for (let i = 0; i < Math.min(la.length, lb.length); i++) {
        if (la[i].term === lb[i].term) expect(la[i].seq).toBe(lb[i].seq);
      }
    }
  }
  // committed prefix identical everywhere it exists
  const commit = st(sim, l2).commitIndex;
  for (const n of RAFT_NODES) {
    const s = st(sim, n);
    for (let i = 0; i < Math.min(commit, s.commitIndex); i++) {
      expect(s.log[i].seq).toBe(st(sim, l2).log[i].seq);
    }
  }
});
```

- [ ] **Step 2: Run; fix real bugs. Step 3: Commit** — `test(modules): pin log matching through a dangling-tail heal`

---

### Task 6: Behavioral gate — the stale read + checker integration

**Files:** `src/modules/raft.test.ts` (append)

- [ ] **Step 1: Append**

```ts
// append to src/modules/raft.test.ts — extend imports: mergedHistory, completedOps from './raft';
// checkLinearizable from './linearizable'
test('a deposed leader serves a stale read and the checker catches it', () => {
  const sim = fresh(9013);
  until(sim, () => leaders(sim).length === 1);
  const old = leaders(sim)[0];
  sim.external(old, { cmd: 'write', value: 1 });
  until(sim, () => st(sim, old).commitIndex >= 1, 6000);
  const others = RAFT_NODES.filter((n) => n !== old);
  sim.control({ type: 'partition', groups: [[old], others] });
  until(sim, () => others.some((n) => st(sim, n).role === 'leader'), 20000);
  const neo = others.find((n) => st(sim, n).role === 'leader') as string;
  sim.external(neo, { cmd: 'write', value: 2 });
  until(sim, () => st(sim, neo).commitIndex >= 2, 8000);
  // the old leader still believes; it serves its stale register
  sim.external(old, { cmd: 'read' });
  sim.runSteps(1);
  const states = new Map(RAFT_NODES.map((n) => [n, st(sim, n)] as const));
  const ops = completedOps(mergedHistory(states));
  const verdict = checkLinearizable(ops);
  expect(verdict.verdict).toBe('violation');
  // and without the stale read the same history is fine
  const clean = ops.filter((o) => !(o.op === 'read' && o.value === 1));
  expect(checkLinearizable(clean).verdict).toBe('ok');
});
```

- [ ] **Step 2: Run; fix real bugs. Step 3: Commit** — `test(modules): pin the stale read — the checker flags a deposed leader's answer`

---

### Task 7: metrics + inspect

**Files:** `src/modules/raft.ts` (replace stubs; add `RaftInspect`), `src/modules/raft.test.ts` (append)

**Interface:**

```ts
export interface RaftInspect {
  id: NodeId;
  role: RaftState['role'];
  term: number;
  votedFor: NodeId | null;
  log: Entry[];
  commitIndex: number;
  kv: number;
  history: HistoryRow[];
}
```

- [ ] **Step 1: Append tests**

```ts
// append to src/modules/raft.test.ts — extend './raft' import with type RaftInspect if used
test('inspect exposes the per-node panel contract', () => {
  const sim = fresh();
  until(sim, () => leaders(sim).length === 1);
  const lead = leaders(sim)[0];
  const i = raft.inspect(st(sim, lead)) as unknown as { role: string; term: number; log: unknown[]; commitIndex: number };
  expect(i.role).toBe('leader');
  expect(i.term).toBeGreaterThanOrEqual(1);
  expect(Array.isArray(i.log)).toBe(true);
});

test('metrics: leader count, max term, committed, per-node log length', () => {
  const sim = fresh();
  until(sim, () => leaders(sim).length === 1);
  const states = new Map(RAFT_NODES.map((n) => [n, st(sim, n)] as const));
  const names = raft.metrics(states, sim.time).map((m) => m.name);
  expect(names).toEqual(expect.arrayContaining(['raft/leaders', 'raft/max-term', 'raft/committed', 'n1/log']));
});
```

- [ ] **Step 2: RED → implement:**

```ts
  metrics(states): MetricSample[] {
    const out: MetricSample[] = [];
    let leadersN = 0;
    let maxTerm = 0;
    let committed = 0;
    for (const s of states.values()) {
      if (s.role === 'leader') leadersN += 1;
      maxTerm = Math.max(maxTerm, s.term);
      committed = Math.max(committed, s.commitIndex);
      out.push({ name: `${String(s.id).toLowerCase()}/log`, value: s.log.length });
    }
    out.push({ name: 'raft/leaders', value: leadersN });
    out.push({ name: 'raft/max-term', value: maxTerm });
    out.push({ name: 'raft/committed', value: committed });
    return out;
  },

  inspect(state) {
    const { id, role, term, votedFor, log, commitIndex, kv, history } = state;
    return { id, role, term, votedFor, log, commitIndex, kv, history } as unknown as InspectorTree;
  },
```

- [ ] **Step 3: GREEN + tsc + eslint. Commit** — `feat(modules): raft inspect/metrics — panel contract`

---

### Task 8: Property suite

**Files:** `src/modules/raft.property.test.ts`

- [ ] **Step 1: Write** — random fault scripts (timed kills/revives/partitions/heals/writes), then assert invariants. Use the generator shape below; each property gets its own seed band and `numRuns: 15` (Raft runs are heavy — ~10k events each).

```ts
// src/modules/raft.property.test.ts
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { Simulation } from '../engine';
import { checkLinearizable } from './linearizable';
import { completedOps, mergedHistory, raft, type RaftState } from './raft';
import { RAFT_NODES, type RaftPayload } from './raft-shared';

type Cmd =
  | { at: number; kill: string }
  | { at: number; revive: string }
  | { at: number; split: number } // partition: first `split` nodes vs the rest
  | { at: number; heal: true }
  | { at: number; writeAt: string; value: number };

const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
  fc.record({ at: fc.integer({ min: 0, max: 2000 }), kill: fc.constantFrom(...RAFT_NODES) }),
  fc.record({ at: fc.integer({ min: 0, max: 2000 }), revive: fc.constantFrom(...RAFT_NODES) }),
  fc.record({ at: fc.integer({ min: 0, max: 2000 }), split: fc.integer({ min: 1, max: 4 }) }),
  fc.record({ at: fc.integer({ min: 0, max: 2000 }), heal: fc.constant(true as const) }),
  fc.record({
    at: fc.integer({ min: 0, max: 2000 }),
    writeAt: fc.constantFrom(...RAFT_NODES),
    value: fc.integer({ min: 1, max: 99 }),
  }),
);

const script = fc.array(cmdArb, { minLength: 1, maxLength: 8 });

function run(cmds: Cmd[], seed: number) {
  const sim = new Simulation<RaftState, RaftPayload>({ module: raft, config: { nodeIds: RAFT_NODES }, seed });
  sim.runSteps(RAFT_NODES.length);
  const leadersByTerm = new Map<number, Set<string>>();
  const dead = new Set<string>();
  const snap = () => {
    for (const n of RAFT_NODES) {
      const s = sim.getState(n);
      if (s.role === 'leader') {
        const set = leadersByTerm.get(s.term) ?? new Set<string>();
        set.add(n);
        leadersByTerm.set(s.term, set);
      }
    }
  };
  const ordered = [...cmds].sort((a, b) => a.at - b.at);
  for (const c of ordered) {
    while (sim.time < c.at && sim.pending > 0) {
      sim.runSteps(1);
      snap();
    }
    if ('kill' in c && !dead.has(c.kill)) {
      sim.control({ type: 'kill', node: c.kill });
      dead.add(c.kill);
    } else if ('revive' in c && dead.has(c.revive)) {
      sim.control({ type: 'revive', node: c.revive });
      dead.delete(c.revive);
    } else if ('split' in c) {
      sim.control({ type: 'partition', groups: [RAFT_NODES.slice(0, c.split), RAFT_NODES.slice(c.split)] });
    } else if ('heal' in c) {
      sim.control({ type: 'heal' });
    } else if ('writeAt' in c) {
      sim.external(c.writeAt, { cmd: 'write', value: c.value });
    }
  }
  sim.control({ type: 'heal' });
  for (const n of [...dead]) sim.control({ type: 'revive', node: n });
  for (let i = 0; i < 30000 && sim.pending > 0; i++) {
    sim.runSteps(1);
    snap();
  }
  const states = new Map(RAFT_NODES.map((n) => [n, sim.getState(n)] as const));
  return { states, leadersByTerm };
}

test('election safety: at most one leader per term, ever', () => {
  fc.assert(
    fc.property(script, fc.integer({ min: 1, max: 500 }), (cmds, s) => {
      const { leadersByTerm } = run(cmds, 9100 + s);
      for (const [, set] of leadersByTerm) expect(set.size).toBe(1);
    }),
    { numRuns: 15 },
  );
});

test('log matching: same index + same term → same entry', () => {
  fc.assert(
    fc.property(script, fc.integer({ min: 1, max: 500 }), (cmds, s) => {
      const { states } = run(cmds, 9200 + s);
      const all = [...states.values()];
      for (const a of all) {
        for (const b of all) {
          for (let i = 0; i < Math.min(a.log.length, b.log.length); i++) {
            if (a.log[i].term === b.log[i].term) expect(a.log[i].seq).toBe(b.log[i].seq);
          }
        }
      }
    }),
    { numRuns: 15 },
  );
});

test('state machine safety: applied prefixes never diverge', () => {
  fc.assert(
    fc.property(script, fc.integer({ min: 1, max: 500 }), (cmds, s) => {
      const { states } = run(cmds, 9300 + s);
      const all = [...states.values()];
      for (const a of all) {
        for (const b of all) {
          const shared = Math.min(a.commitIndex, b.commitIndex);
          for (let i = 0; i < shared; i++) expect(a.log[i].seq).toBe(b.log[i].seq);
        }
      }
    }),
    { numRuns: 15 },
  );
});

test('determinism: same script + seed → identical states', () => {
  fc.assert(
    fc.property(script, (cmds) => {
      const a = run(cmds, 9400);
      const b = run(cmds, 9400);
      for (const n of RAFT_NODES) {
        expect(JSON.stringify(a.states.get(n))).toBe(JSON.stringify(b.states.get(n)));
      }
    }),
    { numRuns: 8 },
  );
});

test('writes-only histories (no reads) are always linearizable', () => {
  fc.assert(
    fc.property(script, fc.integer({ min: 1, max: 500 }), (cmds, s) => {
      const { states } = run(cmds, 9500 + s);
      const ops = completedOps(mergedHistory(states));
      if (ops.length <= 12) expect(checkLinearizable(ops).verdict).not.toBe('violation');
    }),
    { numRuns: 15 },
  );
});

test('checker vs brute force on tiny random histories', () => {
  const opArb = fc.record({
    op: fc.constantFrom<'write' | 'read'>('write', 'read'),
    value: fc.integer({ min: 0, max: 3 }),
    start: fc.integer({ min: 0, max: 40 }),
    len: fc.integer({ min: 1, max: 20 }),
  });
  const bruteForce = (ops: { op: 'write' | 'read'; value: number; invokedAt: number; respondedAt: number }[]): boolean => {
    const n = ops.length;
    const idx = [...Array(n).keys()];
    const perms = (arr: number[]): number[][] => (arr.length <= 1 ? [arr] : arr.flatMap((x, i) => perms([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [x, ...p])));
    outer: for (const p of perms(idx)) {
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          if (ops[p[j]].respondedAt < ops[p[i]].invokedAt) continue outer; // real-time violated
        }
      }
      let reg = 0;
      let ok = true;
      for (const k of p) {
        if (ops[k].op === 'write') reg = ops[k].value;
        else if (ops[k].value !== reg) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  };
  fc.assert(
    fc.property(fc.array(opArb, { minLength: 1, maxLength: 5 }), (raw) => {
      const ops = raw.map((o) => ({ op: o.op, value: o.value, invokedAt: o.start, respondedAt: o.start + o.len }));
      const fast = checkLinearizable(ops).verdict === 'ok';
      expect(fast).toBe(bruteForce(ops));
    }),
    { numRuns: 200 },
  );
});
```

- [ ] **Step 2: Run** — a counterexample is a REAL Raft bug: shrink, report, fix minimally, document. Note runtime; if the suite exceeds ~60s, halve `numRuns` and say so. **Commit** — `test(modules): raft property suite — election/log/SM safety, checker cross-check`

---

### Task 9: Pinned lesson test

**Files:** `src/modules/raft-lesson.test.ts` — the full challenge-matrix choreography, deterministic seed. Inline its own helpers (do NOT import from raft.test.ts).

- [ ] **Step 1: Write** — script: elect → write 1 (commits) → partition leader alone → write 99 at old leader (pending) → majority elects → write 2 at new leader (commits) → read at old leader (stale 1, `ok` row) → checker flags violation → heal → old leader follower, kv 2, write-99 row `lost`, logs converge, checker on post-heal completed ops minus the stale read = ok. Assert every clause. (Same assertions as the Task 6 gate plus the heal matrix — this is the challenge-verifier contract.)

Implementation: copy the Task 6 test's structure, extend with the heal phase from Task 3's second test, under seed 9042 with its own `fresh`/`until`/`st` helpers inlined.

- [ ] **Step 2: Run; fix real bugs. Commit** — `test(modules): pin the Ch9 lesson — minority, heal, stale read, checker verdicts`

---

### Task 10: RaftView + HistoryPanel

**Files:** `src/ui/labs/raft/RaftView.tsx` (+ `.test.tsx`), `src/ui/labs/raft/HistoryPanel.tsx` (+ `.test.tsx`)

**Interfaces:**
- `RaftView({ nodes, deadNodes }: { nodes: RaftInspect[]; deadNodes: string[] })` — five columns: role badge (`data-node`, `data-role`), term, votedFor, log entries as small boxes (`data-entry`, text `t{term}:{value}`, committed ones get `data-committed="true"`, class `text-set` committed / `text-dim` not), kv readout. Dead nodes dimmed (`opacity-40`, `data-dead="true"`).
- `HistoryPanel({ rows, verdict, onCheck, capped }: { rows: HistoryRow[]; verdict: Verdict | null; onCheck: () => void; capped: boolean })` — table of rows (`data-hrow`, `data-outcome`), outcome classes ok=text-set, lost=text-sign, redirect=text-dim, pending=text-warn; a `check linearizability` button (`data-action="check"`, disabled when `capped`); verdict line (`data-verdict` = ok|violation|too-long; violation shows the culprit row highlighted `data-culprit="true"`).

- [ ] **Step 1: Tests** — fixtures with two nodes (leader/follower), 3-entry logs (2 committed), history rows of each outcome; assert data-attrs, classes, culprit highlight when `verdict={verdict:'violation', culprit:1}`, button disabled when capped, onCheck fires.

- [ ] **Step 2: Implement** presentational components per the interfaces (theme tokens, monospace, `w-40`-ish columns, overflow-x wrap for five columns).

- [ ] **Step 3: GREEN + eslint + tsc. Commit** — `feat(ui): RaftView + HistoryPanel — five logs, client history, checker verdict`

---

### Task 11: RaftLab — assembly + challenges

**Files:** `src/ui/labs/raft/RaftLab.tsx` (+ `.test.tsx`)

Mechanics:
- Driver-in-effect keyed `[epoch]`, drain inits at mount, seed `9000 + epoch`.
- Client controls: node select (`inputBox` select, `data-control="node"`), `write` button (auto-incrementing value counter starting 1), `read` button — both call `driver.external(selected, ...)`.
- `RaftView` from `view.nodes` inspects; `HistoryPanel` rows from `mergedHistory` over `driver.sim.getState` map, `completedOps` length > CHECK_CAP → `capped`; check button runs `checkLinearizable(completedOps(...))` into local state (re-cleared on epoch).
- `ChaosToolbar` with `raft.chaos`; forward-only scrub; `MetricsPanel`.
- Challenges (verifiers read `driver.sim.getState`):
  1. `ddia:ch09:minority` — "The minority cannot decide": win when SOME node has a `pending` write row while partitioned AND a leader exists whose term > that node's term. Gate: a partition control was fired this epoch (UI flag `partitionedFlag` set in onAction when action.type === 'partition').
  2. `ddia:ch09:heal` — "Heal and repent": win when some row is `lost` AND all live nodes share identical committed prefixes (compare via `driver.sim.getState` logs) AND no node is partitioned (flag cleared on heal action).
  3. `ddia:ch09:stale` — "Catch the stale read": win when the checker state (last run verdict) is `violation`. Gate: verdict came from THIS epoch's check button.
- Smoke tests: renders 5 columns + 3 challenges; write at selected node lands in history after stepping; check button produces a verdict line.

- [ ] **Steps: TDD → GREEN + eslint + tsc + full suite. Commit** — `feat(ui): RaftLab — five-node cluster, client history, checker, 3 consensus challenges`

---

### Task 12: Debrief, wiring, docs

**Files:** `content/ch09/debrief.mdx`, `src/ui/labs/raft/Debrief.tsx`, `src/ui/shell/catalog.ts` (9.1/9.d active), `src/ui/App.tsx` (imports + PAGES after '8.d'), `README.md` (Ch9 block; bump the status counter to "Eight chapters live — fifteen interactive labs"), `docs/DESIGN_PLAN.en.md` (Phase 3 complete note).

Debrief MDX covers: why consensus (the minority's silence IS the safety), terms as fencing tokens (Ch8 callback), the §5.4.2 commit restriction in one paragraph, linearizability defined via the checker the learner just used, the stale-read fix menu (read-index / lease reads / quorum reads), what was cut (snapshots, membership change, PreVote), real systems (etcd/ZooKeeper-ZAB/Spanner). Terms list. App theses: 9.1 — "Five nodes, one log. Elect, replicate, partition — the minority goes mute instead of wrong. Then catch a deposed leader lying to a client and prove it with a linearizability checker."; 9.d — "Consensus is the art of the majority; linearizability is the promise your reads keep. What the checker saw, and the tricks real systems use to read fast without lying."

Gate: `npx vitest run && npx tsc -b && npm run build`. **Commit** — `feat(ui): ship Ch9 Raft lab — debrief, catalog 9.1/9.d active, roadmap`

---

### Task 13: Ship gate + DoD

- [ ] Full gate green; browser DoD walk (vite preview + playwright): challenge 1–3 winnable per their hints (partition via ChaosToolbar checkboxes + split; step/play mix), checker verdict renders, debrief renders, 0 console errors. Fix-forward; never weaken pinned tests.

## Post-plan (main thread)

Push `master` → Pages CI green → live spot-check → ledger/memory → Ch10.
