import type { NodeId } from '../engine/events';
import { fnv1a } from '../engine/hash';
import type { Effect, InspectorTree, ModuleEvent, SimModule } from '../engine/module';
import { BROKER, CONSUMERS, groupCounts, otherConsumer, type Triple } from './brokers-shared';

/**
 * Kafka-style partitioned log (DDIA Ch11). The broker appends every published
 * id to one of two partition logs and pushes it to the partition's assigned
 * consumer. Consumers ack each fetch; the broker auto-commits the group offset
 * every COMMIT_EVERY acks, so committed always lags delivered by up to
 * COMMIT_EVERY-1 — the crash window. When a consumer stops acking (killed), a
 * session-timeout reassigns its partition to the survivor and REPLAYS from the
 * committed offset: the log retained everything, so nothing is lost, but the
 * already-processed-but-uncommitted offsets are processed again → duplicates.
 * At-least-once. Pure and deterministic (no RNG, no wall clock).
 */

export type Partition = 'p0' | 'p1';

/** Broker-side auto-commit interval — the size of the crash window (spec §3). */
export const COMMIT_EVERY = 3;
/**
 * Ticks after a deliver before its offset is presumed unfetched (dead consumer).
 * Must exceed a deliver→fetched round trip (2× max latency: lab 80, tests 40) so
 * a live consumer's ack always lands first and no reassignment fires on a
 * live-but-lagging consumer.
 */
export const SESSION_TIMEOUT = 300;

export interface KafkaBroker {
  role: 'broker';
  self: NodeId;
  /** Append-only logs of msg ids. */
  partitions: { p0: string[]; p1: string[] };
  /** Partition → assigned consumer (starts p0→C1, p1→C2). */
  assignment: { p0: NodeId; p1: NodeId };
  /** Next offset to push per partition (== count already delivered). */
  delivered: { p0: number; p1: number };
  /** Next unfetched offset — how far the *current* assignee has acked. */
  fetched: { p0: number; p1: number };
  /** Next offset after the last committed one (the group's durable position). */
  committed: { p0: number; p1: number };
  /** Fetch-acks since the last commit, per partition (broker-side auto-commit). */
  sinceCommit: { p0: number; p1: number };
  /** At most one reassignment per stall — cleared on commit-advance or publish. */
  stalled: { p0: boolean; p1: boolean };
}
export interface KafkaConsumer {
  role: 'consumer';
  self: NodeId;
  processed: string[];
}
export interface KafkaProducer {
  role: 'producer';
  self: NodeId;
}
export type KafkaState = KafkaBroker | KafkaConsumer | KafkaProducer;

export type KafkaPayload =
  | { cmd: 'produce'; key: string }
  | { msg: 'publish'; id: string }
  | { msg: 'deliver'; p: Partition; offset: number; id: string }
  | { msg: 'fetched'; p: Partition; offset: number }
  | { timer: 'sessionCheck'; p: Partition; offset: number }
  | null;

export function partitionOf(id: string): Partition {
  return fnv1a(id) % 2 === 0 ? 'p0' : 'p1';
}

function reduceProducer(s: KafkaProducer, ev: ModuleEvent<KafkaPayload>): [KafkaState, Effect[]] {
  const p = ev.payload;
  if (ev.kind === 'external' && p && 'cmd' in p && p.cmd === 'produce') {
    return [s, [{ type: 'send', to: BROKER, payload: { msg: 'publish', id: p.key } }]];
  }
  return [s, []];
}

function reduceConsumer(s: KafkaConsumer, ev: ModuleEvent<KafkaPayload>): [KafkaState, Effect[]] {
  const p = ev.payload;
  if (ev.kind === 'message' && p && 'msg' in p && p.msg === 'deliver') {
    return [
      { ...s, processed: [...s.processed, p.id] },
      [{ type: 'send', to: BROKER, payload: { msg: 'fetched', p: p.p, offset: p.offset } }],
    ];
  }
  return [s, []];
}

/** Push delivers for offsets [from, to) of partition `part` to `consumer`, arming a sessionCheck each. */
function deliverRange(part: Partition, log: string[], from: number, to: number, consumer: NodeId): Effect[] {
  const effects: Effect[] = [];
  for (let offset = from; offset < to; offset++) {
    effects.push({ type: 'send', to: consumer, payload: { msg: 'deliver', p: part, offset, id: log[offset] } });
    effects.push({ type: 'timer', delay: SESSION_TIMEOUT, payload: { timer: 'sessionCheck', p: part, offset } });
  }
  return effects;
}

