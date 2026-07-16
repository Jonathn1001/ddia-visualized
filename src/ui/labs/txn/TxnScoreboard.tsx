// src/ui/labs/txn/TxnScoreboard.tsx
import type { TxnInspect } from '../../../modules/txn';

const ROWS: { label: string; bad: boolean; value: (p: TxnInspect) => number }[] = [
  { label: 'commits', bad: false, value: (p) => p.counters.commits },
  { label: 'aborts', bad: false, value: (p) => p.counters.aborts },
  { label: 'dirty reads', bad: true, value: (p) => p.anomalies.filter((a) => a.type === 'dirty-read').length },
  { label: 'lost updates', bad: true, value: (p) => p.anomalies.filter((a) => a.type === 'lost-update').length },
  { label: 'write skews', bad: true, value: (p) => p.anomalies.filter((a) => a.type === 'write-skew').length },
  { label: 'queued ops', bad: false, value: (p) => p.counters.queuedOps },
];

/** The countable outcome: same schedule, four verdicts. Coral = an anomaly happened here. */
export function TxnScoreboard({ panels }: { panels: TxnInspect[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="font-mono text-xs border border-line bg-panel rounded">
        <thead>
          <tr>
            <th className="px-2 py-1 text-left text-dim" />
            {panels.map((p) => (
              <th key={p.level} className="px-2 py-1 text-fg">
                {p.level}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={row.label} className="border-t border-line">
              <td className="px-2 py-1 text-dim text-left">{row.label}</td>
              {panels.map((p) => {
                const v = row.value(p);
                const bad = row.bad && v > 0;
                return (
                  <td
                    key={p.level}
                    data-cell={`${p.level}:${row.label}`}
                    {...(bad ? { 'data-bad': 'true' } : {})}
                    className={`px-2 py-1 text-center ${bad ? 'text-sign font-bold' : 'text-fg'}`}
                  >
                    {v}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
