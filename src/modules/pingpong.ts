import type { NodeId } from '../engine/events';
import type { Effect, InspectorTree, SimModule } from '../engine/module';

/**
 * Token ring with retransmission — the Phase 0 engine demo (DESIGN_PLAN §7).
 * Node 0 starts token 1; each node delivers a token once (dedupe by number),
 * forwards token+1, and retransmits its last send every RETRANSMIT_MS until
 * a higher token comes back around the ring.
 */
export interface PPState {
  self: NodeId;
  next: NodeId;
  starter: boolean;
  /** Highest token this node has processed. */
  lastDelivered: number;
  /** Token sent but not yet confirmed by ring progress. */
  pendingToken: number | null;
}

export type PPPayload = { token: number } | { retransmit: number } | null;

const RETRANSMIT_MS = 50;

function sendToken(state: PPState, token: number): [PPState, Effect[]] {
  return [
    { ...state, pendingToken: token },
    [
      { type: 'send', to: state.next, payload: { token } },
      { type: 'timer', delay: RETRANSMIT_MS, payload: { retransmit: token } },
    ],
  ];
}

export const pingPong: SimModule<PPState, PPPayload> = {
  id: 'ping-pong',
  chaos: ['kill-node', 'partition', 'delay', 'drop', 'duplicate'],

  init(nodeId, config) {
    const ids = config.nodeIds;
    const i = ids.indexOf(nodeId);
    return {
      self: nodeId,
      next: ids[(i + 1) % ids.length],
      starter: i === 0,
      lastDelivered: 0,
      pendingToken: null,
    };
  },

  reduce(state, event): [PPState, Effect[]] {
    switch (event.kind) {
      case 'init': {
        if (!state.starter) return [state, []];
        return sendToken(state, 1);
      }
      case 'message': {
        const { token } = event.payload as { token: number };
        if (token <= state.lastDelivered) return [state, []]; // duplicate or stale
        const cleared =
          state.pendingToken !== null && token > state.pendingToken
            ? { ...state, pendingToken: null }
            : state;
        return sendToken({ ...cleared, lastDelivered: token }, token + 1);
      }
      case 'timer': {
        const { retransmit } = event.payload as { retransmit: number };
        if (state.pendingToken !== retransmit) return [state, []]; // superseded
        return [
          state,
          [
            { type: 'send', to: state.next, payload: { token: retransmit } },
            { type: 'timer', delay: RETRANSMIT_MS, payload: { retransmit } },
          ],
        ];
      }
      default:
        return [state, []];
    }
  },

  metrics(states) {
    let max = 0;
    let sum = 0;
    for (const s of states.values()) {
      max = Math.max(max, s.lastDelivered);
      sum += s.lastDelivered;
    }
    return [
      { name: 'max-token', value: max },
      { name: 'total-delivered', value: sum },
    ];
  },

  inspect(state) {
    return { ...state } as InspectorTree;
  },
};
