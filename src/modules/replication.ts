import type { NodeId } from '../engine/events';
import type { Effect, InspectorTree, ModuleEvent, SimModule } from '../engine/module';

/**
 * Leader-follower replication (DDIA Ch5, Phase 1 slice). nodeIds[0] is the
 * leader. async: ack at write time, no retransmission — drops lose data.
 * sync: ack only after ALL followers confirm; unacked appends retransmit
 * every RETRANSMIT_MS. Followers apply strictly in seq order, buffering gaps.
 */
export type RepMode = 'async' | 'sync';

export interface RepEntry {
  seq: number;
  key: string;
  value: string;
}

export type RepHistory =
  | { type: 'ack'; seq: number; key: string; time: number }
  | { type: 'read'; node: NodeId; key: string; returnedSeq: number; time: number };

export interface RepState {
  self: NodeId;
  role: 'leader' | 'follower';
  leader: NodeId;
  followers: NodeId[];
  mode: RepMode;
  log: RepEntry[];
  data: Record<string, { value: string; seq: number }>;
  /** Leader: next seq to assign (starts at 1). */
  nextSeq: number;
  /** Leader, sync mode: writes awaiting follower acks. */
  pending: Record<number, { entry: RepEntry; awaiting: NodeId[] }>;
  /** Follower: out-of-order entries waiting for the gap to fill. */
  buffer: Record<number, RepEntry>;
  history: RepHistory[];
}

export type RepPayload =
  | { cmd: 'write'; key: string; value: string }
  | { cmd: 'read'; key: string }
  | { rep: 'append'; entry: RepEntry }
  | { rep: 'ack'; seq: number }
  | { retransmit: number }
  | null;

const RETRANSMIT_MS = 60;

function applyEntry(s: RepState, entry: RepEntry): RepState {
  return {
    ...s,
    log: [...s.log, entry],
    data: { ...s.data, [entry.key]: { value: entry.value, seq: entry.seq } },
  };
}

function handleClient(s: RepState, ev: ModuleEvent<RepPayload>): [RepState, Effect[]] {
  const p = ev.payload;
  if (p && 'cmd' in p && p.cmd === 'read') {
    const returnedSeq = s.data[p.key]?.seq ?? 0;
    return [
      { ...s, history: [...s.history, { type: 'read', node: s.self, key: p.key, returnedSeq, time: ev.time }] },
      [],
    ];
  }
  if (!p || !('cmd' in p) || p.cmd !== 'write' || s.role !== 'leader') return [s, []];
  const entry: RepEntry = { seq: s.nextSeq, key: p.key, value: p.value };
  let next = applyEntry({ ...s, nextSeq: s.nextSeq + 1 }, entry);
  const sends: Effect[] = next.followers.map((f) => ({ type: 'send', to: f, payload: { rep: 'append', entry } }));
  if (next.mode === 'async') {
    next = { ...next, history: [...next.history, { type: 'ack', seq: entry.seq, key: entry.key, time: ev.time }] };
    return [next, sends];
  }
  next = { ...next, pending: { ...next.pending, [entry.seq]: { entry, awaiting: [...next.followers] } } };
  return [next, [...sends, { type: 'timer', delay: RETRANSMIT_MS, payload: { retransmit: entry.seq } }]];
}

function handleMessage(s: RepState, ev: ModuleEvent<RepPayload>): [RepState, Effect[]] {
  const p = ev.payload;
  if (p && 'rep' in p && p.rep === 'append' && s.role === 'follower') {
    const appliedBefore = s.log.length; // invariant: log[i].seq === i + 1
    let next: RepState = { ...s, buffer: { ...s.buffer, [p.entry.seq]: p.entry } };
    const ackSeqs: number[] = p.entry.seq <= appliedBefore ? [p.entry.seq] : []; // duplicate → re-ack
    for (;;) {
      const gap = next.log.length + 1;
      const e = next.buffer[gap];
      if (!e) break;
      const buffer = { ...next.buffer };
      delete buffer[gap];
      next = { ...applyEntry(next, e), buffer };
      ackSeqs.push(e.seq);
    }
    const effects: Effect[] =
      next.mode === 'sync'
        ? ackSeqs.map((seq) => ({ type: 'send', to: next.leader, payload: { rep: 'ack', seq } }))
        : [];
    return [next, effects];
  }
  if (p && 'rep' in p && p.rep === 'ack' && s.role === 'leader') {
    const pend = s.pending[p.seq];
    if (!pend || ev.from === undefined) return [s, []]; // already acked / malformed
    const awaiting = pend.awaiting.filter((n) => n !== ev.from);
    if (awaiting.length === pend.awaiting.length) return [s, []]; // duplicate ack from same node
    if (awaiting.length > 0) return [{ ...s, pending: { ...s.pending, [p.seq]: { ...pend, awaiting } } }, []];
    const pending = { ...s.pending };
    delete pending[p.seq];
    return [
      { ...s, pending, history: [...s.history, { type: 'ack', seq: p.seq, key: pend.entry.key, time: ev.time }] },
      [],
    ];
  }
  return [s, []];
}

