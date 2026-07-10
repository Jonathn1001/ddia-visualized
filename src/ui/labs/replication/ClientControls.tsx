import { useState } from 'react';
import type { NodeId } from '../../../engine';

const btn = 'px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-600 text-xs font-mono';

export function ClientControls({
  nodeIds,
  leader,
  onWrite,
  onRead,
}: {
  nodeIds: NodeId[];
  leader: NodeId;
  onWrite: (key: string, value: string) => void;
  onRead: (node: NodeId, key: string) => void;
}) {
  const [key, setKey] = useState('x');
  const [value, setValue] = useState('1');
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
      <input
        className="w-16 bg-slate-900 border border-slate-600 rounded px-1 py-0.5"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        aria-label="key"
      />
      <input
        className="w-16 bg-slate-900 border border-slate-600 rounded px-1 py-0.5"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label="value"
      />
      <button className={btn} onClick={() => onWrite(key, value)}>
        write → {leader}
      </button>
      {nodeIds.map((id) => (
        <button key={id} className={btn} onClick={() => onRead(id, key)}>
          read @ {id}
        </button>
      ))}
    </div>
  );
}
