import type { StoreInspect } from '../../../modules/lease';

const OUTCOME_CLASS: Record<string, string> = {
  ok: 'text-set',
  stale: 'text-sign font-bold',
  rejected: 'text-warn',
};

/** What actually got written — and which writes were lies. */
export function StorePanel({ store }: { store: StoreInspect }) {
  return (
    <section className="border border-line bg-panel rounded p-3 space-y-2 font-mono text-xs w-72">
      <h3 className="font-bold text-fg">Store (shared resource)</h3>
      <p>
        value: <span className="text-fg">{store.value ?? '—'}</span>{' '}
        <span className="text-dim">last token {store.lastToken}</span>
      </p>
      <p className={store.fencing ? 'text-set' : 'text-dim'}>
        fencing {store.fencing ? 'on — writes below token watermark are rejected' : 'off'}
      </p>
      <div className="space-y-0.5">
        {store.history.map((h, i) => (
          <p key={i} data-row={i} data-outcome={h.outcome} className={OUTCOME_CLASS[h.outcome]}>
            t{h.at} {h.writer} token {h.token} → {h.outcome}
          </p>
        ))}
      </div>
      <p className="text-dim">
        ok {store.writesOk} · <span className={store.staleAccepts > 0 ? 'text-sign' : ''}>stale {store.staleAccepts}</span> · rejected {store.rejects}
      </p>
    </section>
  );
}
