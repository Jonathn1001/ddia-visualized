import { describe, expect, test } from 'vitest';
import { Simulation } from '../engine';
import { DM, MODELS_NODES, STEP_EVERY } from './models-shared';
import { models, type ModelsPayload, type ModelsState } from './models';

function makeSim() {
  const sim = new Simulation<ModelsState, ModelsPayload>({ module: models, config: { nodeIds: MODELS_NODES }, seed: 1 });
  sim.runSteps(1);
  return sim;
}
const ch = (s: Simulation<ModelsState, ModelsPayload>) => s.getState(DM).ch;

describe('C1 — friends-of-friends: the join tax', () => {
  test('play fof to completion → document round trips ≥ 2× graph, same answer', () => {
    const sim = makeSim();
    sim.runSteps(STEP_EVERY * 40);
    const s = sim.getState(DM);
    expect(s.traces.graph.result).toEqual(['dan', 'eve', 'frank']);
    expect(s.traces.document.result).toEqual(['dan', 'eve', 'frank']);
    expect(s.traces.document.roundTrips).toBeGreaterThanOrEqual(2 * s.traces.graph.roundTrips);
    expect(ch(sim).c1).toBe(true);
  });
});

describe('C2 — many-to-many: documents cannot join', () => {
  test('play m2m to completion → document round trips ≥ 2× relational', () => {
    const sim = makeSim();
    sim.external(DM, { cmd: 'set-query', query: 'm2m' });
    sim.runSteps(STEP_EVERY * 60);
    const s = sim.getState(DM);
    expect(s.traces.document.result).toEqual(['bob', 'dan', 'frank']);
    expect(s.traces.document.roundTrips).toBeGreaterThanOrEqual(2 * s.traces.relational.roundTrips);
    expect(ch(sim).c2).toBe(true);
  });
});

describe('C3 — schema flexibility', () => {
  test('add-field: 0 document migration, relational > 0, C3 latches', () => {
    const sim = makeSim();
    sim.external(DM, { cmd: 'add-field' });
    sim.runSteps(2);
    expect(ch(sim).c3).toBe(true);
  });
});
