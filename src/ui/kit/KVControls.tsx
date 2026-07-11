import { useState } from 'react';
import type { NodeId } from '../../engine';
import { btn, inputBox } from './classes';

/** Key/value client controls: write and read buttons per declared target node. */
export function KVControls({
  writeTargets,
  readTargets,
  onWrite,
  onRead,
}: {
  writeTargets: NodeId[];
  readTargets: NodeId[];
  onWrite: (node: NodeId, key: string, value: string) => void;
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
      {writeTargets.map((id) => (
        <button key={`w-${id}`} className={btn} onClick={() => onWrite(id, key, value)}>
          write @ {id}
        </button>
      ))}
      {readTargets.map((id) => (
        <button key={`r-${id}`} className={btn} onClick={() => onRead(id, key)}>
          read @ {id}
        </button>
      ))}
    </div>
  );
}
