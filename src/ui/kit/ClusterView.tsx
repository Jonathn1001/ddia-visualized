import { motion } from 'motion/react';
import type { InFlightMessage, NodeId } from '../../engine';
import type { NodeView } from '../bridge/simStore';

const R = 120;
const CX = 180;
const CY = 160;
const NODE_R = 26;

function pos(i: number, n: number): { x: number; y: number } {
  const a = (2 * Math.PI * i) / n - Math.PI / 2;
  return { x: CX + R * Math.cos(a), y: CY + R * Math.sin(a) };
}

/** SVG cluster ring: nodes + message dots interpolated along virtual time. */
export function ClusterView({
  nodes,
  inFlight,
  time,
  onNodeClick,
}: {
  nodes: NodeView[];
  inFlight: InFlightMessage[];
  time: number;
  onNodeClick?: (id: NodeId) => void;
}) {
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  return (
    <svg viewBox="0 0 360 320" className="w-[360px] shrink-0 select-none">
      {inFlight.map((m, k) => {
        const fi = index.get(m.from);
        const ti = index.get(m.target);
        if (fi === undefined || ti === undefined) return null;
        const f = pos(fi, nodes.length);
        const t = pos(ti, nodes.length);
        const p =
          m.deliverAt === m.sentAt ? 1 : Math.min(1, Math.max(0, (time - m.sentAt) / (m.deliverAt - m.sentAt)));
        return (
          <circle key={k} cx={f.x + (t.x - f.x) * p} cy={f.y + (t.y - f.y) * p} r={4} className="fill-amber-400" />
        );
      })}
      {nodes.map((n, i) => {
        const q = pos(i, nodes.length);
        return (
          <g key={n.id} onClick={() => onNodeClick?.(n.id)} className="cursor-pointer">
            <motion.circle
              cx={q.x}
              cy={q.y}
              r={NODE_R}
              animate={{ opacity: n.dead ? 0.25 : 1 }}
              className="fill-sky-600"
            />
            <text x={q.x} y={q.y + 5} textAnchor="middle" className="fill-white text-xs font-mono">
              {n.id}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
