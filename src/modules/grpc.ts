import type { NodeId } from '../engine/events';
import type { Effect, InspectorTree, ModuleEvent, SimModule } from '../engine/module';
import { BYTES, CLIENT, POST_IDS, REQUEST_TIMEOUT, SERVER, type ApiStats } from './api-shared';

/**
 * gRPC binary RPC dataflow (DDIA Ch4 — encoding & evolution). One RPC, one
 * compact protobuf message — far fewer bytes than JSON. Fields are identified by
 * NUMBER, not name, so a v2 server that ADDS a field (tag 5) is transparently
 * decoded by a v1 client, which skips the unknown tag: backward compatibility.
 * (Removing a required field would break the old client — a breaking change.)
 * Pure and deterministic.
 */

/** Field tags a v1 client requires: id, name, email, posts. */
export const REQUIRED_TAGS = [1, 2, 3, 4];
/** v2 adds tag 5 (avatarUrl). */
export const V2_ADDED_TAG = 5;

export interface GrpcClient {
  role: 'client';
  self: NodeId;
  started: boolean;
  expected: number;
  delivered: number;
  failed: boolean;
  live: Record<string, true>;
  bytes: number;
  roundTrips: number;
  /** Unknown (newer) field tags the client skipped — evidence of forward-safe decode. */
  unknownSkipped: number;
}
export interface GrpcServer {
  role: 'server';
  self: NodeId;
  schema: 'v1' | 'v2';
}
export type GrpcState = GrpcClient | GrpcServer;

export type GrpcPayload =
  | { cmd: 'load' }
  | { cmd: 'setSchema'; version: 'v1' | 'v2' }
  | { msg: 'getProfile' }
  | { msg: 'profile'; tags: number[]; postIds: string[]; bytes: number }
  | { timer: 'timeout'; key: string }
  | null;

function reduceClient(s: GrpcClient, ev: ModuleEvent<GrpcPayload>): [GrpcState, Effect[]] {
  const p = ev.payload;
  if (ev.kind === 'external' && p && 'cmd' in p && p.cmd === 'load') {
    if (s.started) return [s, []];
    return [
      { ...s, started: true, roundTrips: 1, live: { rpc: true } },
      [
        { type: 'send', to: SERVER, payload: { msg: 'getProfile' } },
        { type: 'timer', delay: REQUEST_TIMEOUT, payload: { timer: 'timeout', key: 'rpc' } },
      ],
    ];
  }
  if (ev.kind === 'message' && p && 'msg' in p && p.msg === 'profile') {
    if (!s.live.rpc) return [s, []];
    // Decode by field number: known tags are used, unknown (newer) tags skipped.
    const unknown = p.tags.filter((t) => !REQUIRED_TAGS.includes(t)).length;
    const missingRequired = REQUIRED_TAGS.some((t) => !p.tags.includes(t));
    if (missingRequired) {
      return [{ ...s, live: {}, failed: true, bytes: s.bytes + p.bytes, unknownSkipped: s.unknownSkipped + unknown }, []];
    }
    return [
      { ...s, live: {}, delivered: p.postIds.length, expected: p.postIds.length, bytes: s.bytes + p.bytes, unknownSkipped: s.unknownSkipped + unknown },
      [],
    ];
  }
  if (ev.kind === 'timer' && p && 'timer' in p && p.timer === 'timeout') {
    if (!s.live[p.key]) return [s, []];
    return [{ ...s, live: {}, failed: true }, []];
  }
  return [s, []];
}

function reduceServer(s: GrpcServer, ev: ModuleEvent<GrpcPayload>): [GrpcState, Effect[]] {
  const p = ev.payload;
  if (ev.kind === 'external' && p && 'cmd' in p && p.cmd === 'setSchema') {
    return [{ ...s, schema: p.version }, []];
  }
  if (ev.kind === 'message' && p && 'msg' in p && p.msg === 'getProfile' && ev.from) {
    const tags = s.schema === 'v2' ? [...REQUIRED_TAGS, V2_ADDED_TAG] : [...REQUIRED_TAGS];
    const bytes = s.schema === 'v2' ? BYTES.grpcProfile + 20 : BYTES.grpcProfile;
    return [s, [{ type: 'send', to: ev.from, payload: { msg: 'profile', tags, postIds: POST_IDS, bytes } }]];
  }
  return [s, []];
}

export const grpc: SimModule<GrpcState, GrpcPayload> = {
  id: 'grpc-api',
  chaos: ['kill-node', 'delay', 'drop'],

  init(nodeId) {
    if (nodeId === CLIENT) {
      return { role: 'client', self: nodeId, started: false, expected: 0, delivered: 0, failed: false, live: {}, bytes: 0, roundTrips: 0, unknownSkipped: 0 };
    }
    return { role: 'server', self: nodeId, schema: 'v1' };
  },

  reduce(state, event): [GrpcState, Effect[]] {
    if (state.role === 'client') return reduceClient(state, event);
    return reduceServer(state, event);
  },

  metrics(states) {
    const t = grpcStats(states);
    const c = clientOf(states);
    return [
      { name: 'round-trips', value: t.roundTrips },
      { name: 'bytes', value: t.bytes },
      { name: 'delivered', value: t.delivered },
      { name: 'unknown-fields', value: c ? c.unknownSkipped : 0 },
    ];
  },

  inspect(state) {
    if (state.role === 'server') return { role: 'server', schema: state.schema } as unknown as InspectorTree;
    return {
      role: 'client',
      started: state.started,
      expected: state.expected,
      delivered: state.delivered,
      failed: state.failed,
      roundTrips: state.roundTrips,
      bytes: state.bytes,
      unknownSkipped: state.unknownSkipped,
      live: Object.keys(state.live),
    } as unknown as InspectorTree;
  },
};

function clientOf(states: Map<NodeId, GrpcState>): GrpcClient | null {
  const c = states.get(CLIENT);
  return c && c.role === 'client' ? c : null;
}

/** The server's current schema version (for the UI toggle + debrief). */
export function serverSchema(states: Map<NodeId, GrpcState>): 'v1' | 'v2' {
  const srv = states.get(SERVER);
  return srv && srv.role === 'server' ? srv.schema : 'v1';
}

export function grpcStats(states: Map<NodeId, GrpcState>): ApiStats {
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

/**
 * Challenge win: the client completed against a server that sent an unknown
 * (newer) field, skipping it — backward compatibility from field-number tagging.
 */
export function detectGrpcEvolution(states: Map<NodeId, GrpcState>): { unknownSkipped: number } | null {
  const c = clientOf(states);
  if (!c) return null;
  const settled = c.started && Object.keys(c.live).length === 0;
  return settled && !c.failed && c.delivered === c.expected && c.expected > 0 && c.unknownSkipped >= 1
    ? { unknownSkipped: c.unknownSkipped }
    : null;
}
