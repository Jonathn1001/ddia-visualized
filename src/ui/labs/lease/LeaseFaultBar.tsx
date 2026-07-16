import { useState } from 'react';
import { btn, btnPrimary, inputBox } from '../../kit/classes';

const WORKERS = ['W1', 'W2'] as const;
type WorkerId = (typeof WORKERS)[number];

/** User-facing process faults: acquire, GC-pause, slow clock, fencing toggle. */
export function LeaseFaultBar({
  onAcquire,
  onPause,
  onSkew,
  onFencing,
  fencing,
}: {
  onAcquire: (w: WorkerId) => void;
  onPause: (w: WorkerId, ticks: number) => void;
  onSkew: (w: WorkerId, rate: number) => void;
  onFencing: (on: boolean) => void;
  fencing: boolean;
}) {
  const [ticks, setTicks] = useState('180');
  return (
    <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
      {WORKERS.map((w) => (
        <button key={w} data-action={`acquire-${w}`} className={btn} onClick={() => onAcquire(w)}>
          {w} acquire
        </button>
      ))}
      <span className="text-dim">| gc-pause</span>
      <input className={`w-14 ${inputBox}`} value={ticks} onChange={(e) => setTicks(e.target.value)} aria-label="pause ticks" />
      {WORKERS.map((w) => (
        <button key={w} data-action={`pause-${w}`} className={btn} onClick={() => onPause(w, Number(ticks) || 180)}>
          ⏸ {w}
        </button>
      ))}
      <span className="text-dim">| slow clock ×0.5</span>
      {WORKERS.map((w) => (
        <button key={w} data-action={`skew-${w}`} className={btn} onClick={() => onSkew(w, 0.5)}>
          🕰 {w}
        </button>
      ))}
      <button data-action="fencing" className={fencing ? btnPrimary : btn} onClick={() => onFencing(!fencing)}>
        fencing: {fencing ? 'on' : 'off'}
      </button>
    </div>
  );
}
