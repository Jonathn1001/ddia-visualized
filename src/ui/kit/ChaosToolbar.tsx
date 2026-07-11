import { useState } from 'react';
import type { ChaosCapability, ControlAction, NodeId } from '../../engine';
import { btn } from './classes';

/** Renders only the controls the module declares (DESIGN_PLAN §5). */
export function ChaosToolbar({
  caps,
  nodeIds,
  deadNodes,
  onAction,
}: {
  caps: ChaosCapability[];
  nodeIds: NodeId[];
  deadNodes: NodeId[];
  onAction: (a: ControlAction) => void;
}) {
  // Local selection for the partition split: checked nodes become one group,
  // the rest the other. Lets any subset be isolated (e.g. the 5.3 sloppy-loss
  // script's D,E | A,B,C), not just the first node.
  const [isolated, setIsolated] = useState<NodeId[]>([]);
  const toggle = (id: NodeId) =>
    setIsolated((s) => (s.includes(id) ? s.filter((n) => n !== id) : [...s, id]));
  return (
    <div className="flex flex-wrap items-center gap-2">
      {caps.includes('kill-node') &&
        nodeIds.map((id) =>
          deadNodes.includes(id) ? (
            <button key={id} className={btn} onClick={() => onAction({ type: 'revive', node: id })}>
              revive {id}
            </button>
          ) : (
            <button key={id} className={btn} onClick={() => onAction({ type: 'kill', node: id })}>
              kill {id}
            </button>
          ),
        )}
      {caps.includes('partition') && (
        <div className="flex flex-wrap items-center gap-1 text-xs font-mono">
          <span className="text-dim">partition:</span>
          {nodeIds.map((id) => (
            <label key={`iso-${id}`} className="flex items-center gap-0.5">
              <input
                type="checkbox"
                aria-label={`isolate ${id}`}
                checked={isolated.includes(id)}
                onChange={() => toggle(id)}
              />
              {id}
            </label>
          ))}
          <button
            className={btn}
            disabled={isolated.length === 0 || isolated.length === nodeIds.length}
            onClick={() =>
              onAction({
                type: 'partition',
                groups: [isolated, nodeIds.filter((n) => !isolated.includes(n))],
              })
            }
          >
            split
          </button>
          <button
            className={btn}
            onClick={() => {
              onAction({ type: 'heal' });
              setIsolated([]);
            }}
          >
            heal
          </button>
        </div>
      )}
      {caps.includes('delay') && (
        <label className="text-xs font-mono flex items-center gap-1">
          latency max
          <input
            type="range"
            min={1}
            max={300}
            defaultValue={10}
            onChange={(e) => onAction({ type: 'net', opts: { latency: [1, Number(e.target.value)] } })}
          />
        </label>
      )}
      {caps.includes('drop') && (
        <label className="text-xs font-mono flex items-center gap-1">
          drop %
          <input
            type="range"
            min={0}
            max={90}
            defaultValue={0}
            onChange={(e) => onAction({ type: 'net', opts: { dropRate: Number(e.target.value) / 100 } })}
          />
        </label>
      )}
    </div>
  );
}
