import { create } from 'zustand';
import type { InFlightMessage, LoggedEvent, NodeId } from '../../engine';

export interface NodeView {
  id: NodeId;
  dead: boolean;
  inspect: Record<string, unknown>;
}

export type MetricsPoint = { time: number } & Record<string, number>;

export interface SimView {
  time: number;
  processed: number;
  pending: number;
  running: boolean;
  speed: number;
  nodes: NodeView[];
  inFlight: InFlightMessage[];
  metricsHistory: MetricsPoint[];
  logTail: LoggedEvent[];
}

/** What SimDriver publishes each batch: full view, one new metrics point. */
export type PublishedView = Omit<SimView, 'metricsHistory'> & { metricsHistory: MetricsPoint[] };

interface SimStore extends SimView {
  publish: (v: PublishedView) => void;
  reset: () => void;
}

const MAX_HISTORY = 300;

const initial: SimView = {
  time: 0,
  processed: 0,
  pending: 0,
  running: false,
  speed: 25,
  nodes: [],
  inFlight: [],
  metricsHistory: [],
  logTail: [],
};

export const useSimStore = create<SimStore>((set) => ({
  ...initial,
  publish: (v) =>
    set((s) => {
      // Trim any points from a scrubbed-away future, then append the new point.
      const kept = s.metricsHistory.filter((p) => p.time < v.time);
      const merged = [...kept, ...v.metricsHistory].slice(-MAX_HISTORY);
      return { ...v, metricsHistory: merged };
    }),
  reset: () => set(() => ({ ...initial, metricsHistory: [], nodes: [], inFlight: [], logTail: [] })),
}));
