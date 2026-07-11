// src/modules/leaderless.property.test.ts
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { Simulation, type NodeId } from '../engine';
import { detectLostAckedWrite, leaderless, type LLPayload, type LLState } from './leaderless';

const NODES = ['A', 'B', 'C', 'D', 'E'];
const KEYS = ['a', 'b'];

interface Op {
  kind: 'write' | 'read';
  key: string;
  coordinator: string;
}

const opArb: fc.Arbitrary<Op> = fc.record({
  kind: fc.constantFrom<'write' | 'read'>('write', 'read'),
  key: fc.constantFrom(...KEYS),
  coordinator: fc.constantFrom(...NODES),
});

function makeSim(seed: number, params: { w: number; r: number; sloppy: boolean }) {
  return new Simulation<LLState, LLPayload>({
    module: leaderless,
    config: { nodeIds: NODES, params },
    seed,
    network: { latency: [1, 40] },
  });
}

test('property: w+r>n, sequential ops, no chaos — every read returns the latest acked value', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 2 ** 30 }),
      fc.constantFrom<[number, number]>([2, 2], [3, 2], [2, 3], [3, 3], [1, 3], [3, 1]),
      fc.array(opArb, { minLength: 2, maxLength: 12 }),
      (seed, [w, r], ops) => {
        const sim = makeSim(seed, { w, r, sloppy: false });
        sim.runSteps(5);
        const lastAckedTs: Record<string, number> = {};
        let t = 0;
        for (const op of ops) {
          const before = countAcks(sim);
          sim.external(op.coordinator, op.kind === 'write' ? { cmd: 'write', key: op.key, value: `v${t}` } : { cmd: 'read', key: op.key });
          t += 1000;
          sim.runUntil(t); // sequential: quiesce between ops
          if (op.kind === 'write' && countAcks(sim) > before) {
            const acks = allAcks(sim).filter((a) => a.key === op.key);
            lastAckedTs[op.key] = Math.max(...acks.map((a) => a.ts));
          }
          if (op.kind === 'read') {
            const reads = sim.getState(op.coordinator).history.filter((h) => h.type === 'read');
            const latest = reads[reads.length - 1];
            if (latest && lastAckedTs[op.key] !== undefined) {
              expect(latest.returnedTs).toBeGreaterThanOrEqual(lastAckedTs[op.key]);
            }
          }
        }
      },
    ),
    { numRuns: 50 },
  );

  function allAcks(sim: Simulation<LLState, LLPayload>) {
    return NODES.flatMap((id) =>
      sim.getState(id).history.filter((h): h is Extract<LLState['history'][number], { type: 'ack' }> => h.type === 'ack'),
    );
  }
  function countAcks(sim: Simulation<LLState, LLPayload>) {
    return allAcks(sim).length;
  }
});

test('property: detectLostAckedWrite never fires without kills or partitions', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 2 ** 30 }),
      fc.boolean(),
      fc.array(opArb, { minLength: 1, maxLength: 12 }),
      (seed, sloppy, ops) => {
        const sim = makeSim(seed, { w: 2, r: 2, sloppy });
        sim.runSteps(5);
        let t = 0;
        for (const op of ops) {
          t += 50;
          sim.runUntil(t);
          sim.external(
            op.coordinator,
            op.kind === 'write' ? { cmd: 'write', key: op.key, value: `v${t}` } : { cmd: 'read', key: op.key },
          );
        }
        sim.runUntil(t + 3000);
        const states = new Map<NodeId, LLState>(NODES.map((id) => [id, sim.getState(id)] as const));
        expect(detectLostAckedWrite(states, sim.deadNodes())).toBeNull();
      },
    ),
    { numRuns: 50 },
  );
});
