import type { NodeId } from '../engine/events';
import type { Effect, InspectorTree, ModuleEvent, SimModule } from '../engine/module';

/**
 * Leaderless (Dynamo-style) quorum replication (DDIA Ch5). Home replicas for
 * every key are the first 3 nodes; the rest are sloppy fallbacks. Any node
 * can coordinate a client op. Writes fan out to home replicas and ack the
 * client at w replica acks; reads fan out and return the newest of r replies,
 * read-repairing stale responders. With sloppy=true, a write timeout re-sends
 * to fallbacks as hints — fallback acks count toward w (sloppy quorum), and
 * fallbacks retry handoff to the home replica until it acks.
 */
export type LLHistory =
  | { type: 'ack'; key: string; ts: number; time: number }
  | { type: 'failed-write'; key: string; time: number }
  | { type: 'read'; node: NodeId; key: string; returnedTs: number; time: number }
  | { type: 'read-repair'; key: string; to: NodeId; time: number };

interface PendingWrite {
  kind: 'write';
  key: string;
  value: string;
  ts: number;
  acks: NodeId[];
  hinted: boolean;
  done: boolean;
}
interface PendingRead {
  kind: 'read';
  key: string;
  replies: { from: NodeId; ts: number; value: string | null }[];
  done: boolean;
}

export interface LLState {
  self: NodeId;
  home: NodeId[];
  fallbacks: NodeId[];
  w: number;
  r: number;
  sloppy: boolean;
  data: Record<string, { value: string; ts: number }>;
  /** Fallback-held writes awaiting handoff, keyed `${target}:${key}`. */
  hintBuffer: Record<string, { key: string; value: string; ts: number; target: NodeId }>;
  pending: Record<number, PendingWrite | PendingRead>;
  nextOp: number;
  history: LLHistory[];
}

export type LLPayload =
  | { cmd: 'write'; key: string; value: string }
  | { cmd: 'read'; key: string }
  | { msg: 'store'; opId?: number; key: string; value: string; ts: number; handoffOf?: string }
  | { msg: 'storeAck'; opId?: number; key: string; ts: number; handoffOf?: string }
  | { msg: 'storeHint'; opId: number; key: string; value: string; ts: number; target: NodeId }
  | { msg: 'get'; opId: number; key: string }
  | { msg: 'getReply'; opId: number; key: string; ts: number; value: string | null }
  | { timer: 'op-timeout'; opId: number }
  | { timer: 'handoff' }
  | null;

const OP_TIMEOUT_MS = 200;
const HANDOFF_RETRY_MS = 100;

function applyLww(s: LLState, key: string, value: string, ts: number): LLState {
  const cur = s.data[key];
  if (cur && cur.ts >= ts) return s;
  return { ...s, data: { ...s.data, [key]: { value, ts } } };
}

export interface LostAckedWriteResult {
  ack: Extract<LLHistory, { type: 'ack' }>;
  coordinator: NodeId;
}

/**
 * An acked write whose (key, ts) exists on no ALIVE node — neither applied
 * data nor a pending hint. Sound without quiescence: an ack implies >= w nodes
 * applied or hinted the value before acking, so a live copy always exists
 * unless every holder died.
 */
export function detectLostAckedWrite(
  states: Map<NodeId, LLState>,
  deadNodes: NodeId[],
): LostAckedWriteResult | null {
  const dead = new Set(deadNodes);
  for (const [coordinator, s] of states) {
    for (const h of s.history) {
      if (h.type !== 'ack') continue;
      let alive = false;
      for (const [id, t] of states) {
        if (dead.has(id)) continue;
        if ((t.data[h.key]?.ts ?? -1) >= h.ts) alive = true;
        for (const hint of Object.values(t.hintBuffer)) {
          if (hint.key === h.key && hint.ts >= h.ts) alive = true;
        }
      }
      if (!alive) return { ack: h, coordinator };
    }
  }
  return null;
}

