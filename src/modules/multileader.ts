import type { NodeId } from '../engine/events';
import type { Effect, InspectorTree, SimModule } from '../engine/module';

/**
 * Multi-leader replication with LWW conflict resolution (DDIA Ch5).
 * Both nodes accept writes, ack immediately (async by nature), and replicate
 * fire-and-forget — no retransmission, no anti-entropy: a dropped update
 * diverges forever (the debrief names this). Timestamps are Lamport-bumped
 * virtual time; LWW compares (ts, origin) lexicographically, so ties are
 * deterministic. The losing concurrent write is recorded as `discarded` —
 * that record IS the visible data loss.
 */
export type MLHistory =
  | { type: 'ack'; key: string; ts: number; origin: NodeId; time: number }
  | { type: 'discarded'; key: string; value: string; ts: number; origin: NodeId; time: number }
  | { type: 'read'; node: NodeId; key: string; returnedTs: number; time: number };

export interface MLState {
  self: NodeId;
  peer: NodeId;
  data: Record<string, { value: string; ts: number; origin: NodeId }>;
  history: MLHistory[];
}

export type MLPayload =
  | { cmd: 'write'; key: string; value: string }
  | { cmd: 'read'; key: string }
  | { rep: 'update'; key: string; value: string; ts: number; origin: NodeId }
  | null;

function wins(aTs: number, aOrigin: NodeId, bTs: number, bOrigin: NodeId): boolean {
  return aTs !== bTs ? aTs > bTs : aOrigin > bOrigin;
}

export interface LostWriteResult {
  discarded: Extract<MLHistory, { type: 'discarded' }>;
  ack: Extract<MLHistory, { type: 'ack' }>;
}

/** An acked write that LWW silently threw away at the other node. */
export function detectLostWrite(states: Map<NodeId, MLState>): LostWriteResult | null {
  const acks: Extract<MLHistory, { type: 'ack' }>[] = [];
  for (const s of states.values())
    for (const h of s.history) if (h.type === 'ack') acks.push(h);
  for (const s of states.values()) {
    for (const h of s.history) {
      if (h.type !== 'discarded') continue;
      const ack = acks.find((a) => a.key === h.key && a.ts === h.ts && a.origin === h.origin);
      if (ack) return { discarded: h, ack };
    }
  }
  return null;
}

export const multiLeader: SimModule<MLState, MLPayload> = {
  id: 'multi-leader-lww',
  chaos: ['kill-node', 'partition', 'delay', 'drop', 'duplicate'],

  init(nodeId, config) {
    const peer = config.nodeIds.find((n) => n !== nodeId)!;
    return { self: nodeId, peer, data: {}, history: [] };
  },

  reduce(state, event): [MLState, Effect[]] {
    const p = event.payload;
    if (event.kind === 'external' && p && 'cmd' in p) {
      if (p.cmd === 'read') {
        const returnedTs = state.data[p.key]?.ts ?? 0;
        return [
          {
            ...state,
            history: [
              ...state.history,
              { type: 'read', node: state.self, key: p.key, returnedTs, time: event.time },
            ],
          },
          [],
        ];
      }
      // write: Lamport bump guarantees a local write supersedes what this node has seen.
      const cur = state.data[p.key];
      const ts = Math.max(event.time, (cur?.ts ?? 0) + 1);
      const next: MLState = {
        ...state,
        data: { ...state.data, [p.key]: { value: p.value, ts, origin: state.self } },
        history: [
          ...state.history,
          { type: 'ack', key: p.key, ts, origin: state.self, time: event.time },
        ],
      };
      return [
        next,
        [{ type: 'send', to: state.peer, payload: { rep: 'update', key: p.key, value: p.value, ts, origin: state.self } }],
      ];
    }
    if (event.kind === 'message' && p && 'rep' in p) {
      const cur = state.data[p.key];
      if (!cur || wins(p.ts, p.origin, cur.ts, cur.origin)) {
        return [
          { ...state, data: { ...state.data, [p.key]: { value: p.value, ts: p.ts, origin: p.origin } } },
          [],
        ];
      }
      if (cur.ts === p.ts && cur.origin === p.origin) return [state, []]; // duplicate delivery
      return [
        {
          ...state,
          history: [
            ...state.history,
            { type: 'discarded', key: p.key, value: p.value, ts: p.ts, origin: p.origin, time: event.time },
          ],
        },
        [],
      ];
    }
    return [state, []];
  },

  metrics(states, time) {
    let conflicts = 0;
    const acks: Extract<MLHistory, { type: 'ack' }>[] = [];
    for (const s of states.values()) {
      for (const h of s.history) {
        if (h.type === 'discarded') conflicts++;
        if (h.type === 'ack') acks.push(h);
      }
    }
    const [a, b] = [...states.values()];
    let divergent = 0;
    if (a && b) {
      const keys = new Set([...Object.keys(a.data), ...Object.keys(b.data)]);
      for (const k of keys) {
        const va = a.data[k];
        const vb = b.data[k];
        if (!va || !vb || va.ts !== vb.ts || va.origin !== vb.origin) divergent++;
      }
    }
    return [
      { name: 'conflicts-detected', value: conflicts },
      { name: 'acked-writes', value: acks.length },
      { name: 'divergent-keys', value: divergent },
      { name: 'writes-per-sec', value: acks.filter((x) => x.time > time - 1000).length },
    ];
  },

  inspect(state) {
    return {
      role: 'leader',
      data: state.data,
      discarded: state.history.filter((h) => h.type === 'discarded').length,
    } as InspectorTree;
  },
};