function handleTimer(s: RepState, ev: ModuleEvent<RepPayload>): [RepState, Effect[]] {
  const p = ev.payload;
  if (!p || !('retransmit' in p)) return [s, []];
  const pend = s.pending[p.retransmit];
  if (!pend) return [s, []]; // fully acked — timer superseded
  return [
    s,
    [
      ...pend.awaiting.map((f): Effect => ({ type: 'send', to: f, payload: { rep: 'append', entry: pend.entry } })),
      { type: 'timer', delay: RETRANSMIT_MS, payload: { retransmit: p.retransmit } },
    ],
  ];
}

function leaderOf(states: Map<NodeId, RepState>): RepState | undefined {
  for (const s of states.values()) if (s.role === 'leader') return s;
  return undefined;
}

type ReadHistory = Extract<RepHistory, { type: 'read' }>;
type AckHistory = Extract<RepHistory, { type: 'ack' }>;

function isStale(read: ReadHistory, acks: AckHistory[]): boolean {
  return acks.some((a) => a.key === read.key && a.seq > read.returnedSeq && a.time <= read.time);
}

/**
 * Chaos-challenge verifier: a read that returned seq s while a same-key write
 * with seq' > s was acked at or before the read. Pure over module states.
 */
export interface StaleReadResult {
  read: ReadHistory;
  ack: AckHistory;
}

export function detectStaleRead(states: Map<NodeId, RepState>): StaleReadResult | null {
  const leader = leaderOf(states);
  if (!leader) return null;
  const acks = leader.history.filter((h): h is AckHistory => h.type === 'ack');
  for (const s of states.values()) {
    for (const h of s.history) {
      if (h.type !== 'read') continue;
      for (const a of acks) {
        if (a.key === h.key && a.seq > h.returnedSeq && a.time <= h.time) return { read: h, ack: a };
      }
    }
  }
  return null;
}

export const replication: SimModule<RepState, RepPayload> = {
  id: 'replication-leader-follower',
  chaos: ['kill-node', 'partition', 'delay', 'drop', 'duplicate'],

  init(nodeId, config) {
    const [leader, ...followers] = config.nodeIds;
    return {
      self: nodeId,
      role: nodeId === leader ? 'leader' : 'follower',
      leader,
      followers,
      mode: (config.params?.mode as RepMode | undefined) ?? 'async',
      log: [],
      data: {},
      nextSeq: 1,
      pending: {},
      buffer: {},
      history: [],
    };
  },

  reduce(state, event): [RepState, Effect[]] {
    switch (event.kind) {
      case 'external':
        return handleClient(state, event);
      case 'message':
        return handleMessage(state, event);
      case 'timer':
        return handleTimer(state, event);
      default:
        return [state, []];
    }
  },

  metrics(states, time) {
    const leader = leaderOf(states);
    if (!leader) return [];
    let maxLag = 0;
    for (const s of states.values())
      if (s.role === 'follower') maxLag = Math.max(maxLag, leader.log.length - s.log.length);
    const acks = leader.history.filter((h): h is AckHistory => h.type === 'ack');
    let staleReads = 0;
    for (const s of states.values())
      for (const h of s.history) if (h.type === 'read' && isStale(h, acks)) staleReads++;
    return [
      { name: 'max-replication-lag', value: maxLag },
      { name: 'acked-writes', value: acks.length },
      { name: 'writes-per-sec', value: acks.filter((a) => a.time > time - 1000).length },
      { name: 'stale-reads', value: staleReads },
    ];
  },

  inspect(state) {
    return {
      role: state.role,
      mode: state.mode,
      applied: state.log.length,
      data: state.data,
      pendingWrites: Object.keys(state.pending).length,
      buffered: Object.keys(state.buffer).length,
    } as InspectorTree;
  },
};
