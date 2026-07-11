// src/modules/multileader.property.test.ts
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { Simulation, type NodeId } from '../engine';
import { detectLostWrite, multiLeader, type MLPayload, type MLState } from './multileader';

const NODES = ['DC1', 'DC2'];
const KEYS = ['a', 'b', 'c'];

interface WriteOp {
  node: string;
  key: string;
}

const writeArb: fc.Arbitrary<WriteOp> = fc.record({
  node: fc.constantFrom(...NODES),
  key: fc.constantFrom(...KEYS),
});

function run(seed: number, ops: WriteOp[], singleLeader: boolean) {
  const sim = new Simulation<MLState, MLPayload>({
    module: multiLeader,
    config: { nodeIds: NODES },
    seed,
    network: { latency: [1, 50] },
  });
  sim.runSteps(2);
  let t = 0;
  ops.forEach((op, i) => {
    t += 20;
    sim.runUntil(t);
    sim.external(singleLeader ? 'DC1' : op.node, { cmd: 'write', key: op.key, value: `v${i}` });
  });
  sim.runUntil(t + 2000);
  return sim;
}

test('property: with no drops, both leaders converge to identical data', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 2 ** 30 }),
      fc.array(writeArb, { minLength: 1, maxLength: 20 }),
      (seed, ops) => {
        const sim = run(seed, ops, false);
        expect(sim.getState('DC1').data).toEqual(sim.getState('DC2').data);
      },
    ),
    { numRuns: 50 },
  );
});

test('property: detectLostWrite never fires when all writes target one leader', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 2 ** 30 }),
      fc.array(writeArb, { minLength: 1, maxLength: 20 }),
      (seed, ops) => {
        const sim = run(seed, ops, true);
        const states = new Map<NodeId, MLState>(
          NODES.map((id) => [id, sim.getState(id)] as const),
        );
        expect(detectLostWrite(states)).toBeNull();
      },
    ),
    { numRuns: 50 },
  );
});
