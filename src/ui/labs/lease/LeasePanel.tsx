import type { LockInspect, WorkerInspect } from '../../../modules/lease';

/** The Lock's truth beside each worker's belief — the gap IS the chapter. */
export function LeasePanel({ lock, workers, time }: { lock: LockInspect; workers: WorkerInspect[]; time: number }) {
  return (
    <section className="border border-line bg-panel rounded p-3 space-y-2 font-mono text-xs w-72">
      <div data-lock className="space-y-0.5">
        <h3 className="font-bold text-fg">Lock (lease service)</h3>
        <p>
          holder: <span className="text-set">{lock.holder ?? '—'}</span>{' '}
          <span className="text-dim">token {lock.token}</span>
        </p>
        <p className="text-dim">
          expires in: {lock.expiresAt === null ? '—' : Math.max(0, lock.expiresAt - time)}
          {lock.queue.length > 0 && <> · queue: {lock.queue.join(', ')}</>}
        </p>
      </div>
      {workers.map((w) => {
        const believes =
          w.state === 'holding' && w.grantAt !== null && w.ttl !== null && (time - w.grantAt) * w.rate < w.ttl;
        const isTruth = lock.holder === w.id;
        const belief = believes && !isTruth ? 'stale' : believes && isTruth ? 'true' : 'none';
        return (
          <div key={w.id} data-worker={w.id} data-belief={belief} className="border-t border-line pt-1 space-y-0.5">
            <p className="text-fg">
              {w.id} <span className="text-dim">{w.state}</span>
              {w.working && <span className="text-warn"> ⚙ working</span>}
              {w.pausedUntil !== null && <span className="text-sign"> ⏸ paused→{w.pausedUntil}</span>}
            </p>
            <p className={belief === 'stale' ? 'text-sign' : 'text-dim'}>
              {belief === 'stale' && `believes it holds token ${w.token} — the lock disagrees`}
              {belief === 'true' && `holds token ${w.token}`}
              {belief === 'none' && `no lease claim`}
              {w.rate !== 1 && <span className="text-warn"> · clock ×{w.rate}</span>}
            </p>
          </div>
        );
      })}
    </section>
  );
}
