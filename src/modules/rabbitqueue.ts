import type { NodeId } from '../engine/events';
import type { Effect, InspectorTree, ModuleEvent, SimModule } from '../engine/module';
import { BROKER, CONSUMERS, groupCounts, otherConsumer, type Triple } from './brokers-shared';

/**
 * RabbitMQ-style destructive queue (DDIA Ch11). The broker delivers each id to
 * one round-robin consumer and holds it "unacked" until that consumer acks —
 * then the id is *gone* (destructive read, the anti-log). If no ack arrives
 * within ACK_TIMEOUT, the message is requeued and redelivered to the other
 * consumer with a `redelivered` flag. A message requeued DELIVERY_LIMIT times is
 * dead-lettered (kept, not lost). Per-message acks, at-least-once. Pure and
 * deterministic (no RNG, no wall clock).
 */

/** Ticks the broker waits for an ack before requeueing (> a deliver→ack round trip). */
export const ACK_TIMEOUT = 300;
/** AMQP x-delivery-limit — after this many redeliveries a message is dead-lettered. */
export const DELIVERY_LIMIT = 5;

export interface RabbitBroker {
  role: 'broker';
  self: NodeId;
  /** Delivered-but-unacked messages, by id. */
  unacked: Record<string, { consumer: NodeId; redelivered: boolean }>;
  /** Messages that hit the delivery limit — kept and visible, never counted lost. */
  deadLetter: string[];
  /** Cumulative redelivery count (metric). */
  redeliveries: number;
  /** Round-robin pointer into CONSUMERS. */
  rr: number;
  /** Redelivery attempts per id, for the delivery limit. */
  delivery: Record<string, number>;
  /** Every id ever enqueued — for produced/lost accounting. */
  produced: string[];
}
export interface RabbitConsumer {
  role: 'consumer';
  self: NodeId;
  processed: string[];
  /** Ids processed that arrived flagged `redelivered` — the challenge evidence. */
  redeliveredProcessed: string[];
}
export interface RabbitProducer {
  role: 'producer';
  self: NodeId;
}
export type RabbitState = RabbitBroker | RabbitConsumer | RabbitProducer;

export type RabbitPayload =
  | { cmd: 'produce'; key: string }
  | { msg: 'publish'; id: string }
  | { msg: 'deliver'; id: string; redelivered: boolean }
  | { msg: 'ack'; id: string }
  | { timer: 'checkAck'; id: string }
  | null;

/**
 * Deliver `id` to a consumer (round-robin, or `target` on a requeue), mark it
 * unacked, and arm the ack timeout.
 */
function dispatch(
  s: RabbitBroker,
  id: string,
  redelivered: boolean,
  target?: NodeId,
): [RabbitBroker, Effect[]] {
  const consumer = target ?? CONSUMERS[s.rr];
  const rr = target ? s.rr : (s.rr + 1) % CONSUMERS.length;
  const effects: Effect[] = [
    { type: 'send', to: consumer, payload: { msg: 'deliver', id, redelivered } },
    { type: 'timer', delay: ACK_TIMEOUT, payload: { timer: 'checkAck', id } },
  ];
  return [{ ...s, rr, unacked: { ...s.unacked, [id]: { consumer, redelivered } } }, effects];
}

function reduceBroker(s: RabbitBroker, ev: ModuleEvent<RabbitPayload>): [RabbitState, Effect[]] {
  const p = ev.payload;
  if (ev.kind === 'message' && p && 'msg' in p) {
    if (p.msg === 'publish') {
      const withProduced: RabbitBroker = { ...s, produced: [...s.produced, p.id] };
      return dispatch(withProduced, p.id, false);
    }
    if (p.msg === 'ack') {
      if (!s.unacked[p.id]) return [s, []]; // already acked / dead-lettered
      const unacked = { ...s.unacked };
      delete unacked[p.id]; // destructive read — the message is gone
      return [{ ...s, unacked }, []];
    }
  }
  if (ev.kind === 'timer' && p && 'timer' in p && p.timer === 'checkAck') {
    const held = s.unacked[p.id];
    if (!held) return [s, []]; // acked in time
    const attempts = (s.delivery[p.id] ?? 0) + 1;
    if (attempts >= DELIVERY_LIMIT) {
      const unacked = { ...s.unacked };
      delete unacked[p.id];
      return [
        { ...s, unacked, delivery: { ...s.delivery, [p.id]: attempts }, deadLetter: [...s.deadLetter, p.id] },
        [],
      ];
    }
    const requeued: RabbitBroker = {
      ...s,
      redeliveries: s.redeliveries + 1,
      delivery: { ...s.delivery, [p.id]: attempts },
    };
    return dispatch(requeued, p.id, true, otherConsumer(held.consumer));
  }
  return [s, []];
}

