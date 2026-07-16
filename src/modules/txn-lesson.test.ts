// src/modules/txn-lesson.test.ts
// The Ch7 lesson, pinned: which anomaly appears at which rung of the ladder.
import { expect, test } from 'vitest';
import { Simulation } from '../engine';
import { txn, committedValue, type TxnState } from './txn';
import { presetById, TXN_TOPOLOGY, type PresetId, type TxnPayload } from './txn-shared';

function runPreset(id: PresetId): Map<string, TxnState> {
  const p = presetById(id);
  const sim = new Simulation<TxnState, TxnPayload>({
    module: txn,
    config: { nodeIds: TXN_TOPOLOGY, params: { initial: p.initial } },
    seed: 7000,
  });
  sim.runSteps(TXN_TOPOLOGY.length);
  for (const s of p.steps) {
    for (const nid of TXN_TOPOLOGY) sim.external(nid, { schedule: s });
    sim.runSteps(TXN_TOPOLOGY.length);
  }
  return new Map(TXN_TOPOLOGY.map((nid) => [nid, sim.getState(nid)]));
}

const flags = (s: TxnState) => s.anomalies.map((a) => a.type);

test('pinned matrix — dirty read exists only below Read Committed', () => {
  const m = runPreset('dirty-read');
  expect(flags(m.get('RU')!)).toEqual(['dirty-read']);
  for (const id of ['RC', 'SI', 'SER'] as const) expect(flags(m.get(id)!)).toEqual([]);
  for (const id of TXN_TOPOLOGY) {
    const s = m.get(id)!;
    expect(committedValue(s, 'x')).toBe(10); // T1 aborted everywhere; x never really changed
    expect(s.txns.T1.status).toBe('aborted');
    expect(s.txns.T2.status).toBe('committed');
  }
});

test('pinned matrix — lost update survives RC, dies at SI (abort) and SER (serial 12)', () => {
  const m = runPreset('lost-update');
  expect(flags(m.get('RU')!)).toEqual(['lost-update']);
  expect(flags(m.get('RC')!)).toEqual(['lost-update']);
  expect(committedValue(m.get('RU')!, 'counter')).toBe(11);
  expect(committedValue(m.get('RC')!, 'counter')).toBe(11);

  const si = m.get('SI')!;
  expect(flags(si)).toEqual([]);
  expect(si.txns.T2.status).toBe('aborted');
  expect(si.txns.T2.abortReason).toContain('first committer wins');
  expect(committedValue(si, 'counter')).toBe(11);

  const ser = m.get('SER')!;
  expect(flags(ser)).toEqual([]);
  expect(ser.txns.T2.status).toBe('committed');
  expect(committedValue(ser, 'counter')).toBe(12); // both increments landed
});

test('pinned matrix — write skew survives even SI; only SER holds the invariant', () => {
  const m = runPreset('write-skew');
  for (const id of ['RU', 'RC', 'SI'] as const) {
    const s = m.get(id)!;
    expect(flags(s)).toEqual(['write-skew']);
    expect((committedValue(s, 'alice') ?? 0) + (committedValue(s, 'bob') ?? 0)).toBe(0); // nobody on call
  }
  const ser = m.get('SER')!;
  expect(flags(ser)).toEqual([]);
  expect(ser.txns.T2.status).toBe('aborted');
  expect(ser.txns.T2.abortReason).toContain('ensure failed');
  expect((committedValue(ser, 'alice') ?? 0) + (committedValue(ser, 'bob') ?? 0)).toBe(1); // invariant held
});
