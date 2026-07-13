import { describe, expect, test } from 'vitest';
import { Simulation, type NodeId } from '../engine';
import { BROKER_TOPOLOGY } from './brokers-shared';
import {
  COMMIT_EVERY,
  detectKafkaDup,
  kafkalog,
  kafkaTriple,
  partitionOf,
  type KafkaBroker,
  type KafkaConsumer,
  type KafkaPayload,
  type KafkaState,
} from './kafkalog';

const TOPO = BROKER_TOPOLOGY;

function makeSim(seed: number) {
  return new Simulation<KafkaState, KafkaPayload>({
    module: kafkalog,
    config: { nodeIds: TOPO },
    seed,
    network: { latency: [1, 40] },
  });
}

function statesOf(sim: Simulation<KafkaState, KafkaPayload>): Map<NodeId, KafkaState> {
  return new Map(TOPO.map((id) => [id, sim.getState(id)] as const));
}

const rng = undefined as never; // module ignores rng

function freshBroker(): KafkaBroker {
  return {
    role: 'broker',
    self: 'B',
    partitions: { p0: [], p1: [] },
    assignment: { p0: 'C1', p1: 'C2' },
    delivered: { p0: 0, p1: 0 },
    fetched: { p0: 0, p1: 0 },
    committed: { p0: 0, p1: 0 },
    sinceCommit: { p0: 0, p1: 0 },
    stalled: { p0: false, p1: false },
  };
}

describe('init + topology', () => {
  test('broker starts with p0→C1, p1→C2 and empty logs', () => {
    const sim = makeSim(1);
    sim.runSteps(TOPO.length);
    const b = sim.getState('B') as KafkaBroker;
    expect(b.role).toBe('broker');
    expect(b.assignment).toEqual({ p0: 'C1', p1: 'C2' });
    expect(b.partitions).toEqual({ p0: [], p1: [] });
    expect((sim.getState('C1') as KafkaConsumer).processed).toEqual([]);
    expect(sim.getState('P').role).toBe('producer');
  });
});

describe('producer + consumer reducers', () => {
  test('producer forwards produce{key} as publish{id} to the broker', () => {
    const [, effects] = kafkalog.reduce(
      { role: 'producer', self: 'P' },
      { kind: 'external', self: 'P', time: 0, payload: { cmd: 'produce', key: 'm0' } },
      rng,
    );
    expect(effects).toEqual([{ type: 'send', to: 'B', payload: { msg: 'publish', id: 'm0' } }]);
  });

  test('consumer appends the delivered id and acks fetched', () => {
    const [next, effects] = kafkalog.reduce(
      { role: 'consumer', self: 'C1', processed: [] },
      { kind: 'message', self: 'C1', from: 'B', time: 5, payload: { msg: 'deliver', p: 'p0', offset: 0, id: 'm0' } },
      rng,
    );
    expect((next as KafkaConsumer).processed).toEqual(['m0']);
    expect(effects).toEqual([{ type: 'send', to: 'B', payload: { msg: 'fetched', p: 'p0', offset: 0 } }]);
  });
});

describe('broker reducer', () => {
  test('publish appends to the hashed partition and delivers to its assignee', () => {
    const id = 'm0';
    const part = partitionOf(id);
    const [next, effects] = kafkalog.reduce(
      freshBroker(),
      { kind: 'message', self: 'B', from: 'P', time: 1, payload: { msg: 'publish', id } },
      rng,
    );
    const b = next as KafkaBroker;
    expect(b.partitions[part]).toEqual([id]);
    expect(b.delivered[part]).toBe(1);
    const assignee = part === 'p0' ? 'C1' : 'C2';
    expect(effects).toContainEqual({ type: 'send', to: assignee, payload: { msg: 'deliver', p: part, offset: 0, id } });
    expect(effects.some((e) => e.type === 'timer')).toBe(true);
  });

  test('fetched advances the fetch pointer and auto-commits every COMMIT_EVERY acks', () => {
    let b = freshBroker();
    b = { ...b, partitions: { p0: ['a', 'b', 'c'], p1: [] }, delivered: { p0: 3, p1: 0 } };
    for (let offset = 0; offset < COMMIT_EVERY; offset++) {
      const [next] = kafkalog.reduce(
        b,
        { kind: 'message', self: 'B', from: 'C1', time: 10 + offset, payload: { msg: 'fetched', p: 'p0', offset } },
        rng,
      );
      b = next as KafkaBroker;
    }
    expect(b.fetched.p0).toBe(3);
    expect(b.committed.p0).toBe(3); // committed caught up after COMMIT_EVERY acks
    expect(b.sinceCommit.p0).toBe(0);
  });

  test('fetched from a de-assigned consumer is ignored', () => {
    const b = { ...freshBroker(), assignment: { p0: 'C2' as NodeId, p1: 'C2' as NodeId } };
    const [next] = kafkalog.reduce(
      b,
      { kind: 'message', self: 'B', from: 'C1', time: 5, payload: { msg: 'fetched', p: 'p0', offset: 0 } },
      rng,
    );
    expect((next as KafkaBroker).fetched.p0).toBe(0);
  });

  test('sessionCheck reassigns to the survivor and replays from committed when an offset is unfetched', () => {
    const b: KafkaBroker = {
      ...freshBroker(),
      partitions: { p0: ['a', 'b', 'c'], p1: [] },
      delivered: { p0: 3, p1: 0 },
      fetched: { p0: 1, p1: 0 }, // only offset 0 acked
      committed: { p0: 0, p1: 0 },
    };
    const [next, effects] = kafkalog.reduce(
      b,
      { kind: 'timer', self: 'B', time: 400, payload: { timer: 'sessionCheck', p: 'p0', offset: 2 } },
      rng,
    );
    const nb = next as KafkaBroker;
    expect(nb.assignment.p0).toBe('C2'); // reassigned away from C1
    expect(nb.stalled.p0).toBe(true);
    expect(nb.fetched.p0).toBe(0); // reset to committed for the new assignee
    // replay offsets 0,1,2 to C2 (each with a sessionCheck timer)
    const replays = effects.filter((e) => e.type === 'send');
    expect(replays).toEqual([
      { type: 'send', to: 'C2', payload: { msg: 'deliver', p: 'p0', offset: 0, id: 'a' } },
      { type: 'send', to: 'C2', payload: { msg: 'deliver', p: 'p0', offset: 1, id: 'b' } },
      { type: 'send', to: 'C2', payload: { msg: 'deliver', p: 'p0', offset: 2, id: 'c' } },
    ]);
  });

  test('sessionCheck is a no-op when the offset was already fetched', () => {
    const b: KafkaBroker = { ...freshBroker(), fetched: { p0: 3, p1: 0 } };
    const [next, effects] = kafkalog.reduce(
      b,
      { kind: 'timer', self: 'B', time: 400, payload: { timer: 'sessionCheck', p: 'p0', offset: 0 } },
      rng,
    );
    expect(next).toBe(b);
    expect(effects).toEqual([]);
  });

  test('sessionCheck is a no-op while the partition is already stalled', () => {
    const b: KafkaBroker = { ...freshBroker(), stalled: { p0: true, p1: false }, delivered: { p0: 2, p1: 0 } };
    const [, effects] = kafkalog.reduce(
      b,
      { kind: 'timer', self: 'B', time: 400, payload: { timer: 'sessionCheck', p: 'p0', offset: 1 } },
      rng,
    );
    expect(effects).toEqual([]);
  });
});

