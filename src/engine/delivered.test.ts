import { expect, test } from 'vitest';
import { Simulation } from './sim';
import { echo, type EchoState } from './fixtures';

test('normal delivery: delivered true, no dropReason', () => {
  const sim = new Simulation<EchoState>({ module: echo, config: { nodeIds: ['a', 'b'] }, seed: 1 });
  sim.runUntil(100);
  const msg = sim.eventLog.find((e) => e.kind === 'message' && e.target === 'b');
  expect(msg).toMatchObject({ delivered: true });
  expect(msg?.dropReason).toBeUndefined();
});

test('dead target: delivered false, dropReason dead-node', () => {
  const sim = new Simulation<EchoState>({ module: echo, config: { nodeIds: ['a', 'b'] }, seed: 1 });
  sim.control({ type: 'kill', node: 'b' }); // control at t=0 precedes any message delivery (t>=1)
  sim.runUntil(100);
  const msg = sim.eventLog.find((e) => e.kind === 'message' && e.target === 'b');
  expect(msg).toMatchObject({ delivered: false, dropReason: 'dead-node' });
  const ctrl = sim.eventLog.find((e) => e.kind === 'control');
  expect(ctrl?.delivered).toBe(true); // control events always "deliver" to the engine
});

test('partition formed mid-flight: delivered false, dropReason partition', () => {
  const sim = new Simulation<EchoState>({
    module: echo,
    config: { nodeIds: ['a', 'b'] },
    seed: 1,
    network: { latency: [5, 5] },
  });
  sim.runSteps(2); // inits processed; ping in flight for t=5
  sim.control({ type: 'partition', groups: [['a'], ['b']] }); // t=0 control beats t=5 delivery
  sim.runUntil(50);
  const msg = sim.eventLog.find((e) => e.kind === 'message');
  expect(msg).toMatchObject({ delivered: false, dropReason: 'partition' });
});

test('deadNodes reflects kill and revive', () => {
  const sim = new Simulation<EchoState>({ module: echo, config: { nodeIds: ['a', 'b'] }, seed: 1 });
  expect(sim.deadNodes()).toEqual([]);
  sim.control({ type: 'kill', node: 'b' });
  sim.runSteps(3);
  expect(sim.deadNodes()).toEqual(['b']);
  sim.control({ type: 'revive', node: 'b' });
  sim.runSteps(1);
  expect(sim.deadNodes()).toEqual([]);
});
