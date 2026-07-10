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
        <>
          <button
            className={btn}
            onClick={() => onAction({ type: 'partition', groups: [[nodeIds[0]], nodeIds.slice(1)] })}
          >
            isolate {nodeIds[0]}
          </button>
          <button className={btn} onClick={() => onAction({ type: 'heal' })}>
            heal
          </button>
        </>
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
