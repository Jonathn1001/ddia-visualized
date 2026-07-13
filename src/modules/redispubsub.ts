import type { NodeId } from '../engine/events';
import type { Effect, InspectorTree, ModuleEvent, SimModule } from '../engine/module';
import { BROKER, CONSUMERS, type Triple } from './brokers-shared';

/**
 * Redis pub/sub fan-out (DDIA Ch11). The broker stores nothing but a list of
 * published ids (for the lost metric) and pushes every message to EVERY live
 * subscriber — fan-out, not competing consumers. No ack, no timer, no replay. A
 * dead subscriber's message is gone forever; a revived subscriber sees only
 * future publishes. At-most-once — and at-most-once is a *storage* decision, not
 * a delivery bug. Pure and deterministic (no RNG, no wall clock).
 */

export interface RedisBroker {
  role: 'broker';
  self: NodeId;
  /** Ids only — no message body is ever stored. */
  published: string[];
}
export interface RedisConsumer {
  role: 'consumer';
  self: NodeId;
  processed: string[];
}
export interface RedisProducer {
  role: 'producer';
  self: NodeId;
}
export type RedisState = RedisBroker | RedisConsumer | RedisProducer;

export type RedisPayload =
  | { cmd: 'produce'; key: string }
  | { msg: 'publish'; id: string }
  | { msg: 'notify'; id: string }
  | null;

function reduceBroker(s: RedisBroker, ev: ModuleEvent<RedisPayload>): [RedisState, Effect[]] {
  const p = ev.payload;
  if (ev.kind === 'message' && p && 'msg' in p && p.msg === 'publish') {
    // Fan-out: every subscriber gets every message (vs competing consumers).
    const effects: Effect[] = CONSUMERS.map((c) => ({ type: 'send', to: c, payload: { msg: 'notify', id: p.id } }));
    return [{ ...s, published: [...s.published, p.id] }, effects];
  }
  return [s, []];
}

function reduceConsumer(s: RedisConsumer, ev: ModuleEvent<RedisPayload>): [RedisState, Effect[]] {
  const p = ev.payload;
  if (ev.kind === 'message' && p && 'msg' in p && p.msg === 'notify') {
    return [{ ...s, processed: [...s.processed, p.id] }, []];
  }
  return [s, []];
}

function reduceProducer(s: RedisProducer, ev: ModuleEvent<RedisPayload>): [RedisState, Effect[]] {
  const p = ev.payload;
  if (ev.kind === 'external' && p && 'cmd' in p && p.cmd === 'produce') {
    return [s, [{ type: 'send', to: BROKER, payload: { msg: 'publish', id: p.key } }]];
  }
  return [s, []];
}

export const redispubsub: SimModule<RedisState, RedisPayload> = {
  id: 'redis-pubsub',
  chaos: ['kill-node', 'delay', 'drop'],

  init(nodeId) {
    if (nodeId === BROKER) return { role: 'broker', self: nodeId, published: [] };
    if (CONSUMERS.includes(nodeId)) return { role: 'consumer', self: nodeId, processed: [] };
    return { role: 'producer', self: nodeId };
  },

  reduce(state, event): [RedisState, Effect[]] {
    if (state.role === 'producer') return reduceProducer(state, event);
    if (state.role === 'broker') return reduceBroker(state, event);
    return reduceConsumer(state, event);
  },

  metrics(states) {
    const t = redisTriple(states);
    return [
      { name: 'produced', value: t.produced },
      { name: 'delivered', value: t.delivered },
      { name: 'duplicates', value: t.duplicates },
      { name: 'lost', value: t.lost },
    ];
  },

  inspect(state) {
    if (state.role === 'broker') return { role: 'broker', published: state.published } as unknown as InspectorTree;
    if (state.role === 'consumer') return { role: 'consumer', processed: state.processed } as unknown as InspectorTree;
    return { role: 'producer' } as unknown as InspectorTree;
  },
};

function brokerOf(states: Map<NodeId, RedisState>): RedisBroker | null {
  const b = states.get(BROKER);
  return b && b.role === 'broker' ? b : null;
}

/**
 * The counting triple for Redis pub/sub. Fan-out means `duplicates` is
 * structurally 0 (each subscriber legitimately gets one copy). `lost` counts
 * per-subscriber misses: a message C1 got but C2 missed is lost *for C2*
 * (spec §5). Meaningful only once drained.
 */
export function redisTriple(states: Map<NodeId, RedisState>): Triple {
  const b = brokerOf(states);
  const published = b ? b.published : [];
  const publishedSet = new Set(published);
  let delivered = 0;
  const seen = new Set<string>();
  const subMisses = CONSUMERS.map((c) => {
    const s = states.get(c);
    const processed = new Set(s && s.role === 'consumer' ? s.processed : []);
    for (const id of processed) if (publishedSet.has(id)) seen.add(id);
    return published.filter((id) => !processed.has(id)).length; // this subscriber's misses
  });
  delivered = seen.size; // ids that reached at least one subscriber
  const lost = subMisses.reduce((a, b2) => a + b2, 0);
  return { produced: published.length, delivered, duplicates: 0, lost };
}

/** Challenge win (spec §7.3): at drain, at least one published id missed a subscriber. */
export function detectRedisLost(states: Map<NodeId, RedisState>): { lost: number } | null {
  const t = redisTriple(states);
  return t.lost >= 1 ? { lost: t.lost } : null;
}
