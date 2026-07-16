// src/ui/labs/raft/HistoryPanel.tsx
import type { Verdict } from '../../../modules/linearizable';
import type { HistoryRow } from '../../../modules/raft-shared';
import { CHECK_CAP } from '../../../modules/raft-shared';
import { btn } from '../../kit/classes';

const OUTCOME_CLASS: Record<HistoryRow['outcome'], string> = {
  ok: 'text-set',
  lost: 'text-sign font-bold',
  redirect: 'text-dim',
  pending: 'text-warn',
};

const VERDICT_CLASS: Record<Verdict['verdict'], string> = {
  ok: 'text-set',
  violation: 'text-sign font-bold',
  'too-long': 'text-dim',
};

/**
 * The merged client history plus the linearizability checker's verdict. The
 * checker only ever saw the `ok`-outcome rows (raft.ts `completedOps`), so a
 * violation's culprit index is resolved against that same filtered subset —
 * not the full row list.
 */
export function HistoryPanel({
  rows,
  verdict,
  onCheck,
  capped,
}: {
  rows: HistoryRow[];
  verdict: Verdict | null;
  onCheck: () => void;
  capped: boolean;
}) {
  const okRows = rows.filter((r) => r.outcome === 'ok');
  const culpritRow = verdict && verdict.verdict === 'violation' ? okRows[verdict.culprit] : undefined;

  return (
    <section className="border border-line bg-panel rounded p-3 space-y-2 font-mono text-xs w-80">
      <h3 className="font-bold text-fg">Client history</h3>
      <div className="max-h-64 overflow-y-auto overflow-x-auto space-y-0.5">
        {rows.map((r, i) => {
          const isCulprit = culpritRow !== undefined && r.id === culpritRow.id;
          return (
            <p
              key={r.id}
              data-hrow={i}
              data-outcome={r.outcome}
              {...(isCulprit ? { 'data-culprit': 'true' } : {})}
              className={`${OUTCOME_CLASS[r.outcome]} ${isCulprit ? 'bg-sign/10 rounded px-0.5' : ''}`}
            >
              {r.node} {r.op} {r.value ?? '—'} → {r.outcome}
            </p>
          );
        })}
      </div>
      <button className={btn} data-action="check" disabled={capped} onClick={onCheck}>
        check linearizability
      </button>
      {capped && (
        <p className="text-dim">
          history too long to check ({okRows.length} ops &gt; cap {CHECK_CAP}) — the search is exponential; keep exploring.
        </p>
      )}
      {verdict && (
        <p data-verdict={verdict.verdict} className={VERDICT_CLASS[verdict.verdict]}>
          {verdict.verdict === 'ok' && 'linearizable — every read saw a value consistent with some real-time order'}
          {verdict.verdict === 'violation' && 'violation — no real-time-consistent order exists for this history'}
          {verdict.verdict === 'too-long' && 'too long to check'}
        </p>
      )}
    </section>
  );
}
