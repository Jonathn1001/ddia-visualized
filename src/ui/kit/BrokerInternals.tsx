import type { NodeId } from '../../engine';

export type BrokerMode = 'kafka' | 'rabbit' | 'redis';

export interface ConsumerView {
  id: NodeId;
  dead: boolean;
  processed: string[];
}

interface KafkaBrokerView {
  partitions: { p0: string[]; p1: string[] };
  committed: { p0: number; p1: number };
  delivered: { p0: number; p1: number };
  assignment: { p0: NodeId; p1: NodeId };
  stalled: { p0: boolean; p1: boolean };
}
interface RabbitBrokerView {
  unacked: Record<string, { consumer: NodeId; redelivered: boolean }>;
  deadLetter: string[];
  redeliveries: number;
}
interface RedisBrokerView {
  published: string[];
}

const cell = 'inline-flex items-center justify-center rounded border px-1.5 py-0.5 font-mono text-[10px]';

/**
 * The broker's inner state, per mode — rendered from `inspect` of the published
 * store view only (HRInspect discipline). Partition lanes + offsets for Kafka,
 * queue + unacked for RabbitMQ, subscriber fan-out + misses for Redis.
 */
export function BrokerInternals({
  mode,
  broker,
  consumers,
}: {
  mode: BrokerMode;
  broker: Record<string, unknown> | undefined;
  consumers: ConsumerView[];
}) {
  if (!broker) return null;
  return (
    <div className="min-w-[280px] space-y-2 rounded border border-line bg-panel p-3">
      <p className="font-mono text-[11px] tracking-wider text-dim uppercase">broker · {mode}</p>
      {mode === 'kafka' && <KafkaInternals broker={broker as unknown as KafkaBrokerView} />}
      {mode === 'rabbit' && <RabbitInternals broker={broker as unknown as RabbitBrokerView} />}
      {mode === 'redis' && <RedisInternals broker={broker as unknown as RedisBrokerView} consumers={consumers} />}
    </div>
  );
}

function KafkaLane({ p, broker }: { p: 'p0' | 'p1'; broker: KafkaBrokerView }) {
  const log = broker.partitions[p];
  const committed = broker.committed[p];
  const delivered = broker.delivered[p];
  return (
    <div data-partition={p} className="space-y-1">
      <p className="font-mono text-[10px] text-dim">
        {p} → <span className="text-fg">{broker.assignment[p]}</span> · committed {committed}/{log.length}
        {broker.stalled[p] && <span className="text-warn"> · stalled</span>}
      </p>
      <div className="flex flex-wrap gap-1">
        {log.length === 0 && <span className="font-mono text-[10px] text-dim">(empty)</span>}
        {log.map((id, offset) => {
          const committedCell = offset < committed;
          const window = offset >= committed && offset < delivered; // the crash window
          const klass = committedCell
            ? 'border-set text-set'
            : window
              ? 'border-warn bg-warn/10 text-warn'
              : 'border-line text-dim';
          return (
            <span key={offset} data-offset={`${p}:${offset}`} className={`${cell} ${klass}`}>
              {id}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function KafkaInternals({ broker }: { broker: KafkaBrokerView }) {
  return (
    <div className="space-y-2">
      <KafkaLane p="p0" broker={broker} />
      <KafkaLane p="p1" broker={broker} />
      <p className="font-mono text-[10px] text-dim">amber = delivered but uncommitted (the crash window)</p>
    </div>
  );
}

function RabbitInternals({ broker }: { broker: RabbitBrokerView }) {
  const unacked = Object.entries(broker.unacked);
  return (
    <div className="space-y-2">
      <p className="font-mono text-[10px] text-dim">unacked (held until ack) · redeliveries {broker.redeliveries}</p>
      <div className="flex flex-wrap gap-1">
        {unacked.length === 0 && <span className="font-mono text-[10px] text-dim">(none)</span>}
        {unacked.map(([id, m]) => (
          <span key={id} data-unacked={id} className={`${cell} border-warn bg-warn/10 text-warn`}>
            {id}@{m.consumer}
            {m.redelivered && <span data-redelivered={id}> ↺</span>}
          </span>
        ))}
      </div>
      <p className="font-mono text-[10px] text-dim">dead-letter (kept, not lost)</p>
      <div className="flex flex-wrap gap-1">
        {broker.deadLetter.length === 0 && <span className="font-mono text-[10px] text-dim">(none)</span>}
        {broker.deadLetter.map((id) => (
          <span key={id} data-deadletter={id} className={`${cell} border-sign text-dim`}>
            {id}
          </span>
        ))}
      </div>
    </div>
  );
}

function RedisInternals({ broker, consumers }: { broker: RedisBrokerView; consumers: ConsumerView[] }) {
  const published = broker.published;
  return (
    <div className="space-y-2">
      <p className="font-mono text-[10px] text-dim">published {published.length} · stored: nothing (fire-and-forget)</p>
      {consumers.map((c) => {
        const got = new Set(c.processed);
        const misses = published.filter((id) => !got.has(id));
        return (
          <div key={c.id} data-sub={c.id} className="space-y-1">
            <p className="font-mono text-[10px]">
              <span className={c.dead ? 'text-sign' : 'text-set'}>●</span>{' '}
              <span className="text-fg">{c.id}</span> {c.dead ? 'dead' : 'live'} · got {c.processed.length} ·{' '}
              <span data-lost={c.id} className={misses.length > 0 ? 'text-warn' : 'text-dim'}>
                missed {misses.length}
              </span>
            </p>
            <div className="flex flex-wrap gap-1">
              {misses.map((id) => (
                <span key={id} className={`${cell} border-warn/50 text-warn/70`}>
                  {id}
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
