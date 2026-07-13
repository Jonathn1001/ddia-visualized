import fc from 'fast-check';
import { expect, test } from 'vitest';
import { Simulation, type NodeId } from '../engine';
import { BROKER_TOPOLOGY } from './brokers-shared';
import { redispubsub, redisTriple, type RedisPayload, type RedisState } from './redispubsub';

const TOPO = BROKER_TOPOLOGY;

type Op = { kind: 'produce'; n: number } | { kind: 'kill'; c: NodeId } | { kind: 'revive'; c: NodeId };
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant<'produce'>('produce'), n: fc.integer({ min: 1, max: 4 }) }),
  fc.record({ kind: fc.constant<'kill'>('kill'), c: fc.constantFrom<NodeId>('C1', 'C2') }),
  fc.record({ kind: fc.constant<'revive'>('revive'), c: fc.constantFrom<NodeId>('C1', 'C2') }),
);

// Redis structural invariants under any kill/revive schedule of either subscriber:
// each subscriber only ever processes ids that were published (a subset), and
// duplicates are structurally 0 (no ack/replay can re-deliver).
test('property: processed ⊆ published, duplicates structurally 0', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 2 ** 30 }),
      fc.array(opArb, { minLength: 1, maxLength: 14 }),
      (seed, ops) => {
        const sim = new Simulation<RedisState, RedisPayload>({
          module: redispubsub,
          config: { nodeIds: TOPO },
          seed,
          network: { latency: [1, 40] },
        });
        sim.runSteps(TOPO.length);
        const dead = new Set<NodeId>();
        let next = 0;
        let t = 0;
        for (const op of ops) {
          if (op.kind === 'produce') {
            for (let i = 0; i < op.n; i++) sim.external('P', { cmd: 'produce', key: `m${next++}` });
          } else if (op.kind === 'kill' && !dead.has(op.c)) {
            sim.control({ type: 'kill', node: op.c });
            dead.add(op.c);
          } else if (op.kind === 'revive' && dead.has(op.c)) {
            sim.control({ type: 'revive', node: op.c });
            dead.delete(op.c);
          }
          t += 2000;
          sim.runUntil(t);
        }
        sim.runUntil(t + 100000);

        const states = new Map<NodeId, RedisState>(TOPO.map((id) => [id, sim.getState(id)] as const));
        const b = states.get('B');
        const published = new Set(b && b.role === 'broker' ? b.published : []);
        for (const c of ['C1', 'C2'] as NodeId[]) {
          const s = sim.getState(c);
          if (s.role !== 'consumer') continue;
          for (const id of s.processed) expect(published.has(id)).toBe(true); // subset
          expect(new Set(s.processed).size).toBe(s.processed.length); // no per-subscriber repeat
        }
        expect(redisTriple(states).duplicates).toBe(0);
      },
    ),
    { numRuns: 60 },
  );
});
