import { describe, expect, test } from 'vitest';
import { Simulation } from '../engine';
import { DM, MODELS, MODELS_NODES, STEP_EVERY, USER_IDS, runDocument } from './models-shared';
import { models, type ModelsInspect, type ModelsPayload, type ModelsState } from './models';

function makeSim(seed = 1) {
  return new Simulation<ModelsState, ModelsPayload>({ module: models, config: { nodeIds: MODELS_NODES }, seed });
}
const dm = (s: Simulation<ModelsState, ModelsPayload>) => s.getState(DM);
const view = (s: Simulation<ModelsState, ModelsPayload>) => models.inspect(dm(s)) as unknown as ModelsInspect;

// ---- Task 2: boot + stepping + set-query ----
describe('boot + stepping', () => {
  test('init defaults to fof(alice), cursors at 0', () => {
    const sim = makeSim();
    sim.runSteps(1);
    const v = view(sim);
    expect(v.query).toBe('fof');
    for (const m of MODELS) expect(v.models[m].cursor).toBe(0);
  });
  test('stepping advances every not-done cursor to its trace end', () => {
    const sim = makeSim();
    sim.runSteps(1);
    sim.runSteps(STEP_EVERY * 40);
    const v = view(sim);
    for (const m of MODELS) expect(v.models[m].done).toBe(true);
    expect(v.models.document.roundTrips).toBeGreaterThan(v.models.graph.roundTrips);
  });
});

describe('set-query recomputes and resets', () => {
  test('switching to m2m resets cursors and swaps traces', () => {
    const sim = makeSim();
    sim.runSteps(1);
    sim.runSteps(STEP_EVERY * 40);
    sim.external(DM, { cmd: 'set-query', query: 'm2m' });
    sim.runSteps(2);
    const v = view(sim);
    expect(v.query).toBe('m2m');
    expect(v.models.document.cursor).toBeLessThanOrEqual(1);
    expect(v.models.document.total).toBe(runDocument('m2m', 'alice').steps.length);
  });
});

// ---- Task 3: schema flexibility ----
describe('schema flexibility (C3 scenario)', () => {
  test('add-field: relational migration > 0, document/graph = 0', () => {
    const sim = makeSim();
    sim.runSteps(1);
    sim.external(DM, { cmd: 'add-field' });
    sim.runSteps(2);
    const v = view(sim);
    expect(v.nicknameAdded).toBe(true);
    expect(v.models.document.migration).toBe(0);
    expect(v.models.graph.migration).toBe(0);
    expect(v.models.relational.migration).toBe(USER_IDS.length);
  });
  test('reset-schema clears it', () => {
    const sim = makeSim();
    sim.runSteps(1);
    sim.external(DM, { cmd: 'add-field' });
    sim.runSteps(1);
    sim.external(DM, { cmd: 'reset-schema' });
    sim.runSteps(1);
    expect(view(sim).nicknameAdded).toBe(false);
    expect(view(sim).models.relational.migration).toBe(0);
  });
});

// ---- Task 4: challenge flags + epoch gating ----
describe('challenge flags', () => {
  test('C1 latches after fof plays to completion', () => {
    const sim = makeSim();
    sim.runSteps(1);
    sim.runSteps(STEP_EVERY * 40);
    expect(dm(sim).ch.c1).toBe(true);
  });
  test('C2 latches after m2m plays to completion', () => {
    const sim = makeSim();
    sim.runSteps(1);
    sim.external(DM, { cmd: 'set-query', query: 'm2m' });
    sim.runSteps(STEP_EVERY * 60);
    expect(dm(sim).ch.c2).toBe(true);
  });
  test('C3 latches on add-field', () => {
    const sim = makeSim();
    sim.runSteps(1);
    sim.external(DM, { cmd: 'add-field' });
    sim.runSteps(2);
    expect(dm(sim).ch.c3).toBe(true);
  });
  test('set-query fof resets C1 epoch', () => {
    const sim = makeSim();
    sim.runSteps(1);
    sim.runSteps(STEP_EVERY * 40);
    expect(dm(sim).ch.c1).toBe(true);
    sim.external(DM, { cmd: 'set-query', query: 'fof' });
    sim.runSteps(2);
    expect(dm(sim).ch.c1).toBe(false);
  });
});
