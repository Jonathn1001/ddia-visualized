// src/ui/labs/txn/SchedulePanel.tsx
import { opLabel, type Preset, type PresetId } from '../../../modules/txn-shared';
import { btn, btnPrimary } from '../../kit/classes';

/**
 * The schedule is the experiment: pick an anomaly preset, then step the same
 * op into all four isolation panels at once. Presentational — TxnLab owns
 * the cursor and the sim.
 */
export function SchedulePanel({
  presets,
  activeId,
  cursor,
  onPick,
  onStep,
  onRunAll,
  onReset,
}: {
  presets: Preset[];
  activeId: PresetId;
  cursor: number;
  onPick: (id: PresetId) => void;
  onStep: () => void;
  onRunAll: () => void;
  onReset: () => void;
}) {
  const active = presets.find((p) => p.id === activeId) ?? presets[0];
  const done = cursor >= active.steps.length;
  return (
    <section className="border border-line bg-panel rounded p-3 space-y-2 font-mono text-xs max-w-xl">
      <div className="flex flex-wrap gap-2">
        {presets.map((p) => (
          <button
            key={p.id}
            data-preset={p.id}
            className={p.id === activeId ? btnPrimary : btn}
            onClick={() => onPick(p.id)}
          >
            {p.title}
          </button>
        ))}
      </div>
      <p className="text-dim">{active.blurb}</p>
      <ol className="space-y-0.5">
        {active.steps.map((s, i) => {
          const state = i < cursor ? 'done' : i === cursor ? 'next' : 'todo';
          return (
            <li
              key={i}
              data-step={i}
              data-state={state}
              className={
                state === 'next'
                  ? 'text-fg bg-ink border border-line rounded px-1'
                  : state === 'done'
                    ? 'text-dim px-1'
                    : 'text-dim/60 px-1'
              }
            >
              {state === 'next' ? '→ ' : '  '}
              {opLabel(s)}
            </li>
          );
        })}
      </ol>
      <div className="flex gap-2">
        <button data-action="step" className={btnPrimary} disabled={done} onClick={() => !done && onStep()}>
          step
        </button>
        <button data-action="run-all" className={btn} disabled={done} onClick={() => !done && onRunAll()}>
          run to end
        </button>
        <button data-action="reset" className={btn} onClick={onReset}>
          reset
        </button>
      </div>
    </section>
  );
}
