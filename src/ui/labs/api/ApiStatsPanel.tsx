import type { ApiStats } from '../../../modules/api-shared';

export type ApiMode = 'rest' | 'graphql' | 'grpc';

export interface ExtraStat {
  key: string;
  label: string;
  value: string | number;
  warn?: boolean;
}

const LABELS: Record<ApiMode, string> = { rest: 'REST', graphql: 'GraphQL', grpc: 'gRPC' };

/** The at-a-glance readout for an API-style flow: round trips, bytes, delivery, and mode extras. */
export function ApiStatsPanel({ mode, stats, extras = [] }: { mode: ApiMode; stats: ApiStats; extras?: ExtraStat[] }) {
  const rows: ExtraStat[] = [
    { key: 'round-trips', label: 'client round trips', value: stats.roundTrips },
    { key: 'bytes', label: 'bytes on the wire', value: stats.bytes },
    { key: 'delivered', label: 'posts delivered', value: `${stats.delivered}/${stats.expected}`, warn: stats.settled && stats.delivered < stats.expected },
    { key: 'failed', label: 'requests failed', value: stats.failed, warn: stats.failed > 0 },
    ...extras,
  ];
  return (
    <div className="min-w-[240px] space-y-1 rounded border border-line bg-panel p-3">
      <p className="mb-1 font-mono text-[11px] tracking-wider text-dim uppercase">{LABELS[mode]} · one profile load</p>
      {rows.map((r) => (
        <div key={r.key} data-stat={r.key} className="flex items-center justify-between gap-4 font-mono text-xs">
          <span className="text-dim">{r.label}</span>
          <span className={r.warn ? 'text-warn font-bold' : 'text-fg'}>{r.value}</span>
        </div>
      ))}
      <p className="pt-1 font-mono text-[10px] text-dim">{stats.settled ? 'settled' : 'in flight…'}</p>
    </div>
  );
}
