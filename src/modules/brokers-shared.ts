import type { NodeId } from '../engine/events';

/** Fixed broker-lab topology (spec §2): one producer, one broker, two consumers. */
export const PRODUCER: NodeId = 'P';
export const BROKER: NodeId = 'B';
export const CONSUMERS: NodeId[] = ['C1', 'C2'];
export const BROKER_TOPOLOGY: NodeId[] = [PRODUCER, BROKER, ...CONSUMERS];

/** The counting triple (spec §2) plus produced, for the scoreboard row. */
export interface Triple {
  produced: number;
  delivered: number;
  duplicates: number;
  lost: number;
}

/** The consumer in the pair that isn't `c` (defensive default to CONSUMERS[0]). */
export function otherConsumer(c: NodeId): NodeId {
  return CONSUMERS.find((x) => x !== c) ?? CONSUMERS[0];
}

/**
 * Competing-consumer delivered/duplicates over the group's processed multisets.
 * Kafka + RabbitMQ share this: each message belongs to one consumer, so an id
 * seen more than once across the group is a genuine duplicate. Redis fan-out
 * does NOT use this — every subscriber legitimately gets every message (spec §5).
 */
export function groupCounts(processedLists: string[][]): { delivered: number; duplicates: number } {
  const counts = new Map<string, number>();
  for (const list of processedLists) for (const id of list) counts.set(id, (counts.get(id) ?? 0) + 1);
  let delivered = 0;
  let duplicates = 0;
  for (const n of counts.values()) {
    delivered++;
    if (n > 1) duplicates += n - 1;
  }
  return { delivered, duplicates };
}