function reduceConsumer(s: RabbitConsumer, ev: ModuleEvent<RabbitPayload>): [RabbitState, Effect[]] {
  const p = ev.payload;
  if (ev.kind === 'message' && p && 'msg' in p && p.msg === 'deliver') {
    return [
      {
        ...s,
        processed: [...s.processed, p.id],
        redeliveredProcessed: p.redelivered ? [...s.redeliveredProcessed, p.id] : s.redeliveredProcessed,
      },
      [{ type: 'send', to: BROKER, payload: { msg: 'ack', id: p.id } }],
    ];
  }
  return [s, []];
}

function reduceProducer(s: RabbitProducer, ev: ModuleEvent<RabbitPayload>): [RabbitState, Effect[]] {
  const p = ev.payload;
  if (ev.kind === 'external' && p && 'cmd' in p && p.cmd === 'produce') {
    return [s, [{ type: 'send', to: BROKER, payload: { msg: 'publish', id: p.key } }]];
  }
  return [s, []];
}

export const rabbitqueue: SimModule<RabbitState, RabbitPayload> = {
  id: 'rabbit-queue',
  chaos: ['kill-node', 'delay', 'drop'],

  init(nodeId) {
    if (nodeId === BROKER) {
      return {
        role: 'broker',
        self: nodeId,
        unacked: {},
        deadLetter: [],
        redeliveries: 0,
        rr: 0,
        delivery: {},
        produced: [],
      };
    }
    if (CONSUMERS.includes(nodeId)) return { role: 'consumer', self: nodeId, processed: [], redeliveredProcessed: [] };
    return { role: 'producer', self: nodeId };
  },

  reduce(state, event): [RabbitState, Effect[]] {
    if (state.role === 'producer') return reduceProducer(state, event);
    if (state.role === 'broker') return reduceBroker(state, event);
    return reduceConsumer(state, event);
  },

  metrics(states) {
    const t = rabbitTriple(states);
    const b = brokerOf(states);
    return [
      { name: 'produced', value: t.produced },
      { name: 'delivered', value: t.delivered },
      { name: 'duplicates', value: t.duplicates },
      { name: 'lost', value: t.lost },
      { name: 'unacked', value: b ? Object.keys(b.unacked).length : 0 },
      { name: 'redeliveries', value: b ? b.redeliveries : 0 },
      { name: 'dead-letter', value: b ? b.deadLetter.length : 0 },
    ];
  },

  inspect(state) {
    if (state.role === 'broker') {
      return {
        role: 'broker',
        unacked: state.unacked,
        deadLetter: state.deadLetter,
        redeliveries: state.redeliveries,
      } as unknown as InspectorTree;
    }
    if (state.role === 'consumer') {
      return { role: 'consumer', processed: state.processed, redeliveredProcessed: state.redeliveredProcessed } as unknown as InspectorTree;
    }
    return { role: 'producer' } as unknown as InspectorTree;
  },
};

function brokerOf(states: Map<NodeId, RabbitState>): RabbitBroker | null {
  const b = states.get(BROKER);
  return b && b.role === 'broker' ? b : null;
}

function consumerLists(states: Map<NodeId, RabbitState>): string[][] {
  return CONSUMERS.map((c) => {
    const s = states.get(c);
    return s && s.role === 'consumer' ? s.processed : [];
  });
}

/**
 * The counting triple for RabbitMQ. `lost` is 0 at drain: every produced id is
 * processed, still unacked, or dead-lettered (kept) — never silently dropped.
 */
export function rabbitTriple(states: Map<NodeId, RabbitState>): Triple {
  const b = brokerOf(states);
  const produced = b ? b.produced : [];
  const { delivered, duplicates } = groupCounts(consumerLists(states));
  const processed = new Set(consumerLists(states).flat());
  const dead = new Set(b ? b.deadLetter : []);
  const unacked = b ? b.unacked : {};
  const lost = produced.filter((id) => !processed.has(id) && !(id in unacked) && !dead.has(id)).length;
  return { produced: produced.length, delivered, duplicates, lost };
}

/** Challenge win (spec §7.2): a redelivered-flagged message was processed by a consumer. */
export function detectRabbitRedelivery(states: Map<NodeId, RabbitState>): { redeliveries: number } | null {
  const b = brokerOf(states);
  const redeliveredProcessed = CONSUMERS.reduce((n, c) => {
    const s = states.get(c);
    return n + (s && s.role === 'consumer' ? s.redeliveredProcessed.length : 0);
  }, 0);
  return redeliveredProcessed >= 1 ? { redeliveries: b ? b.redeliveries : 0 } : null;
}
