import fc from 'fast-check';
import { expect, test } from 'vitest';
import { Simulation, type NodeId } from '../engine';
import { BROKER_TOPOLOGY } from './brokers-shared';
import { rabbitqueue, rabbitTriple, type RabbitPayload, type RabbitState } from './rabbitqueue';

const TOPO = BROKER_TOPOLOGY;

type Op = { kind: 'produce'; n: number } | { kind: 'kill' } | { kind: 'revive' };
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant<'produce'>('produce'), n: fc.integer({ min: 1, max: 4 }) }),
  fc.record({ kind: fc.constant<'kill'>('kill') }),
  fc.record({ kind: fc.constant<'revive'>('revive') }),
);

// No silent loss: under any C1 kill/revive schedule (C2 always survives to take
// requeued messages), every produced id ends processed, unacked, or dead-lettered
// — rabbitTriple.lost is always 0 — and no consumer invents an id.
test('property: no produced id is silently lost under an arbitrary C1 crash schedule', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 2 ** 30 }),
      fc.array(opArb, { minLength: 1, maxLength: 14 }),
      (seed, ops) => {
        const sim = new Simulation<RabbitState, RabbitPayload>({
          module: rabbitqueue,
          config: { nodeIds: TOPO },
          seed,
          network: { latency: [1, 40] },
        });
        sim.runSteps(TOPO.length);
        const produced = new Set<string>();
        let next = 0;
        let dead = false;
        let t = 0;
        for (const op of ops) {
          if (op.kind === 'produce') {
            for (let i = 0; i < op.n; i++) {
              const id = `m${next++}`;
              produced.add(id);
              sim.external('P', { cmd: 'produce', key: id });
            }
          } else if (op.kind === 'kill' && !dead) {
            sim.control({ type: 'kill', node: 'C1' });
            dead = true;
          } else if (op.kind === 'revive' && dead) {
            sim.control({ type: 'revive', node: 'C1' });
            dead = false;
          }
          t += 2000;
          sim.runUntil(t);
        }
        if (dead) sim.control({ type: 'revive', node: 'C1' });
        sim.runUntil(t + 400000);

        const states = new Map<NodeId, RabbitState>(TOPO.map((id) => [id, sim.getState(id)] as const));
        expect(rabbitTriple(states).lost).toBe(0);
        for (const id of TOPO) {
          const s = sim.getState(id);
          if (s.role === 'consumer') for (const m of s.processed) expect(produced.has(m)).toBe(true);
        }
      },
    ),
    { numRuns: 60 },
  );
});
