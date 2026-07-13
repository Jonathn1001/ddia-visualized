import { describe, expect, test } from 'vitest';
import { Simulation, type NodeId } from '../engine';
import { API_TOPOLOGY, BYTES, N_POSTS } from './api-shared';
import { detectGqlAllOrNothing, gqlStats, graphql, type GqlClient, type GqlPayload, type GqlState } from './graphql';

const TOPO = API_TOPOLOGY;
const rng = undefined as never;

function makeSim(seed: number) {
  return new Simulation<GqlState, GqlPayload>({ module: graphql, config: { nodeIds: TOPO }, seed, network: { latency: [1, 20] } });
}
function statesOf(sim: Simulation<GqlState, GqlPayload>): Map<NodeId, GqlState> {
  return new Map(TOPO.map((id) => [id, sim.getState(id)] as const));
}

describe('reducers', () => {
  test('load sends exactly one query', () => {
    const client: GqlClient = { role: 'client', self: 'Client', started: false, expected: 0, delivered: 0, failed: false, live: {}, bytes: 0, roundTrips: 0, resolverCalls: 0 };
    const [next, effects] = graphql.reduce(client, { kind: 'external', self: 'Client', time: 0, payload: { cmd: 'load' } }, rng);
    expect((next as GqlClient).roundTrips).toBe(1);
    expect(effects.filter((e) => e.type === 'send')).toEqual([{ type: 'send', to: 'Server', payload: { msg: 'query' } }]);
  });

  test('server resolves the graph in one response, reporting its hidden N+1', () => {
    const [, effects] = graphql.reduce({ role: 'server', self: 'Server' }, { kind: 'message', self: 'Server', from: 'Client', time: 1, payload: { msg: 'query' } }, rng);
    expect(effects[0]).toMatchObject({ type: 'send', to: 'Client', payload: { msg: 'result', resolverCalls: 1 + N_POSTS } });
  });
});

describe('flows', () => {
  test('happy path: ONE round trip, exact shape, hidden server-side N+1', () => {
    const sim = makeSim(1);
    sim.runSteps(TOPO.length);
    sim.external('Client', { cmd: 'load' });
    sim.runUntil(5000);
    const st = gqlStats(statesOf(sim));
    expect(st.roundTrips).toBe(1); // one client↔server round trip
    expect(st.delivered).toBe(N_POSTS);
    expect(st.bytes).toBe(BYTES.gqlResult);
    const c = sim.getState('Client') as GqlClient;
    expect(c.resolverCalls).toBe(1 + N_POSTS); // the N+1 moved server-side
    expect(detectGqlAllOrNothing(statesOf(sim))).toBeNull();
  });

  test('drop the single query and the WHOLE page fails (all-or-nothing)', () => {
    const sim = makeSim(3);
    sim.runSteps(TOPO.length);
    sim.control({ type: 'kill', node: 'Server' }); // the query will never be answered
    sim.external('Client', { cmd: 'load' });
    sim.runUntil(5000); // the query timeout fires
    const st = gqlStats(statesOf(sim));
    expect(st.settled).toBe(true);
    expect(st.delivered).toBe(0);
    expect(st.failed).toBe(1);
    expect(detectGqlAllOrNothing(statesOf(sim))).not.toBeNull();
  });
});

describe('metrics + inspect', () => {
  test('metrics report round-trips, bytes, delivered, resolver-calls', () => {
    const sim = makeSim(1);
    sim.runSteps(TOPO.length);
    sim.external('Client', { cmd: 'load' });
    sim.runUntil(5000);
    const m = Object.fromEntries(graphql.metrics(statesOf(sim), sim.time).map((x) => [x.name, x.value]));
    expect(m['round-trips']).toBe(1);
    expect(m['delivered']).toBe(N_POSTS);
    expect(m['resolver-calls']).toBe(1 + N_POSTS);
  });

  test('inspect exposes client shape + server role', () => {
    const sim = makeSim(1);
    sim.runSteps(TOPO.length);
    sim.external('Client', { cmd: 'load' });
    sim.runUntil(5000);
    const ci = graphql.inspect(sim.getState('Client')) as unknown as { role: string; delivered: number };
    expect(ci.role).toBe('client');
    expect(ci.delivered).toBe(N_POSTS);
    expect((graphql.inspect(sim.getState('Server')) as unknown as { role: string }).role).toBe('server');
  });
});
