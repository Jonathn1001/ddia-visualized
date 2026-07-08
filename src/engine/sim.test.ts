import { expect, test } from 'vitest';
import { Simulation } from './sim';
import { counter, echo, chatty } from './fixtures';

test('timer effects fire in virtual time and advance the clock', () => {
  const sim = new Simulation({ module: counter, config: { nodeIds: ['a'] }, seed: 1 });
  sim.runUntil(100);
  expect(sim.getState('a').count).toBe(3);
  expect(sim.time).toBe(100); // clock advances to runUntil bound
  // init@0 + three timers@10/20/30
  expect(sim.eventLog.map((e) => [e.kind, e.time])).toEqual([
    ['init', 0],
    ['timer', 10],
    ['timer', 20],
    ['timer', 30],
  ]);
});

test('send effects deliver through the network with latency and from-field', () => {
  const sim = new Simulation({ module: echo, config: { nodeIds: ['a', 'b'] }, seed: 42 });
  sim.runUntil(100);
  expect(sim.getState('b').got).toEqual(['ping']);
  expect(sim.getState('a').got).toEqual(['pong']);
  const msg = sim.eventLog.find((e) => e.kind === 'message' && e.target === 'b')!;
  expect(msg.from).toBe('a');
  expect(msg.time).toBeGreaterThanOrEqual(1); // network latency applied
});

test('external() enqueues a user action at current virtual time', () => {
  const sim = new Simulation({ module: echo, config: { nodeIds: ['a', 'b'] }, seed: 1 });
  sim.runUntil(50);
  sim.external('a', { cmd: 'poke' });
  const before = sim.eventLog.length;
  sim.step();
  expect(sim.eventLog.length).toBe(before + 1);
  const e = sim.eventLog[sim.eventLog.length - 1];
  expect(e.kind).toBe('external');
  expect(e.time).toBe(50);
});

test('control kill: a dead node consumes events without reducing', () => {
  const sim = new Simulation({ module: echo, config: { nodeIds: ['a', 'b'] }, seed: 42 });
  sim.control({ type: 'kill', node: 'b' });
  sim.runUntil(100);
  expect(sim.getState('b').got).toEqual([]); // ping arrived but b was dead
  expect(sim.getState('a').got).toEqual([]); // so no pong either
});

test('control partition: cross-partition messages never arrive', () => {
  const sim = new Simulation({ module: echo, config: { nodeIds: ['a', 'b'] }, seed: 42 });
  sim.control({ type: 'partition', groups: [['a'], ['b']] });
  sim.runUntil(100);
  expect(sim.getState('b').got).toEqual([]);
});

test('processed counts every consumed event; pending exposes queue size', () => {
  const sim = new Simulation({ module: chatty, config: { nodeIds: ['a', 'b', 'c'] }, seed: 7 });
  expect(sim.pending).toBe(3); // three init events
  sim.runSteps(50);
  expect(sim.processed).toBe(50);
  expect(sim.pending).toBeGreaterThan(0); // chatty never goes quiet
});

test('getState throws for unknown node ids', () => {
  const sim = new Simulation({ module: counter, config: { nodeIds: ['a'] }, seed: 1 });
  expect(() => sim.getState('nope')).toThrow(/unknown node/);
});
