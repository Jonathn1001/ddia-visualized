import { describe, test } from 'vitest';
import fc from 'fast-check';
import { Simulation } from '../engine/sim';
import { hashEventLog } from '../engine/hash';
import { pingPong } from './pingpong';

const NODES = ['n0', 'n1', 'n2'];
// Fixed fc seed: reproducible in CI; bump numRuns locally when hunting bugs.
const FC = { seed: 20260708, numRuns: 25 };

describe('ping-pong properties', () => {
  test('determinism: same seed + same chaos schedule → same hash', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2 ** 31 - 1 }),
        fc.double({ min: 0, max: 0.3, noNaN: true }),
        fc.double({ min: 0, max: 0.3, noNaN: true }),
        (seed, drop, dup) => {
          const run = () => {
            const sim = new Simulation({
              module: pingPong,
              config: { nodeIds: NODES },
              seed,
              network: { latency: [1, 20], dropRate: drop, duplicateRate: dup },
            });
            sim.runSteps(1000);
            sim.control({ type: 'partition', groups: [['n0'], ['n1', 'n2']] });
            sim.runSteps(500);
            sim.control({ type: 'heal' });
            sim.runSteps(1500);
            return hashEventLog(sim.eventLog);
          };
          return run() === run();
        },
      ),
      FC,
    );
  });

  test('safety: delivered tokens never regress on any node, under any drop/dup mix', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2 ** 31 - 1 }),
        fc.double({ min: 0, max: 0.4, noNaN: true }),
        fc.double({ min: 0, max: 0.4, noNaN: true }),
        (seed, drop, dup) => {
          const sim = new Simulation({
            module: pingPong,
            config: { nodeIds: NODES },
            seed,
            network: { latency: [1, 30], dropRate: drop, duplicateRate: dup },
          });
          const last: Record<string, number> = { n0: 0, n1: 0, n2: 0 };
          for (let i = 0; i < 3000; i++) {
            if (!sim.step()) break;
            for (const id of NODES) {
              const d = sim.getState(id).lastDelivered;
              if (d < last[id]) return false; // regression = engine or dedupe bug
              last[id] = d;
            }
          }
          return true;
        },
      ),
      FC,
    );
  });

  test('progress: with a clean network the token keeps circulating', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), (seed) => {
        const sim = new Simulation({
          module: pingPong,
          config: { nodeIds: NODES },
          seed,
          network: { latency: [1, 10], dropRate: 0, duplicateRate: 0 },
        });
        sim.runUntil(5000);
        const max = Math.max(...NODES.map((id) => sim.getState(id).lastDelivered));
        return max >= 20; // ~166 rounds expected; 20 is a safe floor
      }),
      FC,
    );
  });
});
