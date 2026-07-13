import { describe, expect, test } from 'vitest';
import { Simulation, type NodeId } from '../engine';
import { BROKER_TOPOLOGY } from './brokers-shared';
import {
  detectRedisLost,
  redispubsub,
  redisTriple,
  type RedisBroker,
  type RedisConsumer,
  type RedisPayload,
  type RedisState,
} from './redispubsub';

const TOPO = BROKER_TOPOLOGY;
const rng = undefined as never;

function makeSim(seed: number) {
  return new Simulation<RedisState, RedisPayload>({
    module: redispubsub,
    config: { nodeIds: TOPO },
    seed,
    network: { latency: [1, 40] },
  });
}
function statesOf(sim: Simulation<RedisState, RedisPayload>): Map<NodeId, RedisState> {
  return new Map(TOPO.map((id) => [id, sim.getState(id)] as const));
}

describe('reducers', () => {
  test('producer forwards produce as publish', () => {
    const [, effects] = redispubsub.reduce(
      { role: 'producer', self: 'P' },
      { kind: 'external', self: 'P', time: 0, payload: { cmd: 'produce', key: 'm0' } },
      rng,
    );
    expect(effects).toEqual([{ type: 'send', to: 'B', payload: { msg: 'publish', id: 'm0' } }]);
  });

  test('broker fans a publish out to BOTH subscribers and records the id', () => {
    const [next, effects] = redispubsub.reduce(
      { role: 'broker', self: 'B', published: [] },
      { kind: 'message', self: 'B', from: 'P', time: 1, payload: { msg: 'publish', id: 'm0' } },
      rng,
    );
    expect((next as RedisBroker).published).toEqual(['m0']);
    expect(effects).toEqual([
      { type: 'send', to: 'C1', payload: { msg: 'notify', id: 'm0' } },
      { type: 'send', to: 'C2', payload: { msg: 'notify', id: 'm0' } },
    ]);
  });

  test('consumer appends the notified id (fire-and-forget, no ack)', () => {
    const [next, effects] = redispubsub.reduce(
      { role: 'consumer', self: 'C1', processed: [] },
      { kind: 'message', self: 'C1', from: 'B', time: 5, payload: { msg: 'notify', id: 'm0' } },
      rng,
    );
    expect((next as RedisConsumer).processed).toEqual(['m0']);
    expect(effects).toEqual([]);
  });
});

function produce(sim: Simulation<RedisState, RedisPayload>, n: number, start = 0) {
  for (let i = 0; i < n; i++) sim.external('P', { cmd: 'produce', key: `m${start + i}` });
}

describe('drain scenarios (the lesson)', () => {
  test('no crash: both subscribers get every message — delivered=produced, dup=0, lost=0', () => {
    const sim = makeSim(3);
    sim.runSteps(TOPO.length);
    produce(sim, 12);
    sim.runUntil(50000);
    const t = redisTriple(statesOf(sim));
    expect(t.produced).toBe(12);
    expect(t.delivered).toBe(12);
    expect(t.duplicates).toBe(0);
    expect(t.lost).toBe(0);
    expect(detectRedisLost(statesOf(sim))).toBeNull();
  });

  test('a subscriber killed across a publish loses those messages forever', () => {
    const sim = makeSim(5);
    sim.runSteps(TOPO.length);
    sim.control({ type: 'kill', node: 'C1' });
    produce(sim, 12); // published while C1 is dead — dropped to C1, delivered to C2
    sim.runUntil(30000);
    sim.control({ type: 'revive', node: 'C1' }); // too late — nothing stored to replay
    sim.runUntil(80000);
    const states = statesOf(sim);
    const t = redisTriple(states);
    expect(t.duplicates).toBe(0);
    expect(t.lost).toBeGreaterThanOrEqual(1);
    expect(detectRedisLost(states)).not.toBeNull();
    // C2 (always live) still received everything.
    expect((sim.getState('C2') as RedisConsumer).processed.length).toBe(12);
  });
});

describe('metrics + inspect', () => {
  test('metrics report the triple', () => {
    const sim = makeSim(2);
    sim.runSteps(TOPO.length);
    produce(sim, 8);
    sim.runUntil(50000);
    const m = Object.fromEntries(redispubsub.metrics(statesOf(sim), sim.time).map((x) => [x.name, x.value]));
    expect(m['produced']).toBe(8);
    expect(m['duplicates']).toBe(0);
    expect(m['lost']).toBe(0);
  });

  test('inspect exposes broker published + consumer processed', () => {
    const sim = makeSim(2);
    sim.runSteps(TOPO.length);
    produce(sim, 4);
    sim.runUntil(50000);
    const bi = redispubsub.inspect(sim.getState('B')) as unknown as { role: string; published: string[] };
    expect(bi.role).toBe('broker');
    expect(bi.published).toHaveLength(4);
    const ci = redispubsub.inspect(sim.getState('C2')) as unknown as { role: string; processed: string[] };
    expect(ci.role).toBe('consumer');
  });
});
