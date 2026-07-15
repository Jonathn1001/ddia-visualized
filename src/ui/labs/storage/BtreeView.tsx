// src/ui/labs/storage/BtreeView.tsx
import type { BtreeInspect } from '../../../modules/btree';

export function BtreeView({ inspect }: { inspect: BtreeInspect }) {
  const root = inspect.pages.find((p) => p.id === inspect.rootId);
  const leaves = inspect.pages.filter((p) => p.leaf).sort((a, b) => ((a.keys[0] ?? '') < (b.keys[0] ?? '') ? -1 : 1));
  return (
    <div className="min-w-56 space-y-2 rounded border border-line bg-panel p-3 font-mono text-xs">
      <div className="flex items-center justify-between">
        <span className="font-bold text-fg">B-tree · height {inspect.height}</span>
        {inspect.phase !== 'idle' && <span className="text-warn">{inspect.phase}…</span>}
        {inspect.diskFull && <span className="text-sign">disk full</span>}
      </div>
      {root && !root.leaf && (
        <div className="text-dim">root [{root.keys.join(' | ')}]</div>
      )}
      <div className="flex flex-wrap gap-2">
        {leaves.map((p) => (
          <div key={p.id} className="rounded border border-line px-2 py-1 text-fg">
            {p.keys.map((k, i) => (p.vals[i] === null ? <s key={k} className="text-dim">{k}</s> : <span key={k}>{k} </span>))}
          </div>
        ))}
      </div>
    </div>
  );
}
