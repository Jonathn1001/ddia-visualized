import type { NodeId } from './events';
import type { SeededRng } from './rng';

/** What a reducer may ask the engine to do. Interpreted by Simulation. */
export type Effect =
  | { type: 'send'; to: NodeId; payload: unknown }
  | { type: 'timer'; delay: number; payload: unknown };

export interface ModuleConfig {
  nodeIds: NodeId[];
  params?: Record<string, unknown>;
}

export type ChaosCapability =
  | 'kill-node'
  | 'partition'
  | 'delay'
  | 'drop'
  | 'duplicate'
  | 'clock-skew'
  | 'crash-mid-write'
  | 'torn-write'
  | 'disk-full';

export interface MetricSample {
  name: string;
  value: number;
}

export type InspectorTree = Record<string, unknown>;

/** The event shape a module's reduce() receives. 'control' never reaches modules. */
export interface ModuleEvent<P = unknown> {
  kind: 'init' | 'message' | 'timer' | 'external';
  self: NodeId;
  from?: NodeId;
  /** Virtual time at which this event is being processed. */
  time: number;
  payload: P;
}

/**
 * Module contract v0.2 — one module per DDIA lab (DESIGN_PLAN §5).
 * S = per-node state (plain serializable object). P = payload union.
 * Refinements over the §5 draft: init receives its nodeId; reduce receives
 * the sim RNG (state is part of snapshots, so determinism holds); metrics
 * receives all node states.
 * v0.2: events carry time; metrics receives time (rates need a window).
 */
export interface SimModule<S, P = unknown> {
  id: string;
  chaos: ChaosCapability[];
  init(nodeId: NodeId, config: ModuleConfig, rng: SeededRng): S;
  reduce(state: S, event: ModuleEvent<P>, rng: SeededRng): [S, Effect[]];
  metrics(states: Map<NodeId, S>, time: number): MetricSample[];
  inspect(state: S): InspectorTree;
}
