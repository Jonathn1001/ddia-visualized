import { FRIENDSHIPS, USERS, adjacency, userDocs, type Id, type ModelId } from '../../../modules/models-shared';
import type { ModelPanelInspect } from '../../../modules/models';

/**
 * One data model's rendering (pure props). Variant-dispatched: relational tables,
 * document cards, graph adjacency. Highlights the element the current cursor touched,
 * and shows the op-count, the round-trip count (coral when > 1 — the N+1 tax), a done
 * badge, the result set, and the migration cost when a field was added.
 */
export interface ModelPanelProps {
  model: ModelId;
  label: string;
  view: ModelPanelInspect;
  nicknameAdded?: boolean;
}

const hl = (touched: Id[], ...ids: Id[]) => ids.some((i) => touched.includes(i));

function Relational({ view, nicknameAdded }: { view: ModelPanelInspect; nicknameAdded: boolean }) {
  return (
    <div className="space-y-2">
      <div>
        <div className="text-dim mb-0.5">users{nicknameAdded ? ' + nickname (migrated)' : ''}</div>
        <table className="w-full text-left">
          <tbody>
            {USERS.map((u) => (
              <tr key={u.id} className={hl(view.touched, u.id) ? 'text-set' : ''}>
                <td className="pr-2 text-dim">{u.id}</td>
                <td className="pr-2">{u.name}</td>
                {nicknameAdded && <td className="text-warn">{u.id === 'alice' ? 'ace' : 'NULL'}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <div className="text-dim mb-0.5">friendships (join table)</div>
        <div className="flex flex-wrap gap-1">
          {FRIENDSHIPS.map(([a, b], i) => (
            <span
              key={i}
              className={`px-1 rounded border ${hl(view.touched, a, b) ? 'border-set text-set' : 'border-line text-dim'}`}
            >
              {a}-{b}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function DocumentCards({ view, nicknameAdded }: { view: ModelPanelInspect; nicknameAdded: boolean }) {
  const docs = userDocs();
  return (
    <div className="grid grid-cols-2 gap-1">
      {USERS.map((u) => {
        const d = docs[u.id];
        return (
          <div key={u.id} className={`border rounded p-1 ${hl(view.touched, u.id) ? 'border-set' : 'border-line'}`}>
            <div className="text-fg">
              {u.id}
              {nicknameAdded && u.id === 'alice' && <span className="text-warn"> ·ace</span>}
            </div>
            <div className="text-dim">friends: {d.friendIds.join(',') || '—'}</div>
            <div className="text-dim">likes: {d.likes.join(',') || '—'}</div>
          </div>
        );
      })}
    </div>
  );
}

function GraphAdjacency({ view }: { view: ModelPanelInspect }) {
  const adj = adjacency();
  return (
    <ul className="space-y-0.5">
      {USERS.map((u) => (
        <li key={u.id} className={hl(view.touched, u.id) ? 'text-set' : ''}>
          <span className="text-dim">{u.id}</span> → {adj[u.id].join(', ')}
        </li>
      ))}
    </ul>
  );
}

export function ModelPanel({ model, label, view, nicknameAdded = false }: ModelPanelProps) {
  const rt = view.roundTrips;
  return (
    <section
      data-model={model}
      data-round-trips={rt}
      className="border border-line bg-panel rounded p-3 space-y-2 font-mono text-xs"
    >
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-sm text-fg">{label}</h3>
        <span className={rt > 1 ? 'text-sign' : 'text-set'}>
          {rt} round trip{rt === 1 ? '' : 's'}
        </span>
      </div>
      <div className="flex flex-wrap gap-3 text-dim">
        <span>
          ops <span className="text-fg tabular-nums">{view.cursor}</span>/{view.total}
        </span>
        {view.done && <span className="text-set">done ✓</span>}
        {view.migration > 0 && <span className="text-warn">migration {view.migration}</span>}
      </div>
      <div className="min-h-[6rem]">
        {model === 'relational' && <Relational view={view} nicknameAdded={nicknameAdded} />}
        {model === 'document' && <DocumentCards view={view} nicknameAdded={nicknameAdded} />}
        {model === 'graph' && <GraphAdjacency view={view} />}
      </div>
      {view.done && <div className="text-set">result: {view.result.join(', ') || '(none)'}</div>}
    </section>
  );
}