function reduceBroker(s: KafkaBroker, ev: ModuleEvent<KafkaPayload>): [KafkaState, Effect[]] {
  const p = ev.payload;
  if (ev.kind === 'message' && p && 'msg' in p && p.msg === 'publish') {
    const part = partitionOf(p.id);
    const log = [...s.partitions[part], p.id];
    const partitions = { ...s.partitions, [part]: log };
    const from = s.delivered[part];
    const effects = deliverRange(part, log, from, log.length, s.assignment[part]);
    return [
      {
        ...s,
        partitions,
        delivered: { ...s.delivered, [part]: log.length },
        stalled: { ...s.stalled, [part]: false }, // publish is progress
      },
      effects,
    ];
  }

  if (ev.kind === 'message' && p && 'msg' in p && p.msg === 'fetched') {
    const part = p.p;
    if (ev.from !== s.assignment[part]) return [s, []]; // stale ack from a de-assigned consumer
    const fetched = Math.max(s.fetched[part], p.offset + 1);
    let since = s.sinceCommit[part] + 1;
    let committed = s.committed[part];
    let stalled = s.stalled[part];
    if (since >= COMMIT_EVERY) {
      committed = fetched;
      since = 0;
      stalled = false; // real progress — a new stall may reassign again
    }
    return [
      {
        ...s,
        fetched: { ...s.fetched, [part]: fetched },
        sinceCommit: { ...s.sinceCommit, [part]: since },
        committed: { ...s.committed, [part]: committed },
        stalled: { ...s.stalled, [part]: stalled },
      },
      [],
    ];
  }

  if (ev.kind === 'timer' && p && 'timer' in p && p.timer === 'sessionCheck') {
    const part = p.p;
    if (s.stalled[part]) return [s, []]; // already reassigned this stall
    if (s.fetched[part] > p.offset) return [s, []]; // assignee acked this offset — alive
    // No ack for this offset within the timeout → assignee presumed dead. Reassign
    // to the survivor and replay from the committed offset (spec §3).
    const newAssignee = otherConsumer(s.assignment[part]);
    const log = s.partitions[part];
    const effects = deliverRange(part, log, s.committed[part], s.delivered[part], newAssignee);
    return [
      {
        ...s,
        assignment: { ...s.assignment, [part]: newAssignee },
        fetched: { ...s.fetched, [part]: s.committed[part] },
        sinceCommit: { ...s.sinceCommit, [part]: 0 },
        stalled: { ...s.stalled, [part]: true },
      },
      effects,
    ];
  }

  return [s, []];
}

export const kafkalog: SimModule<KafkaState, KafkaPayload> = {
  id: 'kafka-log',
  chaos: ['kill-node', 'delay', 'drop'],

  init(nodeId) {
    if (nodeId === BROKER) {
      return {
        role: 'broker',
        self: nodeId,
        partitions: { p0: [], p1: [] },
        assignment: { p0: CONSUMERS[0], p1: CONSUMERS[1] },
        delivered: { p0: 0, p1: 0 },
        fetched: { p0: 0, p1: 0 },
        committed: { p0: 0, p1: 0 },
        sinceCommit: { p0: 0, p1: 0 },
        stalled: { p0: false, p1: false },
      };
    }
    if (CONSUMERS.includes(nodeId)) return { role: 'consumer', self: nodeId, processed: [] };
    return { role: 'producer', self: nodeId };
  },

  reduce(state, event): [KafkaState, Effect[]] {
    if (state.role === 'producer') return reduceProducer(state, event);
    if (state.role === 'broker') return reduceBroker(state, event);
    return reduceConsumer(state, event);
  },

  metrics(states) {
    const t = kafkaTriple(states);
    const broker = brokerOf(states);
    return [
      { name: 'produced', value: t.produced },
      { name: 'delivered', value: t.delivered },
      { name: 'duplicates', value: t.duplicates },
      { name: 'lost', value: t.lost },
      { name: 'committed', value: broker ? broker.committed.p0 + broker.committed.p1 : 0 },
    ];
  },

  inspect(state) {
    if (state.role === 'broker') {
      return {
        role: 'broker',
        partitions: state.partitions,
        committed: state.committed,
        delivered: state.delivered,
        fetched: state.fetched,
        assignment: state.assignment,
        stalled: state.stalled,
      } as unknown as InspectorTree;
    }
    if (state.role === 'consumer') return { role: 'consumer', processed: state.processed } as unknown as InspectorTree;
    return { role: 'producer' } as unknown as InspectorTree;
  },
};

function brokerOf(states: Map<NodeId, KafkaState>): KafkaBroker | null {
  const b = states.get(BROKER);
  return b && b.role === 'broker' ? b : null;
}

function consumerLists(states: Map<NodeId, KafkaState>): string[][] {
  return CONSUMERS.map((c) => {
    const s = states.get(c);
    return s && s.role === 'consumer' ? s.processed : [];
  });
}

/**
 * The counting triple for Kafka. `lost` is 0 by construction: the log retains
 * every produced id, so anything not yet processed is still recoverable, never
 * lost. `dup` reflects replayed-after-crash reprocessing.
 */
export function kafkaTriple(states: Map<NodeId, KafkaState>): Triple {
  const broker = brokerOf(states);
  const produced = broker ? broker.partitions.p0.length + broker.partitions.p1.length : 0;
  const { delivered, duplicates } = groupCounts(consumerLists(states));
  return { produced, delivered, duplicates, lost: 0 };
}

/** Challenge win (spec §7.1): the group has reprocessed at least one id. */
export function detectKafkaDup(states: Map<NodeId, KafkaState>): { duplicates: number } | null {
  const t = kafkaTriple(states);
  return t.duplicates >= 1 ? { duplicates: t.duplicates } : null;
}
