// src/ui/labs/storage/LsmView.tsx
import type { LsmInspect } from '../../../modules/lsm';
import { MEMTABLE_CAP } from '../../../modules/storage-shared';

export function LsmView({ inspect }: { inspect: LsmInspect }) {
  const l0 = inspect.sstables.filter((t) => t.level === 0);
  const l1 = inspect.sstables.filter((t) => t.level === 1);
  const levels: [string, typeof l0][] = [['L0', l0], ['L1', l1]];
  return (
    <div className="min-w-56 space-y-2 rounded border border-line bg-panel p-3 font-mono text-xs">
      <div className="flex items-center justify-between">
        <span className="font-bold text-fg">LSM-tree</span>
        {inspect.phase !== 'idle' && <span className="text-warn">{inspect.phase}…</span>}
        {inspect.diskFull && <span className="text-sign">disk full</span>}
      </div>
      <div className="text-dim">
        memtable {inspect.memtable.length}/{MEMTABLE_CAP}
        <div className="mt-0.5 h-2 rounded bg-ink">
          <div className="h-2 rounded bg-set" style={{ width: `${Math.min(100, (inspect.memtable.length / (MEMTABLE_CAP + 1)) * 100)}%` }} />
        </div>
      </div>
      {levels.map(([label, runs]) => (
        <div key={label} className="space-y-0.5">
          {runs.map((t, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-6 text-dim">{label}</span>
              <span className="text-fg">[{t.entries.length} keys · {t.min}…{t.max}]</span>
              <span className="text-dim" title={`bloom bits: ${t.bloom.join(',')}`}>bloom</span>
              {t.torn && <span className="text-sign">torn</span>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
