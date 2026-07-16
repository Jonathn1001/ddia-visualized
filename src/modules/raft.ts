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
  type RaftExternal,
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

/** The per-node inspector panel contract. */
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

/**
 * Any sign of a higher term → become that term's follower (paper rule, all RPCs).
 * Re-arms the election timer: a demoted leader has no timer pending (heartbeats
 * are nonce-guarded against non-leaders), so without this it could never
 * self-recover — a liveness hole.
 */
function adoptTerm(s: RaftState, term: number, rng: SeededRng, fx: Effect[]): void {
  s.term = term;
  s.role = 'follower';
  s.votedFor = null;
  s.votes = [];
  armElection(s, rng, fx);
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

function handleTimer(s: RaftState, p: RaftTimer, rng: SeededRng, now: number, fx: Effect[]): void {
  if (p.t === 'client') {
    // second phase of the client-op hop — invokedAt is the timer's fire time,
    // strictly after anything that settled at the injection tick.
    handleExternal(s, p.op, now, fx);
  } else if (p.t === 'election') {
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
  if (p.term > s.term) adoptTerm(s, p.term, rng, fx);

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
      handleTimer(s, ev.payload as RaftTimer, rng, ev.time, fx);
    } else if (ev.kind === 'message' && 'kind' in (ev.payload as object) && ev.from) {
      handleMsg(s, ev.payload as RaftMsg, ev.from, ev.time, rng, fx);
    } else if (ev.kind === 'external' && 'cmd' in (ev.payload as object)) {
      // Client ops enter via a 1-tick timer hop, not directly: sim.external()
      // schedules at the frozen sim.time, so an op injected the instant a prior
      // op settled would share its tick and the linearizability checker would
      // (correctly) treat the pair as concurrent — letting a stale read dodge
      // the verdict. The hop gives every client op a strictly later invokedAt.
      // No state change at injection.
      fx.push({ type: 'timer', delay: 1, payload: { t: 'client', op: ev.payload as RaftExternal } });
    }
    return [s, fx];
  },

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
};

/** All client rows across the cluster, oldest-first — the checker's input source. */
export function mergedHistory(states: Map<NodeId, RaftState>): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (const s of states.values()) rows.push(...s.history);
  return rows.sort(
    (a, b) => a.invokedAt - b.invokedAt || a.node.localeCompare(b.node) || Number(a.id.split(':')[1]) - Number(b.id.split(':')[1]),
  );
}

/** Only completed, value-bearing ops participate in the linearizability check. */
export function completedOps(rows: HistoryRow[]): { op: 'write' | 'read'; value: number; invokedAt: number; respondedAt: number }[] {
  return rows
    .filter((r) => r.outcome === 'ok' && r.respondedAt !== null && r.value !== null)
    .map((r) => ({ op: r.op, value: r.value as number, invokedAt: r.invokedAt, respondedAt: r.respondedAt as number }));
}
