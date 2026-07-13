import type { NodeId } from '../engine/events';
import type { Effect, InspectorTree, ModuleEvent, SimModule } from '../engine/module';
import { BYTES, CLIENT, N_POSTS, POST_IDS, REQUEST_TIMEOUT, SERVER, type ApiStats } from './api-shared';

/**
 * GraphQL single-endpoint dataflow (DDIA Ch4). The client sends ONE query
 * describing the whole shape; the server resolves it — internally fanning out
 * one resolver call per post (the N+1 is still there, just moved server-side) —
 * and returns ONE exact-shape document. One client round trip, no over-fetch.
 * But it is all-or-nothing: drop the single query and the WHOLE page fails,
 * where REST would have lost only one post. Pure and deterministic.
 */

export interface GqlClient {
  role: 'client';
  self: NodeId;
  started: boolean;
  expected: number;
  delivered: number;
  failed: boolean;
  live: Record<string, true>;
  bytes: number;
  roundTrips: number;
  resolverCalls: number; // the hidden server-side N+1
}
export interface GqlServer {
  role: 'server';
  self: NodeId;
}
export type GqlState = GqlClient | GqlServer;

export type GqlPayload =
  | { cmd: 'load' }
  | { msg: 'query' }
  | { msg: 'result'; postIds: string[]; resolverCalls: number; bytes: number }
  | { timer: 'timeout'; key: string }
  | null;

function reduceClient(s: GqlClient, ev: ModuleEvent<GqlPayload>): [GqlState, Effect[]] {
  const p = ev.payload;
  if (ev.kind === 'external' && p && 'cmd' in p && p.cmd === 'load') {
    if (s.started) return [s, []];
    return [
      { ...s, started: true, roundTrips: 1, live: { q: true } },
      [
        { type: 'send', to: SERVER, payload: { msg: 'query' } },
        { type: 'timer', delay: REQUEST_TIMEOUT, payload: { timer: 'timeout', key: 'q' } },
      ],
    ];
  }
  if (ev.kind === 'message' && p && 'msg' in p && p.msg === 'result') {
    if (!s.live.q) return [s, []];
    return [
      { ...s, live: {}, delivered: p.postIds.length, expected: p.postIds.length, bytes: s.bytes + p.bytes, resolverCalls: p.resolverCalls },
      [],
    ];
  }
  if (ev.kind === 'timer' && p && 'timer' in p && p.timer === 'timeout') {
    if (!s.live[p.key]) return [s, []];
    // The one query failed → the whole page fails (all-or-nothing).
    return [{ ...s, live: {}, failed: true }, []];
  }
  return [s, []];
}

function reduceServer(s: GqlServer, ev: ModuleEvent<GqlPayload>): [GqlState, Effect[]] {
  const p = ev.payload;
  if (ev.kind === 'message' && p && 'msg' in p && p.msg === 'query' && ev.from) {
    // Resolve the graph: one resolver for the user + one per post (the N+1).
    return [
      s,
      [{ type: 'send', to: ev.from, payload: { msg: 'result', postIds: POST_IDS, resolverCalls: 1 + N_POSTS, bytes: BYTES.gqlResult } }],
    ];
  }
  return [s, []];
}

export const graphql: SimModule<GqlState, GqlPayload> = {
  id: 'graphql-api',
  chaos: ['kill-node', 'delay', 'drop'],

  init(nodeId) {
    if (nodeId === CLIENT) {
      return { role: 'client', self: nodeId, started: false, expected: 0, delivered: 0, failed: false, live: {}, bytes: 0, roundTrips: 0, resolverCalls: 0 };
    }
    return { role: 'server', self: nodeId };
  },

  reduce(state, event): [GqlState, Effect[]] {
    if (state.role === 'client') return reduceClient(state, event);
    return reduceServer(state, event);
  },

  metrics(states) {
    const t = gqlStats(states);
    const c = clientOf(states);
    return [
      { name: 'round-trips', value: t.roundTrips },
      { name: 'bytes', value: t.bytes },
      { name: 'delivered', value: t.delivered },
      { name: 'resolver-calls', value: c ? c.resolverCalls : 0 },
    ];
  },

  inspect(state) {
    if (state.role === 'server') return { role: 'server' } as unknown as InspectorTree;
    return {
      role: 'client',
      started: state.started,
      expected: state.expected,
      delivered: state.delivered,
      failed: state.failed,
      roundTrips: state.roundTrips,
      bytes: state.bytes,
      resolverCalls: state.resolverCalls,
      live: Object.keys(state.live),
    } as unknown as InspectorTree;
  },
};

function clientOf(states: Map<NodeId, GqlState>): GqlClient | null {
  const c = states.get(CLIENT);
  return c && c.role === 'client' ? c : null;
}

export function gqlStats(states: Map<NodeId, GqlState>): ApiStats {
  const c = clientOf(states);
  if (!c) return { roundTrips: 0, bytes: 0, delivered: 0, expected: 0, failed: 0, settled: false };
  return {
    roundTrips: c.roundTrips,
    bytes: c.bytes,
    delivered: c.delivered,
    expected: c.expected,
    failed: c.failed ? 1 : 0,
    settled: c.started && Object.keys(c.live).length === 0,
  };
}

/** Challenge win: the single query failed, so the WHOLE page is gone (all-or-nothing). */
export function detectGqlAllOrNothing(states: Map<NodeId, GqlState>): { delivered: number } | null {
  const c = clientOf(states);
  if (!c) return null;
  const settled = c.started && Object.keys(c.live).length === 0;
  return settled && c.failed && c.delivered === 0 ? { delivered: c.delivered } : null;
}
