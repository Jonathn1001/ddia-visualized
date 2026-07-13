import { describe, expect, test } from 'vitest';
import { Simulation, type NodeId } from '../engine';
import { API_TOPOLOGY, BYTES, N_POSTS } from './api-shared';
import { detectGrpcEvolution, grpc, grpcStats, REQUIRED_TAGS, serverSchema, V2_ADDED_TAG, type GrpcClient, type GrpcPayload, type GrpcServer, type GrpcState } from './grpc';

const TOPO = API_TOPOLOGY;
const rng = undefined as never;

function makeSim(seed: number) {
  return new Simulation<GrpcState, GrpcPayload>({ module: grpc, config: { nodeIds: TOPO }, seed, network: { latency: [1, 20] } });
}
function statesOf(sim: Simulation<GrpcState, GrpcPayload>): Map<NodeId, GrpcState> {
  return new Map(TOPO.map((id) => [id, sim.getState(id)] as const));
}

describe('reducers', () => {
  test('load sends one RPC', () => {
    const client: GrpcClient = { role: 'client', self: 'Client', started: false, expected: 0, delivered: 0, failed: false, live: {}, bytes: 0, roundTrips: 0, unknownSkipped: 0 };
    const [next, effects] = grpc.reduce(client, { kind: 'external', self: 'Client', time: 0, payload: { cmd: 'load' } }, rng);
    expect((next as GrpcClient).roundTrips).toBe(1);
    expect(effects.filter((e) => e.type === 'send')).toEqual([{ type: 'send', to: 'Server', payload: { msg: 'getProfile' } }]);
  });

  test('server ships v1 tags by default and v2 tags after a schema bump', () => {
    const srv: GrpcServer = { role: 'server', self: 'Server', schema: 'v1' };
    const [, v1] = grpc.reduce(srv, { kind: 'message', self: 'Server', from: 'Client', time: 1, payload: { msg: 'getProfile' } }, rng);
    expect(v1[0]).toMatchObject({ payload: { tags: REQUIRED_TAGS } });
    const [bumped] = grpc.reduce(srv, { kind: 'external', self: 'Server', time: 1, payload: { cmd: 'setSchema', version: 'v2' } }, rng);
    const [, v2] = grpc.reduce(bumped, { kind: 'message', self: 'Server', from: 'Client', time: 2, payload: { msg: 'getProfile' } }, rng);
    expect((v2[0] as { payload: { tags: number[] } }).payload.tags).toContain(V2_ADDED_TAG);
  });

  test('client skips an unknown newer tag but still decodes required fields', () => {
    const client: GrpcClient = { role: 'client', self: 'Client', started: true, expected: 0, delivered: 0, failed: false, live: { rpc: true }, bytes: 0, roundTrips: 1, unknownSkipped: 0 };
    const [next] = grpc.reduce(
      client,
      { kind: 'message', self: 'Client', from: 'Server', time: 5, payload: { msg: 'profile', tags: [...REQUIRED_TAGS, V2_ADDED_TAG], postIds: ['p0', 'p1', 'p2'], bytes: BYTES.grpcProfile } },
      rng,
    );
    const c = next as GrpcClient;
    expect(c.failed).toBe(false);
    expect(c.delivered).toBe(3);
    expect(c.unknownSkipped).toBe(1);
  });

  test('a removed required field breaks the old client', () => {
    const client: GrpcClient = { role: 'client', self: 'Client', started: true, expected: 0, delivered: 0, failed: false, live: { rpc: true }, bytes: 0, roundTrips: 1, unknownSkipped: 0 };
    const [next] = grpc.reduce(
      client,
      { kind: 'message', self: 'Client', from: 'Server', time: 5, payload: { msg: 'profile', tags: [1, 2, 4], postIds: ['p0'], bytes: BYTES.grpcProfile } }, // tag 3 (email) removed
      rng,
    );
    expect((next as GrpcClient).failed).toBe(true);
  });
});

describe('flows', () => {
  test('happy path v1: one round trip, compact binary — fewer bytes than JSON', () => {
    const sim = makeSim(1);
    sim.runSteps(TOPO.length);
    sim.external('Client', { cmd: 'load' });
    sim.runUntil(5000);
    const st = grpcStats(statesOf(sim));
    expect(st.roundTrips).toBe(1);
    expect(st.delivered).toBe(N_POSTS);
    expect(st.bytes).toBe(BYTES.grpcProfile);
    expect(st.bytes).toBeLessThan(BYTES.gqlResult); // binary beats JSON
    expect(detectGrpcEvolution(statesOf(sim))).toBeNull(); // no unknown field yet
  });

  test('schema evolution: a v2 server adds a field, the v1 client still works', () => {
    const sim = makeSim(2);
    sim.runSteps(TOPO.length);
    sim.external('Server', { cmd: 'setSchema', version: 'v2' });
    sim.external('Client', { cmd: 'load' });
    sim.runUntil(5000);
    expect(serverSchema(statesOf(sim))).toBe('v2');
    const st = grpcStats(statesOf(sim));
    expect(st.delivered).toBe(N_POSTS); // backward compatible
    expect(st.failed).toBe(0);
    expect(detectGrpcEvolution(statesOf(sim))).not.toBeNull();
  });
});

describe('metrics + inspect', () => {
  test('metrics report round-trips, bytes, delivered, unknown-fields', () => {
    const sim = makeSim(1);
    sim.runSteps(TOPO.length);
    sim.external('Client', { cmd: 'load' });
    sim.runUntil(5000);
    const m = Object.fromEntries(grpc.metrics(statesOf(sim), sim.time).map((x) => [x.name, x.value]));
    expect(m['round-trips']).toBe(1);
    expect(m['delivered']).toBe(N_POSTS);
    expect(m['unknown-fields']).toBe(0);
  });

  test('inspect exposes client shape + server schema', () => {
    const sim = makeSim(1);
    sim.runSteps(TOPO.length);
    sim.external('Client', { cmd: 'load' });
    sim.runUntil(5000);
    const ci = grpc.inspect(sim.getState('Client')) as unknown as { role: string; delivered: number };
    expect(ci.role).toBe('client');
    const si = grpc.inspect(sim.getState('Server')) as unknown as { role: string; schema: string };
    expect(si.schema).toBe('v1');
  });
});
