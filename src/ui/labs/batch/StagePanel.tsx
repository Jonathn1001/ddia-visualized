// src/ui/labs/batch/StagePanel.tsx
import type { BatchSchedInspect, BatchSideCounters, BatchWorkerInspect } from '../../../modules/batch';
import { MAP_TASKS, REDUCE_TASKS, WORKERS, type MapTaskId, type ReduceTaskId, type Side, type TaskId } from '../../../modules/batch-shared';

/** One shuffle-in-flight marker for the SVG lane; frac 0..1 along the from→to arc. */
export interface ShuffleDot {
  id: string;
  from: string;
  to: string;
  frac: number;
}

type TaskStatus = BatchSchedInspect['mr']['tasks'][TaskId]['status'];
type DfStatus = 'waiting' | 'running' | 'done';

const STATUS_CLASS: Record<TaskStatus, string> = {
  waiting: 'text-dim',
  runnable: 'text-fg',
  running: 'text-warn font-bold',
  done: 'text-set',
};

/** Fixed 3-column geometry — the shuffle lane's x-position for each canonical worker id. */
const LANE_X: Record<string, number> = Object.fromEntries(WORKERS.map((w, i) => [w, 30 + i * 75]));

function dfMapStatus(t: MapTaskId, df: BatchSchedInspect['df']): DfStatus {
  if (df.mapsDone.includes(t)) return 'done';
  if (df.placement[t]) return 'running';
  return 'waiting';
}

function dfReduceStatus(t: ReduceTaskId, df: BatchSchedInspect['df']): DfStatus {
  if (df.reduceDone.includes(t)) return 'done';
  if (df.placement[t]) return 'running';
  return 'waiting';
}

function mrCounterLine(c: BatchSideCounters): string {
  return `materialized ${c.materialized} · re-exec ${c.reexecuted} · lost-after-done ${c.lostAfterDone} · wasted ${c.wasted} · done@${c.completionTick ?? '—'}`;
}

function dfCounterLine(attempt: number, c: BatchSideCounters): string {
  return `attempt #${attempt} · restarts ${c.restarts} · wasted ${c.wasted} · done@${c.completionTick ?? '—'}`;
}

function dotPos(d: ShuffleDot): { x: number; y: number } {
  const fromX = LANE_X[d.from] ?? 30;
  const toX = LANE_X[d.to] ?? 30;
  const x = fromX + (toX - fromX) * d.frac;
  const y = 30 - Math.sin(d.frac * Math.PI) * 14; // simple arc, apex mid-flight
  return { x, y };
}

function WorkerBadge({ side, worker }: { side: Side; worker: BatchWorkerInspect }) {
  if (side === 'mr') {
    const { task, phase, recordsDone, recordsTotal } = worker.mr;
    return (
      <p className="text-dim">
        {task ?? '—'}·{phase ?? '—'}·{recordsDone}/{recordsTotal}
      </p>
    );
  }
  const { maps, reduces } = worker.df;
  if (maps.length === 0 && reduces.length === 0) {
    return <p className="text-dim">—</p>;
  }
  return (
    <div className="text-dim space-y-0.5">
      {maps.map((m) => (
        <p key={m.task}>
          {m.task}:{m.cursor}
          {m.done ? ' done' : ''}
        </p>
      ))}
      {reduces.map((r) => (
        <p key={r.task}>
          {r.task}:{r.folded}/{r.closed}
        </p>
      ))}
    </div>
  );
}

/**
 * One engine column (MR or DF): progress strip, map/shuffle/reduce lanes,
 * worker chips, MR-only local-disk row, output table. Presentational —
 * BatchLab owns the sim and the sched/worker/dots derivation.
 */
export function StagePanel({
  side,
  title,
  sched,
  workers,
  deadNodes,
  dots,
}: {
  side: Side;
  title: string;
  sched: BatchSchedInspect;
  workers: BatchWorkerInspect[];
  deadNodes: string[];
  dots: ShuffleDot[];
}) {
  const output = side === 'mr' ? sched.mr.output : sched.df.output;
  return (
    <section
      data-side={side}
      className="overflow-x-auto border border-line bg-panel rounded p-3 space-y-2 font-mono text-xs"
    >
      <h3 className="font-bold text-fg">{title}</h3>
      {side === 'mr' ? (
        <p className="text-dim">
          phase: <span className="text-fg">{sched.mr.phase}</span> · {mrCounterLine(sched.mr.counters)}
        </p>
      ) : (
        <p className="text-dim">
          {dfCounterLine(sched.df.attempt, sched.df.counters)}
          {sched.df.awaitingRevive && (
            <span data-waiting="true" className="text-warn font-bold ml-2">
              waiting for revive
            </span>
          )}
        </p>
      )}

      <div data-lane="map" className="flex gap-1 items-center">
        <span className="text-dim w-14 shrink-0">map</span>
        {MAP_TASKS.map((t) => {
          const status = side === 'mr' ? sched.mr.tasks[t].status : dfMapStatus(t, sched.df);
          return (
            <span
              key={t}
              data-task={t}
              data-status={status}
              className={`inline-block border border-line rounded px-1 ${STATUS_CLASS[status]}`}
            >
              {t}
            </span>
          );
        })}
      </div>

      <div data-lane="shuffle" className="flex justify-center">
        <svg data-shuffle-svg width={210} height={44} viewBox="0 0 210 44">
          {WORKERS.map((w) => (
            <text key={w} x={LANE_X[w]} y={40} fontSize={9} textAnchor="middle" style={{ fill: 'var(--color-dim)' }}>
              {w}
            </text>
          ))}
          {dots.map((d) => {
            const { x, y } = dotPos(d);
            return <circle key={d.id} data-dot cx={x} cy={y} r={3} style={{ fill: 'var(--color-warn)' }} />;
          })}
        </svg>
      </div>

      <div data-lane="reduce" className="flex gap-1 items-center">
        <span className="text-dim w-14 shrink-0">reduce</span>
        {REDUCE_TASKS.map((t) => {
          const status = side === 'mr' ? sched.mr.tasks[t].status : dfReduceStatus(t, sched.df);
          return (
            <span
              key={t}
              data-task={t}
              data-status={status}
              className={`inline-block border border-line rounded px-1 ${STATUS_CLASS[status]}`}
            >
              {t}
            </span>
          );
        })}
      </div>

      <div className="flex gap-2 flex-wrap">
        {workers.map((w) => {
          const dead = deadNodes.includes(w.id);
          return (
            <div
              key={w.id}
              data-worker={w.id}
              {...(dead ? { 'data-dead': 'true' } : {})}
              className={`border border-line rounded px-2 py-1 ${dead ? 'opacity-40' : ''}`}
            >
              <p className="text-fg font-bold">{w.id}</p>
              <WorkerBadge side={side} worker={w} />
            </div>
          );
        })}
      </div>

      {side === 'mr' && (
        <div data-disk-row className="flex gap-2 flex-wrap">
          {workers.map((w) => (
            <div key={w.id} className="flex gap-1 items-center">
              <span className="text-dim">{w.id}:</span>
              {w.mr.diskFiles.map((f) => (
                <span key={f} data-disk-file={f} className="inline-block border border-line rounded px-1 text-dim">
                  {f}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}

      <div data-output className="space-y-0.5">
        {output.length === 0 ? (
          <p className="text-dim">no output yet</p>
        ) : (
          output.map(([url, count]) => (
            <div key={url} data-output-row className="flex gap-2">
              <span className="text-fg">{url}</span>
              <span className="text-dim">{count}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
