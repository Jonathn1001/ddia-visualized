import { Legend, Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts';
import type { MetricsPoint } from '../bridge/simStore';

const COLORS = ['#0ea5e9', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6'];

/** Live metrics chart — one stepped line per metric name (DESIGN_PLAN §4: countable numbers). */
export function MetricsPanel({ history }: { history: MetricsPoint[] }) {
  const last = history[history.length - 1];
  const keys = last ? Object.keys(last).filter((k) => k !== 'time') : [];
  return (
    <LineChart width={440} height={200} data={history}>
      <XAxis dataKey="time" tick={{ fontSize: 10 }} />
      <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
      <Tooltip />
      <Legend />
      {keys.map((k, i) => (
        <Line
          key={k}
          type="stepAfter"
          dataKey={k}
          dot={false}
          isAnimationActive={false}
          stroke={COLORS[i % COLORS.length]}
        />
      ))}
    </LineChart>
  );
}
