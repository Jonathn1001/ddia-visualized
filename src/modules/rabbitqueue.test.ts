import { describe, expect, test } from 'vitest';
import { Simulation, type NodeId } from '../engine';
import { BROKER_TOPOLOGY } from './brokers-shared';
import {
  DELIVERY_LIMIT,
  detectRabbitRedelivery,
  rabbitqueue,
  rabbitTriple,
  type RabbitBroker,
  type RabbitConsumer,
  type RabbitPayload,
  type RabbitState,
} from './rabbitqueue';

const TOPO = BROKER_TOPOLOGY;
const rng = undefined as never;

function makeSim(seed: number) {
  return new Simulation<RabbitState, RabbitPayload>({
    module: rabbitqueue,
    config: { nodeIds: TOPO },
    seed,
    network: { latency: [1, 40] },
  });
}
function statesOf(sim: Simulation<RabbitState, RabbitPayload>): Map<NodeId, RabbitState> {
  return new Map(TOPO.map((id) => [id, sim.getState(id)] as const));
}
function freshBroker(): RabbitBroker {
  return { role: 'broker', self: 'B', unacked: {}, deadLetter: [], redeliveries: 0, rr: 0, delivery: {}, produced: [] };
}

describe('producer + consumer reducers', () => {
  test('producer forwards produce as publish', () => {
    const [, effects] = rabbitqueue.reduce(
      { role: 'producer', self: 'P' },
      { kind: 'external', self: 'P', time: 0, payload: { cmd: 'produce', key: 'm0' } },
      rng,
    );
    expect(effects).toEqual([{ type: 'send', to: 'B', payload: { msg: 'publish', id: 'm0' } }]);
  });

  test('consumer processes + acks; a redelivered flag is recorded', () => {
    const [next, effects] = rabbitqueue.reduce(
      { role: 'consumer', self: 'C2', processed: [], redeliveredProcessed: [] },
      { kind: 'message', self: 'C2', from: 'B', time: 5, payload: { msg: 'deliver', id: 'm0', redelivered: true } },
      rng,
    );
    const c = next as RabbitConsumer;
    expect(c.processed).toEqual(['m0']);
    expect(c.redeliveredProcessed).toEqual(['m0']);
    expect(effects).toEqual([{ type: 'send', to: 'B', payload: { msg: 'ack', id: 'm0' } }]);
  });
});

describe('broker reducer', () => {
  test('publish enqueues, records produced, and round-robin delivers to C1 first', () => {
    const [next, effects] = rabbitqueue.reduce(
      freshBroker(),
      { kind: 'message', self: 'B', from: 'P', time: 1, payload: { msg: 'publish', id: 'm0' } },
      rng,
    );
    const b = next as RabbitBroker;
    expect(b.produced).toEqual(['m0']);
    expect(b.unacked['m0']).toEqual({ consumer: 'C1', redelivered: false });
    expect(b.rr).toBe(1); // pointer advanced
    expect(effects).toContainEqual({ type: 'send', to: 'C1', payload: { msg: 'deliver', id: 'm0', redelivered: false } });
  });

  test('ack destructively removes the message from unacked', () => {
    const b = { ...freshBroker(), unacked: { m0: { consumer: 'C1' as NodeId, redelivered: false } } };
    const [next] = rabbitqueue.reduce(
      b,
      { kind: 'message', self: 'B', from: 'C1', time: 5, payload: { msg: 'ack', id: 'm0' } },
      rng,
    );
    expect((next as RabbitBroker).unacked).toEqual({});
  });

  test('checkAck on an unacked message requeues it to the other consumer, flagged redelivered', () => {
    const b = { ...freshBroker(), unacked: { m0: { consumer: 'C1' as NodeId, redelivered: false } } };
    const [next, effects] = rabbitqueue.reduce(
      b,
      { kind: 'timer', self: 'B', time: 400, payload: { timer: 'checkAck', id: 'm0' } },
      rng,
    );
    const nb = next as RabbitBroker;
    expect(nb.redeliveries).toBe(1);
    expect(nb.unacked['m0']).toEqual({ consumer: 'C2', redelivered: true });
    expect(effects).toContainEqual({ type: 'send', to: 'C2', payload: { msg: 'deliver', id: 'm0', redelivered: true } });
  });

  test('checkAck is a no-op once the message has been acked', () => {
    const [next, effects] = rabbitqueue.reduce(
      freshBroker(),
      { kind: 'timer', self: 'B', time: 400, payload: { timer: 'checkAck', id: 'gone' } },
      rng,
    );
    expect((next as RabbitBroker).redeliveries).toBe(0);
    expect(effects).toEqual([]);
  });

  test('checkAck dead-letters a message after the delivery limit instead of looping forever', () => {
    const b: RabbitBroker = {
      ...freshBroker(),
      unacked: { m0: { consumer: 'C1', redelivered: true } },
      delivery: { m0: DELIVERY_LIMIT - 1 },
    };
    const [next, effects] = rabbitqueue.reduce(
      b,
      { kind: 'timer', self: 'B', time: 400, payload: { timer: 'checkAck', id: 'm0' } },
      rng,
    );
    const nb = next as RabbitBroker;
    expect(nb.deadLetter).toEqual(['m0']);
    expect(nb.unacked['m0']).toBeUndefined();
    expect(effects).toEqual([]); // parked — no further redelivery
  });
});

