import fc from 'fast-check';
import { expect, test } from 'vitest';
import { Simulation, type NodeId } from '../engine';
import { BROKER_TOPOLOGY } from './brokers-shared';
import { kafkalog, kafkaTriple, type KafkaPayload, type KafkaState } from './kafkalog';

const TOPO = BROKER_TOPOLOGY;

type Op = { kind: 'produce'; n: number } | { kind: 'kill' } | { kind: 'revive' };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant<'produce'>('produce'), n: fc.integer({ min: 1, max: 4 }) }),
  fc.record({ kind: fc.constant<'kill'>('kill') }),
  fc.record({ kind: fc.constant<'revive'>('revive') }),
);

// Conservation: the log is durable, so under any kill/revive schedule of ONE
// consumer (the other always survives to take over reassigned partitions), every
// produced id is processed at least once by drain, and nothing is ever lost.
test('property: durable log — every produced id survives an arbitrary C1 crash schedule', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 2 ** 30 }),
      fc.array(opArb, { minLength: 1, maxLength: 14 }),
      (seed, ops) => {
        const sim = new Simulation<KafkaState, KafkaPayload>({
          module: kafkalog,
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
        // Revive C1 and drain so any partition parked on a dead consumer clears.
        if (dead) sim.control({ type: 'revive', node: 'C1' });
        sim.runUntil(t + 400000);

        const states = new Map<NodeId, KafkaState>(TOPO.map((id) => [id, sim.getState(id)] as const));
        const tri = kafkaTriple(states);
        const processed = new Set<string>();
        for (const id of TOPO) {
          const s = sim.getState(id);
          if (s.role === 'consumer') for (const m of s.processed) processed.add(m);
        }
        // No loss, ever.
        expect(tri.lost).toBe(0);
        // Conservation: every produced id was processed at least once by drain.
        for (const id of produced) expect(processed.has(id)).toBe(true);
        expect(tri.produced).toBe(produced.size);
        expect(tri.delivered).toBe(produced.size);
      },
    ),
    { numRuns: 60 },
  );
});
