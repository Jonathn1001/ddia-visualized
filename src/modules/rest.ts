import type { NodeId } from '../engine/events';
import type { Effect, InspectorTree, ModuleEvent, SimModule } from '../engine/module';
import { BYTES, CLIENT, POST_IDS, REQUEST_TIMEOUT, SERVER, type ApiStats } from './api-shared';

/**
 * REST resource-oriented dataflow (DDIA Ch4). To render a profile the client
 * fetches the user, learns its post ids, then fetches EACH post separately —
 * the N+1 problem: 1 + N round trips, a verbose JSON envelope per resource, and
 * one failure point per request. A dropped post request times out and the page
 * renders WITHOUT that post — partial results, not total failure. Pure and
 * deterministic (client-side timeouts via delayed self-messages; no RNG/clock).
 */

export interface RestClient {
  role: 'client';
  self: NodeId;
  started: boolean;
  gotUser: boolean;
  expected: number;
  delivered: number;
  failed: number;
  /** Requests sent but not yet resolved or timed out, keyed by 'user' or a postId. */
  live: Record<string, true>;
  bytes: number;
  roundTrips: number;
}
export interface RestServer {
  role: 'server';
  self: NodeId;
}
export type RestState = RestClient | RestServer;

export type RestPayload =
  | { cmd: 'load' }
  | { msg: 'getUser' }
  | { msg: 'user'; postIds: string[]; bytes: number }
  | { msg: 'getPost'; postId: string }
  | { msg: 'post'; postId: string; bytes: number }
  | { timer: 'timeout'; key: string }
  | null;

function armRequest(to: NodeId, payload: RestPayload, key: string): Effect[] {
  return [
    { type: 'send', to, payload },
    { type: 'timer', delay: REQUEST_TIMEOUT, payload: { timer: 'timeout', key } },
  ];
}

function reduceClient(s: RestClient, ev: ModuleEvent<RestPayload>): [RestState, Effect[]] {
  const p = ev.payload;
  if (ev.kind === 'external' && p && 'cmd' in p && p.cmd === 'load') {
    if (s.started) return [s, []];
    return [
      { ...s, started: true, roundTrips: 1, live: { user: true } },
      armRequest(SERVER, { msg: 'getUser' }, 'user'),
    ];
  }
  if (ev.kind === 'message' && p && 'msg' in p) {
    if (p.msg === 'user') {
      if (!s.live.user) return [s, []]; // late/duplicate after a timeout
      const live = { ...s.live };
      delete live.user;
      const effects: Effect[] = [];
      for (const postId of p.postIds) {
        live[postId] = true;
        effects.push(...armRequest(SERVER, { msg: 'getPost', postId }, postId));
      }
      return [
        { ...s, gotUser: true, expected: p.postIds.length, bytes: s.bytes + p.bytes, roundTrips: s.roundTrips + p.postIds.length, live },
        effects,
      ];
    }
    if (p.msg === 'post') {
      if (!s.live[p.postId]) return [s, []];
      const live = { ...s.live };
      delete live[p.postId];
      return [{ ...s, delivered: s.delivered + 1, bytes: s.bytes + p.bytes, live }, []];
    }
  }
  if (ev.kind === 'timer' && p && 'timer' in p && p.timer === 'timeout') {
    if (!s.live[p.key]) return [s, []]; // already resolved
    const live = { ...s.live };
    delete live[p.key];
    // 'user' timing out leaves gotUser false (nothing to fetch); a post timing out
    // is a failed post — the page will render without it.
    return [{ ...s, live, failed: p.key === 'user' ? s.failed : s.failed + 1 }, []];
  }
  return [s, []];
}

function reduceServer(s: RestServer, ev: ModuleEvent<RestPayload>): [RestState, Effect[]] {
  const p = ev.payload;
  if (ev.kind === 'message' && p && 'msg' in p && ev.from) {
    if (p.msg === 'getUser') {
      return [s, [{ type: 'send', to: ev.from, payload: { msg: 'user', postIds: POST_IDS, bytes: BYTES.restUser } }]];
    }
    if (p.msg === 'getPost') {
      return [s, [{ type: 'send', to: ev.from, payload: { msg: 'post', postId: p.postId, bytes: BYTES.restPost } }]];
    }
  }
  return [s, []];
}

export const rest: SimModule<RestState, RestPayload> = {
  id: 'rest-api',
  chaos: ['kill-node', 'delay', 'drop'],

  init(nodeId) {
    if (nodeId === CLIENT) {
      return { role: 'client', self: nodeId, started: false, gotUser: false, expected: 0, delivered: 0, failed: 0, live: {}, bytes: 0, roundTrips: 0 };
    }
    return { role: 'server', self: nodeId };
  },

  reduce(state, event): [RestState, Effect[]] {
    if (state.role === 'client') return reduceClient(state, event);
    return reduceServer(state, event);
  },

  metrics(states) {
    const t = restStats(states);
    return [
      { name: 'round-trips', value: t.roundTrips },
      { name: 'bytes', value: t.bytes },
      { name: 'delivered', value: t.delivered },
      { name: 'failed', value: t.failed },
    ];
  },

  inspect(state) {
    if (state.role === 'server') return { role: 'server' } as unknown as InspectorTree;
    return {
      role: 'client',
      started: state.started,
      gotUser: state.gotUser,
      expected: state.expected,
      delivered: state.delivered,
      failed: state.failed,
      roundTrips: state.roundTrips,
      bytes: state.bytes,
      live: Object.keys(state.live),
    } as unknown as InspectorTree;
  },
};

function clientOf(states: Map<NodeId, RestState>): RestClient | null {
  const c = states.get(CLIENT);
  return c && c.role === 'client' ? c : null;
}

export function restStats(states: Map<NodeId, RestState>): ApiStats {
  const c = clientOf(states);
  if (!c) return { roundTrips: 0, bytes: 0, delivered: 0, expected: 0, failed: 0, settled: false };
  return {
    roundTrips: c.roundTrips,
    bytes: c.bytes,
    delivered: c.delivered,
    expected: c.expected,
    failed: c.failed,
    settled: c.started && Object.keys(c.live).length === 0,
  };
}

/** Challenge win: the page settled with fewer posts than expected — partial, not total, failure. */
export function detectRestPartial(states: Map<NodeId, RestState>): { delivered: number; expected: number } | null {
  const c = clientOf(states);
  if (!c) return null;
  const settled = c.started && Object.keys(c.live).length === 0;
  return settled && c.gotUser && c.delivered < c.expected ? { delivered: c.delivered, expected: c.expected } : null;
}
