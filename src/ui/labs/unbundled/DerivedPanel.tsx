import type { ReactNode } from 'react';
import type { ViewId } from '../../../modules/unbundled-shared';
import { btn } from '../../kit/classes';

export interface DerivedPanelProps {
  view: ViewId;
  label: string;
  head: number;
  offset: number;
  paused: boolean;
  dedup: boolean;
  body: ReactNode;
  onPause: () => void;
  onWipe: () => void;
  onRedeliver: () => void;
  onToggleDedup: () => void;
}

export function DerivedPanel({
  view,
  label,
  head,
  offset,
  paused,
  dedup,
  body,
  onPause,
  onWipe,
  onRedeliver,
  onToggleDedup,
}: DerivedPanelProps) {
  const lag = Math.max(0, head - offset);
  const pct = head > 0 ? Math.round((offset / head) * 100) : 100;
  return (
    <section
      data-view={view}
      data-offset={offset}
      data-head={head}
      data-lag={lag}
      data-paused={paused}
      className="border border-line bg-panel rounded p-3 space-y-2 font-mono text-xs"
    >
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-sm text-fg">{label}</h3>
        <span className={lag > 0 ? 'text-dim' : 'text-set'}>
          offset {offset}/{head} · lag {lag}
        </span>
      </div>
      <div className="h-1.5 w-full rounded bg-ink">
        <div className="h-full rounded bg-set" style={{ width: `${pct}%` }} />
      </div>
      <div className="min-h-[3rem] text-fg">{body}</div>
      <div className="flex flex-wrap gap-2">
        <button className={btn} onClick={onPause}>
          {paused ? 'resume' : 'pause'}
        </button>
        <button className={btn} onClick={onWipe}>
          wipe
        </button>
        <button className={btn} onClick={onRedeliver}>
          redeliver
        </button>
        <button className={btn} onClick={onToggleDedup}>
          dedup: {dedup ? 'on' : 'off'}
        </button>
      </div>
    </section>
  );
}
