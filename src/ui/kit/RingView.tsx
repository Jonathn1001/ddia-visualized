import type { NodeId } from '../../engine';
import { buildRing, HOTSPOT_MIN_KEYS, keyPos } from '../../modules/hashring';

/** Stable per-node hues, indexed by pool position (same precedent as MetricsPanel's palette). */
const NODE_COLORS = ['#0ea5e9', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

const CX = 160;
const CY = 160;
const R = 120;

export interface KeyPlacement {
  key: string;
  owner: NodeId;
}

function angleOf(pos: number): number {
  return (pos / 0x100000000) * 2 * Math.PI - Math.PI / 2;
}

function xy(angle: number, radius: number): { x: number; y: number } {
  return { x: CX + radius * Math.cos(angle), y: CY + radius * Math.sin(angle) };
}

/**
 * The consistent-hash ring (DESIGN_PLAN Ch6): vnode ticks and key dots at
 * their keyPos angles, colored by owning node, plus per-member load bars.
 * Migration renders as recolor — a dot's position never changes, only its fill.
 */
export function RingView({
  pool,
  members,
  vnodes,
  placements,
}: {
  pool: NodeId[];
  members: NodeId[];
  vnodes: number;
  placements: KeyPlacement[];
}) {
  const colorOf = (node: NodeId) => NODE_COLORS[pool.indexOf(node) % NODE_COLORS.length];
  const ring = buildRing(members, vnodes);
  const loads = new Map<NodeId, number>(members.map((m) => [m, 0]));
  for (const p of placements) loads.set(p.owner, (loads.get(p.owner) ?? 0) + 1);
  const total = placements.length;
  const fair = members.length > 0 ? total / members.length : 0;
  const maxLoad = Math.max(1, ...loads.values());

  return (
    <div className="flex shrink-0 items-start gap-4">
      <svg viewBox="0 0 320 320" className="w-[320px] select-none">
        <circle cx={CX} cy={CY} r={R} className="fill-none stroke-line" strokeWidth={2} />
        {ring.map((v, i) => {
          const a = angleOf(v.pos);
          const p1 = xy(a, R - 6);
          const p2 = xy(a, R + 6);
          return (
            <line
              key={`${v.node}-${i}`}
              data-vnode={v.node}
              x1={p1.x}
              y1={p1.y}
              x2={p2.x}
              y2={p2.y}
              stroke={colorOf(v.node)}
              strokeWidth={3}
            />
          );
        })}
        {placements.map((p) => {
          const q = xy(angleOf(keyPos(p.key)), R - 16);
          return <circle key={p.key} data-key={p.key} cx={q.x} cy={q.y} r={3.5} fill={colorOf(p.owner)} />;
        })}
      </svg>
      <div className="space-y-1 pt-2 font-mono text-xs">
        <p className="text-dim">load ({total} keys)</p>
        {members.map((m) => {
          const load = loads.get(m) ?? 0;
          const hot = total >= HOTSPOT_MIN_KEYS && fair > 0 && load >= 2 * fair;
          return (
            <div key={m} data-load={m} className="flex items-center gap-2">
              <span className="w-4" style={{ color: colorOf(m) }}>
                {m}
              </span>
              <span className={`w-6 text-right ${hot ? 'text-warn font-bold' : 'text-fg'}`}>{load}</span>
              <div className="h-2 w-32 rounded bg-ink">
                <div
                  className="h-2 rounded"
                  style={{ width: `${(load / maxLoad) * 100}%`, backgroundColor: colorOf(m) }}
                />
              </div>
              {hot && <span className="text-warn">hot</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
