import { describe, expect, test } from 'vitest';
import { Simulation, type NodeId } from '../engine';
import { BROKER_TOPOLOGY } from './brokers-shared';
import { kafkalog, kafkaTriple, type KafkaPayload, type KafkaState } from './kafkalog';
import { rabbitqueue, rabbitTriple, type RabbitConsumer, type RabbitPayload, type RabbitState } from './rabbitqueue';
import { redispubsub, redisTriple, type RedisPayload, type RedisState } from './redispubsub';

/**
 * Pinned lesson test (spec §8). One default crash scenario per broker, asserting
 * the SIGNATURE the lab exists to teach. If a future reducer edit flattens the
 * contrast — Kafka stops duplicating, Redis stops losing — one of these bites.
 * The three signatures must stay distinct:
 *   Kafka   dup > 0, lost = 0   (replay from a durable log)
 *   RabbitMQ redelivery, lost = 0 (requeue on missing ack; dup only if ack lost)
 *   Redis   dup = 0, lost > 0   (nothing stored, nothing to replay)
 */

const TOPO = BROKER_TOPOLOGY;

describe('signature triples — the contrast the lab teaches', () => {
  test('Kafka: crash inside the commit window replays → dup > 0, lost = 0', () => {
    const sim = new Simulation<KafkaState, KafkaPayload>({
      module: kafkalog,
      config: { nodeIds: TOPO },
      seed: 42,
      network: { latency: [1, 40] },
    });
    sim.runSteps(TOPO.length);
    for (let i = 0; i < 16; i++) sim.external('P', { cmd: 'produce', key: `m${i}` });
    let killed = false;
    for (let i = 0; i < 40000 && !killed; i++) {
      sim.step();
      const c1 = sim.getState('C1');
      const b = sim.getState('B');
      if (c1.role === 'consumer' && c1.processed.length >= 1 && b.role === 'broker' && b.committed.p0 === 0 && b.fetched.p0 < b.delivered.p0) {
        sim.control({ type: 'kill', node: 'C1' });
        killed = true;
      }
    }
    expect(killed).toBe(true);
    sim.runUntil(sim.time + 200000);
    const t = kafkaTriple(new Map<NodeId, KafkaState>(TOPO.map((id) => [id, sim.getState(id)])));
    expect(t.duplicates).toBeGreaterThan(0);
    expect(t.lost).toBe(0);
  });

  test('RabbitMQ: killing the holder before it acks → redelivery, lost = 0', () => {
    const sim = new Simulation<RabbitState, RabbitPayload>({
      module: rabbitqueue,
      config: { nodeIds: TOPO },
      seed: 42,
      network: { latency: [1, 40] },
    });
    sim.runSteps(TOPO.length);
    sim.external('P', { cmd: 'produce', key: 'm0' });
    let armed = false;
    for (let i = 0; i < 20000 && !armed; i++) {
      sim.step();
      const b = sim.getState('B');
      const c1 = sim.getState('C1');
      if (b.role === 'broker' && b.unacked['m0']?.consumer === 'C1' && c1.role === 'consumer' && c1.processed.length === 0) {
        sim.control({ type: 'kill', node: 'C1' });
        armed = true;
      }
    }
    expect(armed).toBe(true);
    sim.runUntil(sim.time + 50000);
    const states = new Map<NodeId, RabbitState>(TOPO.map((id) => [id, sim.getState(id)]));
    const t = rabbitTriple(states);
    const redelivered = (sim.getState('C2') as RabbitConsumer).redeliveredProcessed.length;
    expect(redelivered).toBeGreaterThanOrEqual(1); // the survivor processed a redelivered message
    expect(t.lost).toBe(0);
  });

  test('Redis: a subscriber dead across publishes → dup = 0, lost > 0', () => {
    const sim = new Simulation<RedisState, RedisPayload>({
      module: redispubsub,
      config: { nodeIds: TOPO },
      seed: 42,
      network: { latency: [1, 40] },
    });
    sim.runSteps(TOPO.length);
    sim.control({ type: 'kill', node: 'C1' });
    for (let i = 0; i < 12; i++) sim.external('P', { cmd: 'produce', key: `m${i}` });
    sim.runUntil(30000);
    sim.control({ type: 'revive', node: 'C1' });
    sim.runUntil(80000);
    const t = redisTriple(new Map<NodeId, RedisState>(TOPO.map((id) => [id, sim.getState(id)])));
    expect(t.duplicates).toBe(0);
    expect(t.lost).toBeGreaterThan(0);
  });
});
