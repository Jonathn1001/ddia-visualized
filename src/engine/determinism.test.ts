import { expect, test } from 'vitest';
import { Simulation } from './sim';
import { hashEventLog } from './hash';
import { chatty } from './fixtures';

const run = (seed: number): string => {
  const sim = new Simulation({
    module: chatty,
    config: { nodeIds: ['a', 'b', 'c'] },
    seed,
    network: { latency: [1, 10], dropRate: 0.05, duplicateRate: 0.05 },
  });
  sim.runSteps(500);
  sim.control({ type: 'partition', groups: [['a'], ['b', 'c']] });
  sim.runSteps(500);
  sim.control({ type: 'heal' });
  sim.runSteps(1000);
  return hashEventLog(sim.eventLog);
};

test('DoD: same seed + same action sequence → identical hash across 100 runs', () => {
  const first = run(42);
  for (let i = 0; i < 99; i++) expect(run(42)).toBe(first);
});

test('different seeds diverge', () => {
  expect(run(1)).not.toBe(run(2));
});
