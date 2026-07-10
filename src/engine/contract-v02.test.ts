import { expect, test } from 'vitest';
import { Simulation } from './sim';
import type { InspectorTree, SimModule } from './module';
import type { NodeId } from './events';

interface ProbeState {
  self: NodeId;
  times: number[];
}

const probe: SimModule<ProbeState, null> = {
  id: 'probe',
  chaos: [],
  init: (nodeId) => ({ self: nodeId, times: [] }),
  reduce: (state, event) => {
    const next = { ...state, times: [...state.times, event.time] };
    if (event.kind === 'init') return [next, [{ type: 'timer', delay: 25, payload: null }]];
    return [next, []];
  },
  metrics: (states, time) => [{ name: 'now', value: time }],
  inspect: (s) => ({ ...s }) as InspectorTree,
};

test('reduce receives the virtual time of each event', () => {
  const sim = new Simulation<ProbeState, null>({ module: probe, config: { nodeIds: ['p'] }, seed: 3 });
  sim.runUntil(100);
  expect(sim.getState('p').times).toEqual([0, 25]); // init at t=0, timer at t=25
});

test('metrics receives virtual time', () => {
  const sim = new Simulation<ProbeState, null>({ module: probe, config: { nodeIds: ['p'] }, seed: 3 });
  sim.runUntil(100);
  const states = new Map([['p', sim.getState('p')]]);
  expect(sim.module.metrics(states, sim.time)).toEqual([{ name: 'now', value: 100 }]);
});

test("'net' control deep-clones opts — caller mutation cannot reach inside", () => {
  const sim = new Simulation<ProbeState, null>({ module: probe, config: { nodeIds: ['p'] }, seed: 3 });
  const opts = { latency: [5, 5] as [number, number] };
  sim.control({ type: 'net', opts });
  sim.runSteps(2); // init + control
  opts.latency[1] = 99;
  expect(sim.network.opts.latency[1]).toBe(5);
});
