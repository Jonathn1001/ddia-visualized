import type { Effect, InspectorTree, MetricSample, SimModule } from '../engine/module';
import type { NodeId } from '../engine/events';
import {
  DM,
  MODELS,
  STEP_EVERY,
  FOF_MULT,
  M2M_MULT,
  runGraph,
  runDocument,
  runRelational,
  migrationCost,
  type Id,
  type ModelId,
  type QueryId,
  type Trace,
} from './models-shared';

export type ModelsExternal =
  | { cmd: 'set-query'; query: QueryId; root?: Id }
  | { cmd: 'add-field' }
  | { cmd: 'reset-schema' };
export type ModelsTimer = { t: 'step' };
export type ModelsPayload = ModelsExternal | ModelsTimer;

export interface ModelsState {
  self: NodeId;
  query: QueryId;
  root: Id;
  traces: Record<ModelId, Trace>;
  cursor: Record<ModelId, number>;
  schema: { nicknameAdded: boolean };
  ch: { c1: boolean; c2: boolean; c3: boolean };
}

export interface ModelPanelInspect {
  cursor: number;
  total: number;
  done: boolean;
  roundTrips: number;
  result: Id[];
  touched: Id[];
  migration: number;
}
export interface ModelsInspect {
  query: QueryId;
  root: Id;
  nicknameAdded: boolean;
  models: Record<ModelId, ModelPanelInspect>;
  ch: { c1: boolean; c2: boolean; c3: boolean };
}

function computeTraces(query: QueryId, root: Id): Record<ModelId, Trace> {
  return { relational: runRelational(query, root), document: runDocument(query, root), graph: runGraph(query, root) };
}
const zeroCursor = (): Record<ModelId, number> => ({ relational: 0, document: 0, graph: 0 });
const stepTimer = (): Effect => ({ type: 'timer', delay: STEP_EVERY, payload: { t: 'step' } });
const anyRunning = (s: ModelsState) => MODELS.some((m) => s.cursor[m] < s.traces[m].steps.length);

/** Latch c1/c2 once every model finished and the round-trip gap holds. */
function evalQuery(s: ModelsState): ModelsState['ch'] {
  const done = MODELS.every((m) => s.cursor[m] === s.traces[m].steps.length);
  if (!done) return s.ch;
  const t = s.traces;
  return {
    ...s.ch,
    c1: s.ch.c1 || (s.query === 'fof' && t.document.roundTrips >= FOF_MULT * t.graph.roundTrips),
    c2: s.ch.c2 || (s.query === 'm2m' && t.document.roundTrips >= M2M_MULT * t.relational.roundTrips),
  };
}

export const models: SimModule<ModelsState, ModelsPayload> = {
  id: 'models',
  chaos: [],

  init(nodeId: NodeId): ModelsState {
    const query: QueryId = 'fof';
    const root: Id = 'alice';
    return {
      self: nodeId,
      query,
      root,
      traces: computeTraces(query, root),
      cursor: zeroCursor(),
      schema: { nicknameAdded: false },
      ch: { c1: false, c2: false, c3: false },
    };
  },

  reduce(state, event): [ModelsState, Effect[]] {
    if (event.kind === 'init') return [state, [stepTimer()]];

    if (event.kind === 'timer') {
      const cursor = { ...state.cursor };
      for (const m of MODELS) if (cursor[m] < state.traces[m].steps.length) cursor[m] += 1;
      let next: ModelsState = { ...state, cursor };
      next = { ...next, ch: evalQuery(next) };
      return [next, anyRunning(next) ? [stepTimer()] : []];
    }

    if (event.kind === 'external') {
      const p = event.payload as ModelsExternal;
      if (p.cmd === 'set-query') {
        const root = p.root ?? state.root;
        const resetCh = { ...state.ch, ...(p.query === 'fof' ? { c1: false } : { c2: false }) };
        return [
          { ...state, query: p.query, root, traces: computeTraces(p.query, root), cursor: zeroCursor(), ch: resetCh },
          [stepTimer()],
        ];
      }
      if (p.cmd === 'add-field') {
        const c3 =
          migrationCost('document', true) === 0 &&
          migrationCost('graph', true) === 0 &&
          migrationCost('relational', true) > 0;
        return [{ ...state, schema: { nicknameAdded: true }, ch: { ...state.ch, c3 } }, []];
      }
      if (p.cmd === 'reset-schema') return [{ ...state, schema: { nicknameAdded: false } }, []];
    }
    return [state, []];
  },

  metrics(states): MetricSample[] {
    const s = states.get(DM);
    if (!s) return [];
    return MODELS.map((m) => ({ name: `${m}-ops`, value: s.cursor[m] }));
  },

  inspect(state): InspectorTree {
    const panel = (m: ModelId): ModelPanelInspect => {
      const t = state.traces[m];
      const cursor = state.cursor[m];
      const done = cursor === t.steps.length;
      return {
        cursor,
        total: t.steps.length,
        done,
        roundTrips: t.roundTrips,
        result: done ? t.result : [],
        touched: cursor > 0 && cursor <= t.steps.length ? t.steps[cursor - 1].touched : [],
        migration: migrationCost(m, state.schema.nicknameAdded),
      };
    };
    const tree: ModelsInspect = {
      query: state.query,
      root: state.root,
      nicknameAdded: state.schema.nicknameAdded,
      models: { relational: panel('relational'), document: panel('document'), graph: panel('graph') },
      ch: state.ch,
    };
    return tree as unknown as InspectorTree;
  },
};