/** Produce m0..m(n-1) at the current time. */
function produce(sim: Simulation<KafkaState, KafkaPayload>, n: number) {
  for (let i = 0; i < n; i++) sim.external('P', { cmd: 'produce', key: `m${i}` });
}

describe('drain scenarios (the lesson)', () => {
  test('no crash: every produced id delivered exactly once — dup=0, lost=0', () => {
    const sim = makeSim(7);
    sim.runSteps(TOPO.length);
    produce(sim, 12);
    sim.runUntil(50000);
    const t = kafkaTriple(statesOf(sim));
    expect(t.produced).toBe(12);
    expect(t.delivered).toBe(12);
    expect(t.duplicates).toBe(0);
    expect(t.lost).toBe(0);
    expect(detectKafkaDup(statesOf(sim))).toBeNull();
  });

  test('crash inside the auto-commit window: replay produces duplicates, nothing lost', () => {
    const sim = makeSim(9);
    sim.runSteps(TOPO.length);
    produce(sim, 16);
    // Step until C1 has processed at least one p0 offset uncommitted, with an
    // unfetched offset still outstanding — the crash window — then kill C1.
    let killed = false;
    for (let i = 0; i < 40000 && !killed; i++) {
      sim.step();
      const c1 = sim.getState('C1');
      const b = sim.getState('B');
      if (
        c1.role === 'consumer' &&
        c1.processed.length >= 1 &&
        b.role === 'broker' &&
        b.committed.p0 === 0 &&
        b.fetched.p0 < b.delivered.p0
      ) {
        sim.control({ type: 'kill', node: 'C1' });
        killed = true;
      }
    }
    expect(killed).toBe(true);
    sim.runUntil(sim.time + 200000);
    const t = kafkaTriple(statesOf(sim));
    expect(t.duplicates).toBeGreaterThanOrEqual(1);
    expect(t.lost).toBe(0);
    expect(detectKafkaDup(statesOf(sim))).not.toBeNull();
  });
});

describe('metrics + inspect', () => {
  test('metrics report the triple + committed', () => {
    const sim = makeSim(3);
    sim.runSteps(TOPO.length);
    produce(sim, 12);
    sim.runUntil(50000);
    const m = Object.fromEntries(kafkalog.metrics(statesOf(sim), sim.time).map((x) => [x.name, x.value]));
    expect(m['produced']).toBe(12);
    expect(m['delivered']).toBe(12);
    expect(m['lost']).toBe(0);
    expect(m['committed']).toBeGreaterThan(0);
  });

  test('inspect exposes broker lanes and consumer processed lists', () => {
    const sim = makeSim(3);
    sim.runSteps(TOPO.length);
    produce(sim, 6);
    sim.runUntil(50000);
    const bi = kafkalog.inspect(sim.getState('B')) as unknown as { role: string; partitions: { p0: string[]; p1: string[] } };
    expect(bi.role).toBe('broker');
    expect(bi.partitions.p0.length + bi.partitions.p1.length).toBe(6);
    const ci = kafkalog.inspect(sim.getState('C1')) as unknown as { role: string; processed: string[] };
    expect(ci.role).toBe('consumer');
  });
});
