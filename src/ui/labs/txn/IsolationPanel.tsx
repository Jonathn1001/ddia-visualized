// src/ui/labs/txn/IsolationPanel.tsx
import type { TxnInspect } from '../../../modules/txn';
import { TXN_IDS } from '../../../modules/txn-shared';

const STATUS_CLASS: Record<string, string> = {
  idle: 'text-dim border-line',
  active: 'text-warn border-warn',
  waiting: 'text-dim border-line border-dashed',
  committed: 'text-set border-set',
  aborted: 'text-sign border-sign',
};

/** One isolation level's world: its txns, its store as it sees it, its sins. */
export function IsolationPanel({ inspect }: { inspect: TxnInspect }) {
  return (
    <section className="border border-line bg-panel rounded p-3 space-y-2 font-mono text-xs w-56">
      <header>
        <h3 className="font-bold text-fg">{inspect.level}</h3>
        <p className="text-dim">{inspect.credo}</p>
      </header>

      <div className="flex gap-2">
        {TXN_IDS.map((id) => (
          <span
            key={id}
            data-txn={id}
            data-status={inspect.txns[id].status}
            className={`border rounded px-1 ${STATUS_CLASS[inspect.txns[id].status]}`}
          >
            {id} {inspect.txns[id].status}
          </span>
        ))}
      </div>
      {TXN_IDS.map(
        (id) =>
          inspect.txns[id].abortReason && (
            <p key={id} className="text-sign">
              {id}: {inspect.txns[id].abortReason}
            </p>
          ),
      )}

      <div className="space-y-0.5">
        {Object.entries(inspect.committed).map(([key, value]) => (
          <div key={key} data-key={key} className="flex flex-wrap gap-1 items-baseline">
            <span className="text-dim">{key}=</span>
            <span className="text-fg">{value}</span>
            {(inspect.pending[key] ?? []).map((p, i) => (
              <span key={i} className="text-warn">
                ({p.txn}: {p.value} uncommitted)
              </span>
            ))}
          </div>
        ))}
      </div>

      {inspect.queue.length > 0 && (
        <div>
          <p className="text-dim">waiting (one txn at a time):</p>
          {inspect.queue.map((label, i) => (
            <p key={i} data-queued={i} className="text-dim/80 pl-2">
              {label}
            </p>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-1">
        {inspect.anomalies.map((a, i) => (
          <span key={i} data-anomaly={a.type} title={a.detail} className="border border-sign text-sign rounded px-1">
            {a.type}
          </span>
        ))}
      </div>
    </section>
  );
}
