import { describe, expect, test } from 'vitest';
import { Simulation, type NodeId } from '../engine';
import { API_TOPOLOGY, BYTES, N_POSTS } from './api-shared';
import { detectRestPartial, rest, restStats, type RestClient, type RestPayload, type RestState } from './rest';

const TOPO = API_TOPOLOGY;
const rng = undefined as never;

function makeSim(seed: number) {
  return new Simulation<RestState, RestPayload>({ module: rest, config: { nodeIds: TOPO }, seed, network: { latency: [1, 20] } });
}
function statesOf(sim: Simulation<RestState, RestPayload>): Map<NodeId, RestState> {
  return new Map(TOPO.map((id) => [id, sim.getState(id)] as const));
}

describe('reducers', () => {
  test('load fires one getUser and arms a timeout', () => {
    const client: RestClient = { role: 'client', self: 'Client', started: false, gotUser: false, expected: 0, delivered: 0, failed: 0, live: {}, bytes: 0, roundTrips: 0 };
    const [next, effects] = rest.reduce(client, { kind: 'external', self: 'Client', time: 0, payload: { cmd: 'load' } }, rng);
    const c = next as RestClient;
    expect(c.started).toBe(true);
    expect(c.roundTrips).toBe(1);
    expect(effects).toContainEqual({ type: 'send', to: 'Server', payload: { msg: 'getUser' } });
    expect(effects.some((e) => e.type === 'timer')).toBe(true);
  });

  test('user response fans out one getPost per post id (the N+1)', () => {
    const client: RestClient = { role: 'client', self: 'Client', started: true, gotUser: false, expected: 0, delivered: 0, failed: 0, live: { user: true }, bytes: 0, roundTrips: 1 };
    const [next, effects] = rest.reduce(
      client,
      { kind: 'message', self: 'Client', from: 'Server', time: 5, payload: { msg: 'user', postIds: ['p0', 'p1', 'p2'], bytes: BYTES.restUser } },
      rng,
    );
    const c = next as RestClient;
    expect(c.gotUser).toBe(true);
    expect(c.expected).toBe(3);
    expect(c.roundTrips).toBe(4); // 1 user + 3 posts
    expect(effects.filter((e) => e.type === 'send')).toHaveLength(3);
  });

  test('server answers getUser with post ids and getPost with a post', () => {
    const [, ue] = rest.reduce({ role: 'server', self: 'Server' }, { kind: 'message', self: 'Server', from: 'Client', time: 1, payload: { msg: 'getUser' } }, rng);
    expect(ue[0]).toMatchObject({ type: 'send', to: 'Client', payload: { msg: 'user' } });
    const [, pe] = rest.reduce({ role: 'server', self: 'Server' }, { kind: 'message', self: 'Server', from: 'Client', time: 1, payload: { msg: 'getPost', postId: 'p1' } }, rng);
    expect(pe[0]).toMatchObject({ type: 'send', to: 'Client', payload: { msg: 'post', postId: 'p1' } });
  });
});

describe('flows', () => {
  test('happy path: 1 + N round trips, all posts delivered, verbose bytes', () => {
    const sim = makeSim(1);
    sim.runSteps(TOPO.length);
    sim.external('Client', { cmd: 'load' });
    sim.runUntil(5000);
    const st = restStats(statesOf(sim));
    expect(st.roundTrips).toBe(1 + N_POSTS);
    expect(st.delivered).toBe(N_POSTS);
    expect(st.failed).toBe(0);
    expect(st.settled).toBe(true);
    expect(st.bytes).toBe(BYTES.restUser + N_POSTS * BYTES.restPost);
    expect(detectRestPartial(statesOf(sim))).toBeNull();
  });

  test('a server that dies mid-fetch yields a PARTIAL page — some posts, not total failure', () => {
    const sim = makeSim(2);
    sim.runSteps(TOPO.length);
    sim.external('Client', { cmd: 'load' });
    let killed = false;
    for (let i = 0; i < 2000 && !killed; i++) {
      sim.step();
      const c = sim.getState('Client');
      if (c.role === 'client' && c.gotUser && Object.keys(c.live).length > 0) {
        sim.control({ type: 'kill', node: 'Server' });
        killed = true;
      }
    }
    expect(killed).toBe(true);
    sim.runUntil(sim.time + 3000); // let the post-request timeouts fire
    const st = restStats(statesOf(sim));
    expect(st.settled).toBe(true);
    expect(st.delivered).toBeLessThan(st.expected);
    expect(st.failed).toBeGreaterThan(0);
    expect(detectRestPartial(statesOf(sim))).not.toBeNull();
  });
});

describe('metrics + inspect', () => {
  test('metrics report round-trips, bytes, delivered, failed', () => {
    const sim = makeSim(1);
    sim.runSteps(TOPO.length);
    sim.external('Client', { cmd: 'load' });
    sim.runUntil(5000);
    const m = Object.fromEntries(rest.metrics(statesOf(sim), sim.time).map((x) => [x.name, x.value]));
    expect(m['round-trips']).toBe(1 + N_POSTS);
    expect(m['delivered']).toBe(N_POSTS);
    expect(m['failed']).toBe(0);
  });

  test('inspect exposes client shape + server role', () => {
    const sim = makeSim(1);
    sim.runSteps(TOPO.length);
    sim.external('Client', { cmd: 'load' });
    sim.runUntil(5000);
    const ci = rest.inspect(sim.getState('Client')) as unknown as { role: string; delivered: number };
    expect(ci.role).toBe('client');
    expect(ci.delivered).toBe(N_POSTS);
    expect((rest.inspect(sim.getState('Server')) as unknown as { role: string }).role).toBe('server');
  });
});