function handleClient(s: LLState, ev: ModuleEvent<LLPayload>): [LLState, Effect[]] {
  const p = ev.payload as Extract<LLPayload, { cmd: string }>;
  const opId = s.nextOp;
  if (p.cmd === 'write') {
    // 1-based version: virtual time starts at 0, but a write must carry a
    // strictly-positive version so a read can distinguish a real value
    // (even one written at t=0) from the no-data sentinel below, and so
    // empty/stale replicas are always detected and read-repaired.
    const ts = ev.time + 1;
    const op: PendingWrite = { kind: 'write', key: p.key, value: p.value, ts, acks: [], hinted: false, done: false };
    const effects: Effect[] = s.home.map((n) => ({
      type: 'send',
      to: n,
      payload: { msg: 'store', opId, key: p.key, value: p.value, ts },
    }));
    effects.push({ type: 'timer', delay: OP_TIMEOUT_MS, payload: { timer: 'op-timeout', opId } });
    return [{ ...s, nextOp: opId + 1, pending: { ...s.pending, [opId]: op } }, effects];
  }
  const op: PendingRead = { kind: 'read', key: p.key, replies: [], done: false };
  // NOTE: reads have no op-timeout / failed-read path (unlike writes). Every
  // scripted lab scenario heals partitions before reading, so w+r>n overlap
  // guarantees r replies. A read that can never reach r replies stays pending
  // by design; adding a failed-read variant would expand LLHistory — tracked
  // as a follow-up, not implemented here.
  const effects: Effect[] = s.home.map((n) => ({
    type: 'send',
    to: n,
    payload: { msg: 'get', opId, key: p.key },
  }));
  return [{ ...s, nextOp: opId + 1, pending: { ...s.pending, [opId]: op } }, effects];
}

function handleMessage(s: LLState, ev: ModuleEvent<LLPayload>): [LLState, Effect[]] {
  const p = ev.payload as Extract<LLPayload, { msg: string }>;
  const from = ev.from!;
  switch (p.msg) {
    case 'store': {
      const next = applyLww(s, p.key, p.value, p.ts);
      return [
        next,
        [{ type: 'send', to: from, payload: { msg: 'storeAck', opId: p.opId, key: p.key, ts: p.ts, handoffOf: p.handoffOf } }],
      ];
    }
    case 'storeHint': {
      const hintKey = `${p.target}:${p.key}`;
      const cur = s.hintBuffer[hintKey];
      const wasEmpty = Object.keys(s.hintBuffer).length === 0;
      const next: LLState =
        cur && cur.ts >= p.ts
          ? s
          : { ...s, hintBuffer: { ...s.hintBuffer, [hintKey]: { key: p.key, value: p.value, ts: p.ts, target: p.target } } };
      // Arm the handoff retry loop only on the empty->non-empty transition —
      // the handoff timer handler self-reschedules while the buffer is
      // non-empty, so a hint arriving while the loop is already running
      // must not spawn a second, independent retry loop.
      const effects: Effect[] = [{ type: 'send', to: from, payload: { msg: 'storeAck', opId: p.opId, key: p.key, ts: p.ts } }];
      if (wasEmpty) {
        effects.push({ type: 'timer', delay: HANDOFF_RETRY_MS, payload: { timer: 'handoff' } });
      }
      return [next, effects];
    }
    case 'storeAck': {
      // Handoff confirmation: clear the delivered hint.
      if (p.handoffOf !== undefined) {
        if (!s.hintBuffer[p.handoffOf]) return [s, []];
        const hintBuffer = { ...s.hintBuffer };
        delete hintBuffer[p.handoffOf];
        return [{ ...s, hintBuffer }, []];
      }
      if (p.opId === undefined) return [s, []]; // read-repair ack — nothing to track
      const op = s.pending[p.opId];
      if (!op || op.kind !== 'write' || op.done) return [s, []];
      if (op.acks.includes(from)) return [s, []]; // duplicate
      const acks = [...op.acks, from];
      if (acks.length < s.w) {
        return [{ ...s, pending: { ...s.pending, [p.opId]: { ...op, acks } } }, []];
      }
      return [
        {
          ...s,
          pending: { ...s.pending, [p.opId]: { ...op, acks, done: true } },
          history: [...s.history, { type: 'ack', key: op.key, ts: op.ts, time: ev.time }],
        },
        [],
      ];
    }
    case 'get': {
      const cur = s.data[p.key];
      return [
        s,
        [
          {
            type: 'send',
            to: from,
            // no-data sentinel: -1 is below any real version (>=1), so an empty replica always
            // reads as stale and gets repaired (matches detectLostAckedWrite's ?? -1).
            payload: { msg: 'getReply', opId: p.opId, key: p.key, ts: cur?.ts ?? -1, value: cur?.value ?? null },
          },
        ],
      ];
    }
    case 'getReply': {
      const op = s.pending[p.opId];
      if (!op || op.kind !== 'read' || op.done) return [s, []];
      if (op.replies.some((x) => x.from === from)) return [s, []];
      const replies = [...op.replies, { from, ts: p.ts, value: p.value }];
      if (replies.length < s.r) {
        return [{ ...s, pending: { ...s.pending, [p.opId]: { ...op, replies } } }, []];
      }
      const newest = replies.reduce((a, b) => (b.ts > a.ts ? b : a));
      let next: LLState = {
        ...s,
        pending: { ...s.pending, [p.opId]: { ...op, replies, done: true } },
        history: [
          ...s.history,
          { type: 'read', node: s.self, key: op.key, returnedTs: newest.ts, time: ev.time },
        ],
      };
      const effects: Effect[] = [];
      if (newest.value !== null) {
        for (const rep of replies) {
          if (rep.ts < newest.ts) {
            effects.push({
              type: 'send',
              to: rep.from,
              payload: { msg: 'store', key: op.key, value: newest.value, ts: newest.ts },
            });
            next = { ...next, history: [...next.history, { type: 'read-repair', key: op.key, to: rep.from, time: ev.time }] };
          }
        }
      }
      return [next, effects];
    }
  }
}

