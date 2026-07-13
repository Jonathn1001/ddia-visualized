import type { Triple } from '../../../modules/brokers-shared';
import type { BrokerMode } from '../../kit/BrokerInternals';

const ROWS: { mode: BrokerMode; label: string }[] = [
  { mode: 'kafka', label: 'Kafka' },
  { mode: 'rabbit', label: 'RabbitMQ' },
  { mode: 'redis', label: 'Redis' },
];

/**
 * Cross-broker scoreboard (spec §6): one row per broker × produced / delivered /
 * duplicates / lost. A row fills from its mode's triple when that run drains and
 * dims (stale) when that tab's sim is rebuilt. Session-local; not persisted.
 */
export function Scoreboard({
  scores,
  stale,
}: {
  scores: Record<BrokerMode, Triple | null>;
  stale: Record<BrokerMode, boolean>;
}) {
  return (
    <table className="font-mono text-xs">
      <thead>
        <tr className="text-dim">
          <th className="px-2 py-1 text-left">broker</th>
          <th className="px-2 py-1 text-right">produced</th>
          <th className="px-2 py-1 text-right">delivered</th>
          <th className="px-2 py-1 text-right">duplicates</th>
          <th className="px-2 py-1 text-right">lost</th>
        </tr>
      </thead>
      <tbody>
        {ROWS.map(({ mode, label }) => {
          const t = scores[mode];
          const dim = t === null || stale[mode];
          const num = (v: number | undefined) => (t === null ? '—' : v);
          return (
            <tr key={mode} data-score={mode} className={dim ? 'text-dim' : 'text-fg'}>
              <td className="px-2 py-1 text-left">{label}</td>
              <td className="px-2 py-1 text-right" data-produced>
                {num(t?.produced)}
              </td>
              <td className="px-2 py-1 text-right" data-delivered>
                {num(t?.delivered)}
              </td>
              <td className={`px-2 py-1 text-right ${!dim && t && t.duplicates > 0 ? 'text-warn font-bold' : ''}`} data-duplicates>
                {num(t?.duplicates)}
              </td>
              <td className={`px-2 py-1 text-right ${!dim && t && t.lost > 0 ? 'text-warn font-bold' : ''}`} data-lost>
                {num(t?.lost)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
