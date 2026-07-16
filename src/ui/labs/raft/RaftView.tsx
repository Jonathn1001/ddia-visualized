// src/ui/labs/raft/RaftView.tsx
import type { RaftInspect } from '../../../modules/raft';

const ROLE_CLASS: Record<RaftInspect['role'], string> = {
  leader: 'text-set font-bold',
  candidate: 'text-warn font-bold',
  follower: 'text-dim',
};

/** Five node columns: role/term/votedFor, log entries, kv readout (DESIGN_PLAN Ch9). */
export function RaftView({ nodes, deadNodes }: { nodes: RaftInspect[]; deadNodes: string[] }) {
  return (
    <div className="overflow-x-auto">
      <div className="flex flex-nowrap gap-2">
        {nodes.map((n) => {
          const dead = deadNodes.includes(n.id);
          return (
            <div
              key={n.id}
              data-node={n.id}
              data-role={n.role}
              {...(dead ? { 'data-dead': 'true' } : {})}
              className={`border border-line bg-panel rounded p-2 space-y-1 w-40 shrink-0 font-mono text-xs ${dead ? 'opacity-40' : ''}`}
            >
              <p className="text-fg">
                {n.id} <span className={ROLE_CLASS[n.role]}>{n.role}</span>
              </p>
              <p className="text-dim">term {n.term}</p>
              <p className="text-dim">voted: {n.votedFor ?? '—'}</p>
              <div className="flex flex-wrap gap-0.5">
                {n.log.map((e, i) => {
                  const committed = i < n.commitIndex;
                  return (
                    <span
                      key={i}
                      data-entry
                      {...(committed ? { 'data-committed': 'true' } : {})}
                      className={`inline-block border border-line rounded px-1 ${committed ? 'text-set' : 'text-dim'}`}
                    >
                      t{e.term}:{e.value}
                    </span>
                  );
                })}
              </div>
              <p className="text-fg">kv: {n.kv}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