function produce(sim: Simulation<RabbitState, RabbitPayload>, n: number) {
  for (let i = 0; i < n; i++) sim.external('P', { cmd: 'produce', key: `m${i}` });
}

describe('drain scenarios (the lesson)', () => {
  test('no crash: each id delivered and acked once — delivered=produced, dup=0, lost=0', () => {
    const sim = makeSim(4);
    sim.runSteps(TOPO.length);
    produce(sim, 8);
    sim.runUntil(50000);
    const t = rabbitTriple(statesOf(sim));
    expect(t.produced).toBe(8);
    expect(t.delivered).toBe(8);
    expect(t.duplicates).toBe(0);
    expect(t.lost).toBe(0);
  });

  test('killing the holder before it can process requeues to the survivor — redelivery, nothing lost', () => {
    const sim = makeSim(6);
    sim.runSteps(TOPO.length);
    sim.external('P', { cmd: 'produce', key: 'm0' }); // rr=0 → dispatched to C1
    // Kill C1 while it holds m0 unacked but before it has processed the deliver.
    let armed = false;
    for (let i = 0; i < 20000 && !armed; i++) {
      sim.step();
      const b = sim.getState('B');
      const c1 = sim.getState('C1');
      if (
        b.role === 'broker' &&
        b.unacked['m0']?.consumer === 'C1' &&
        c1.role === 'consumer' &&
        c1.processed.length === 0
      ) {
        sim.control({ type: 'kill', node: 'C1' });
        armed = true;
      }
    }
    expect(armed).toBe(true);
    sim.runUntil(sim.time + 50000);
    const states = statesOf(sim);
    const t = rabbitTriple(states);
    expect(t.lost).toBe(0);
    expect(detectRabbitRedelivery(states)).not.toBeNull();
    expect((sim.getState('C2') as RabbitConsumer).processed).toContain('m0');
  });
});

describe('metrics + inspect', () => {
  test('metrics report the triple + unacked/redeliveries/dead-letter', () => {
    const sim = makeSim(2);
    sim.runSteps(TOPO.length);
    produce(sim, 6);
    sim.runUntil(50000);
    const m = Object.fromEntries(rabbitqueue.metrics(statesOf(sim), sim.time).map((x) => [x.name, x.value]));
    expect(m['produced']).toBe(6);
    expect(m['delivered']).toBe(6);
    expect(m['unacked']).toBe(0);
    expect(m['dead-letter']).toBe(0);
  });

  test('inspect exposes broker unacked + consumer processed', () => {
    const sim = makeSim(2);
    sim.runSteps(TOPO.length);
    produce(sim, 4);
    sim.runUntil(50000);
    const bi = rabbitqueue.inspect(sim.getState('B')) as unknown as { role: string; unacked: Record<string, unknown> };
    expect(bi.role).toBe('broker');
    const ci = rabbitqueue.inspect(sim.getState('C1')) as unknown as { role: string; processed: string[] };
    expect(ci.role).toBe('consumer');
  });
});
