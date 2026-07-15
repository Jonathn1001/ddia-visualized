// src/ui/labs/storage/StorageFaultBar.tsx
import type { StorageFault } from '../../../modules/storage-shared';
import { btn } from '../../kit/classes';

const FAULTS: { fault: StorageFault['fault']; label: string }[] = [
  { fault: 'crash-mid-write', label: 'crash mid-write' },
  { fault: 'torn-write', label: 'torn write' },
  { fault: 'disk-full', label: 'disk full' },
  { fault: 'recover', label: 'recover' },
];

export function StorageFaultBar({ onFault }: { onFault: (fault: StorageFault['fault']) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
      <span className="text-dim">storage fault (both engines):</span>
      {FAULTS.map((f) => (
        <button key={f.fault} className={btn} onClick={() => onFault(f.fault)}>
          {f.label}
        </button>
      ))}
    </div>
  );
}
