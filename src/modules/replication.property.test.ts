import fc from 'fast-check';
import { expect, test } from 'vitest';
import { Simulation } from '../engine';
import { detectStaleRead, replication, type RepPayload, type RepState } from './replication';

const NODES = ['L', 'F1', 'F2'];
const KEYS = ['a', 'b', 'c'];

interface Op {
  kind: 'write' | 'read';
  key: string;
  node: string;
}

const opArb: fc.Arbitrary<Op> = fc.record({
  kind: fc.constantFrom<'write' | 'read'>('write', 'read'),
  key: fc.constantFrom(...KEYS),
  node: fc.constantFrom(...NODES),
});

function runScenario(opts: {
  mode: 'async' | 'sync';
  seed: number;
  ops: Op[];
  killAt?: { opIndex: number; follower: string };
  readsOnLeaderOnly?: boolean;
}) {
  const sim = new Simulation<RepState, RepPayload>({
    module: replication,
    config: { nodeIds: NODES, params: { mode: opts.mode } },
    seed: opts.seed,
    network: { latency: [1, 50] },
  });
  sim.runSteps(3);
  let t = 0;
  opts.ops.forEach((op, i) => {
    t += 20;
    sim.runUntil(t);
    if (opts.killAt && opts.killAt.opIndex === i) sim.control({ type: 'kill', node: opts.killAt.follower });
    if (op.kind === 'write') sim.external('L', { cmd: 'write', key: op.key, value: `v${i}` });
    else sim.external(opts.readsOnLeaderOnly ? 'L' : op.node, { cmd: 'read', key: op.key });
  });
  sim.runUntil(t + 3000);
  return sim;
}

test('DoD property: a sync-acked write is never lost when one follower dies', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 2 ** 30 }),
      fc.array(opArb, { minLength: 1, maxLength: 15 }),
      fc.nat({ max: 14 }),
      fc.constantFrom('F1', 'F2'),
      (seed, ops, killIndex, follower) => {
        const sim = runScenario({ mode: 'sync', seed, ops, killAt: { opIndex: killIndex % ops.length, follower } });
        const leader = sim.getState('L');
        const acks = leader.history.filter((h) => h.type === 'ack');
        const alive = NODES.filter((id) => !sim.deadNodes().includes(id));
        for (const a of acks) {
          for (const id of alive) {
            // in-order apply ⇒ having seq n means having every entry ≤ n
            expect(sim.getState(id).log.length).toBeGreaterThanOrEqual(a.seq);
          }
        }
      },
    ),
    { numRuns: 50 },
  );
});

test('property: follower log is always a prefix of the leader log', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 2 ** 30 }),
      fc.constantFrom<'async' | 'sync'>('async', 'sync'),
      fc.array(opArb, { minLength: 1, maxLength: 15 }),
      (seed, mode, ops) => {
        const sim = runScenario({ mode, seed, ops });
        const leaderLog = sim.getState('L').log;
        for (const id of ['F1', 'F2']) {
          const flog = sim.getState(id).log;
          expect(flog).toEqual(leaderLog.slice(0, flog.length));
        }
      },
    ),
    { numRuns: 50 },
  );
});

test('property: verifier never fires when all reads go to the leader', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 2 ** 30 }),
      fc.constantFrom<'async' | 'sync'>('async', 'sync'),
      fc.array(opArb, { minLength: 1, maxLength: 15 }),
      (seed, mode, ops) => {
        const sim = runScenario({ mode, seed, ops, readsOnLeaderOnly: true });
        const states = new Map(NODES.map((id) => [id, sim.getState(id)] as const));
        expect(detectStaleRead(states)).toBeNull();
      },
    ),
    { numRuns: 50 },
  );
});