function handleTimer(s: LLState, ev: ModuleEvent<LLPayload>): [LLState, Effect[]] {
  const p = ev.payload as Extract<LLPayload, { timer: string }>;
  if (p.timer === 'handoff') {
    const hints = Object.entries(s.hintBuffer);
    if (hints.length === 0) return [s, []];
    const effects: Effect[] = hints.map(([hintKey, h]) => ({
      type: 'send',
      to: h.target,
      payload: { msg: 'store', key: h.key, value: h.value, ts: h.ts, handoffOf: hintKey },
    }));
    effects.push({ type: 'timer', delay: HANDOFF_RETRY_MS, payload: { timer: 'handoff' } });
    return [s, effects];
  }
  // op-timeout
  const op = s.pending[p.opId];
  if (!op || op.kind !== 'write' || op.done) return [s, []];
  if (!s.sloppy || op.hinted) {
    return [
      {
        ...s,
        pending: { ...s.pending, [p.opId]: { ...op, done: true } },
        history: [...s.history, { type: 'failed-write', key: op.key, time: ev.time }],
      },
      [],
    ];
  }
  // Sloppy: hint the missing home replicas onto the fallbacks, then one final timeout.
  const missing = s.home.filter((n) => !op.acks.includes(n));
  const effects: Effect[] = missing.slice(0, s.fallbacks.length).map((target, i) => ({
    type: 'send',
    to: s.fallbacks[i],
    payload: { msg: 'storeHint', opId: p.opId, key: op.key, value: op.value, ts: op.ts, target },
  }));
  effects.push({ type: 'timer', delay: OP_TIMEOUT_MS, payload: { timer: 'op-timeout', opId: p.opId } });
  return [{ ...s, pending: { ...s.pending, [p.opId]: { ...op, hinted: true } } }, effects];
}

export const leaderless: SimModule<LLState, LLPayload> = {
  id: 'leaderless-quorum',
  chaos: ['kill-node', 'partition', 'delay', 'drop', 'duplicate'],

  init(nodeId, config) {
    const home = config.nodeIds.slice(0, 3);
    const fallbacks = config.nodeIds.slice(3);
    const params = (config.params ?? {}) as { w?: number; r?: number; sloppy?: boolean };
    return {
      self: nodeId,
      home,
      fallbacks,
      w: params.w ?? 2,
      r: params.r ?? 2,
      sloppy: params.sloppy ?? false,
      data: {},
      hintBuffer: {},
      pending: {},
      nextOp: 1,
      history: [],
    };
  },

  reduce(state, event): [LLState, Effect[]] {
    const p = event.payload;
    if (event.kind === 'external' && p && 'cmd' in p) return handleClient(state, event);
    if (event.kind === 'message' && p && 'msg' in p) return handleMessage(state, event);
    if (event.kind === 'timer' && p && 'timer' in p) return handleTimer(state, event);
    return [state, []];
  },

  metrics(states) {
    let acked = 0;
    let failed = 0;
    let repairs = 0;
    let hints = 0;
    for (const s of states.values()) {
      hints += Object.keys(s.hintBuffer).length;
      for (const h of s.history) {
        if (h.type === 'ack') acked++;
        else if (h.type === 'failed-write') failed++;
        else if (h.type === 'read-repair') repairs++;
      }
    }
    return [
      { name: 'acked-writes', value: acked },
      { name: 'failed-writes', value: failed },
      { name: 'read-repairs', value: repairs },
      { name: 'hints-outstanding', value: hints },
    ];
  },

  inspect(state) {
    return {
      role: state.fallbacks.includes(state.self) ? 'fallback' : 'home',
      data: state.data,
      hints: Object.keys(state.hintBuffer).length,
      pendingOps: Object.values(state.pending).filter((o) => !o.done).length,
    } as InspectorTree;
  },
};
