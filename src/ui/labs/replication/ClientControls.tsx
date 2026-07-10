import { useState } from 'react';
import type { NodeId } from '../../../engine';
import { btn, inputBox } from '../../kit/classes';

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
        className={`w-16 ${inputBox}`}
        value={key}
        onChange={(e) => setKey(e.target.value)}
        aria-label="key"
      />
      <input
        className={`w-16 ${inputBox}`}
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
