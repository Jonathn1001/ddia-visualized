// src/modules/txn.property.test.ts
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { Simulation } from '../engine';
import { txn, type TxnState } from './txn';
import { TXN_TOPOLOGY, type Op, type ScheduleStep, type TxnId, type TxnPayload } from './txn-shared';

const KEYS = ['a', 'b'];
const INITIAL = { a: 1, b: 1 };

/** Body ops for one txn (no begin/commit/abort — those are added around it). */
const bodyOp: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ op: fc.constant<'read'>('read'), key: fc.constantFrom(...KEYS) }),
  fc.record({
    op: fc.constant<'write'>('write'),
    key: fc.constantFrom(...KEYS),
    value: fc.oneof(fc.integer({ min: 0, max: 9 }), fc.record({ inc: fc.integer({ min: 1, max: 3 }) })),
  }),
  fc.record({
    op: fc.constant<'ensure'>('ensure'),
    keys: fc.constant(KEYS),
    atLeast: fc.integer({ min: 0, max: 3 }),
  }),
);

/** A well-formed 2-txn schedule: per-txn begin → body → commit|abort, fairly interleaved. */
const schedule: fc.Arbitrary<ScheduleStep[]> = fc
  .tuple(
    fc.array(bodyOp, { minLength: 0, maxLength: 4 }),
    fc.array(bodyOp, { minLength: 0, maxLength: 4 }),
    fc.constantFrom<'commit' | 'abort'>('commit', 'abort'),
    fc.constantFrom<'commit' | 'abort'>('commit', 'abort'),
    fc.array(fc.boolean(), { minLength: 20, maxLength: 20 }),
  )
  .map(([body1, body2, end1, end2, coin]) => {
    const t1: ScheduleStep[] = [
      { txn: 'T1' as TxnId, op: { op: 'begin' } as Op },
      ...body1.map((op) => ({ txn: 'T1' as TxnId, op })),
      { txn: 'T1' as TxnId, op: { op: end1 } as Op },
    ];
    const t2: ScheduleStep[] = [
      { txn: 'T2' as TxnId, op: { op: 'begin' } as Op },
      ...body2.map((op) => ({ txn: 'T2' as TxnId, op })),
      { txn: 'T2' as TxnId, op: { op: end2 } as Op },
    ];
    const out: ScheduleStep[] = [];
    let i = 0;
    let j = 0;
    let c = 0;
    while (i < t1.length || j < t2.length) {
      const takeT1 = j >= t2.length || (i < t1.length && coin[c++ % coin.length]);
      if (takeT1) out.push(t1[i++]);
      else out.push(t2[j++]);
    }
    return out;
  });

function runSchedule(steps: ScheduleStep[], seed: number): Map<string, TxnState> {
  const sim = new Simulation<TxnState, TxnPayload>({
    module: txn,
    config: { nodeIds: TXN_TOPOLOGY, params: { initial: INITIAL } },
    seed,
  });
  sim.runSteps(TXN_TOPOLOGY.length);
  for (const s of steps) {
    for (const id of TXN_TOPOLOGY) sim.external(id, { schedule: s });
    sim.runSteps(TXN_TOPOLOGY.length);
  }
  return new Map(TXN_TOPOLOGY.map((id) => [id, sim.getState(id)]));
}

test('determinism: the same schedule twice yields byte-identical states', () => {
  fc.assert(
    fc.property(schedule, (steps) => {
      const a = runSchedule(steps, 7100);
      const b = runSchedule(steps, 7100);
      for (const id of TXN_TOPOLOGY) {
        expect(JSON.stringify(a.get(id))).toBe(JSON.stringify(b.get(id)));
      }
    }),
    { numRuns: 30 },
  );
});

test('SER never exhibits any anomaly, for any well-formed schedule', () => {
  fc.assert(
    fc.property(schedule, (steps) => {
      const states = runSchedule(steps, 7200);
      expect(states.get('SER')!.anomalies).toEqual([]);
    }),
    { numRuns: 60 },
  );
});

test('RC, SI and SER never dirty-read, for any well-formed schedule', () => {
  fc.assert(
    fc.property(schedule, (steps) => {
      const states = runSchedule(steps, 7300);
      for (const id of ['RC', 'SI', 'SER'] as const) {
        expect(states.get(id)!.anomalies.filter((a) => a.type === 'dirty-read')).toEqual([]);
      }
    }),
    { numRuns: 60 },
  );
});

test('SI: every foreign read comes from a version committed at or before the snapshot', () => {
  fc.assert(
    fc.property(schedule, (steps) => {
      const si = runSchedule(steps, 7400).get('SI')!;
      for (const t of ['T1', 'T2'] as const) {
        const info = si.txns[t];
        for (const r of info.reads) {
          if (r.from === t) continue; // own writes are always visible
          if (r.from === null && r.versionCommittedAt === null) continue; // missing key
          expect(r.versionCommittedAt).not.toBeNull();
          if (info.snapshotAt !== null) {
            expect(r.versionCommittedAt as number).toBeLessThanOrEqual(info.snapshotAt);
          }
        }
      }
    }),
    { numRuns: 60 },
  );
});

test('the schedule always runs dry: every op is applied, queued-then-drained, or skipped', () => {
  fc.assert(
    fc.property(schedule, (steps) => {
      const states = runSchedule(steps, 7500);
      for (const id of TXN_TOPOLOGY) {
        const s = states.get(id)!;
        // both txns reached a terminal state
        expect(['committed', 'aborted']).toContain(s.txns.T1.status);
        expect(['committed', 'aborted']).toContain(s.txns.T2.status);
        // SER's queue fully drained
        expect(s.queue).toEqual([]);
      }
    }),
    { numRuns: 60 },
  );
});
