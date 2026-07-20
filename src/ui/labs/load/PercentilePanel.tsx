import { SLA, WINDOW_MIN, type LoadInspect } from '../../../modules/load-shared';

/**
 * Presentational percentile panel (pure props). Shows the user-request tail
 * (p50/p95/p99) against the SLA line, a backend row when fan-out is on, and a
 * throughput / queue-depth / utilisation readout. The p99 bar turns coral when
 * it breaches the SLA — the whole point of the lab.
 */
export interface PercentilePanelProps {
  view: LoadInspect;
}

interface Row {
  label: string;
  value: number;
  tone: 'fg' | 'dim' | 'tail';
}

function Bars({ rows, scale }: { rows: Row[]; scale: number }) {
  return (
    <div className="space-y-1">
      {rows.map((r) => {
        const breach = r.tone === 'tail' && r.value > SLA;
        const barColor = breach ? 'bg-sign' : r.tone === 'tail' ? 'bg-set' : 'bg-dim';
        const txtColor = breach ? 'text-sign' : 'text-fg';
        return (
          <div key={r.label} className="flex items-center gap-2">
            <span className="w-8 text-dim">{r.label}</span>
            <div className="relative h-3 flex-1 rounded bg-ink">
              <div
                className={`h-full rounded ${barColor}`}
                style={{ width: `${Math.min(100, (r.value / scale) * 100)}%` }}
              />
              {/* SLA marker */}
              <div
                className="absolute top-[-2px] h-[16px] w-px bg-warn"
                style={{ left: `${Math.min(100, (SLA / scale) * 100)}%` }}
                title={`SLA ${SLA}`}
              />
            </div>
            <span className={`w-12 text-right tabular-nums ${txtColor}`}>{r.value}</span>
          </div>
        );
      })}
    </div>
  );
}

export function PercentilePanel({ view }: PercentilePanelProps) {
  const warming = view.samples < WINDOW_MIN;
  const scale = Math.max(SLA, view.p99, view.fanout > 1 ? view.bp99 : 0) * 1.1 || 1;

  const userRows: Row[] = [
    { label: 'p50', value: view.p50, tone: 'dim' },
    { label: 'p95', value: view.p95, tone: 'fg' },
    { label: 'p99', value: view.p99, tone: 'tail' },
  ];
  const backendRows: Row[] = [
    { label: 'p50', value: view.bp50, tone: 'dim' },
    { label: 'p95', value: view.bp95, tone: 'fg' },
    { label: 'p99', value: view.bp99, tone: 'tail' },
  ];

  return (
    <section
      data-panel="percentiles"
      data-p99={view.p99}
      data-sla={SLA}
      className="border border-line bg-panel rounded p-3 space-y-3 font-mono text-xs"
    >
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-sm text-fg">Response time (ticks)</h3>
        <span className="text-dim">
          SLA <span className="text-warn">{SLA}</span>
        </span>
      </div>

      {warming ? (
        <p className="text-dim min-h-[4.5rem] flex items-center">
          warming up… ({view.samples}/{WINDOW_MIN} completions)
        </p>
      ) : (
        <>
          <div>
            <div className="text-dim mb-1">user request</div>
            <Bars rows={userRows} scale={scale} />
          </div>
          {view.fanout > 1 && (
            <div>
              <div className="text-dim mb-1">backend call (fan-out {view.fanout})</div>
              <Bars rows={backendRows} scale={scale} />
            </div>
          )}
        </>
      )}

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-dim border-t border-line pt-2">
        <span>
          throughput <span className="text-fg tabular-nums">{view.throughput.toFixed(3)}</span>/tick
        </span>
        <span>
          queue <span className="text-fg tabular-nums">{view.queueLen}</span>
        </span>
        <span>
          servers{' '}
          <span className="text-fg tabular-nums">
            {view.inService}/{view.servers}
          </span>
        </span>
        <span>
          utilisation{' '}
          <span className={view.utilisation > 0.9 ? 'text-sign' : 'text-fg'}>
            {Math.round(view.utilisation * 100)}%
          </span>
        </span>
      </div>
    </section>
  );
}
