// src/modules/txn-shared.test.ts
import { expect, test } from 'vitest';
import { PRESETS, TXN_IDS, TXN_TOPOLOGY, opLabel, presetById } from './txn-shared';

test('topology is the four-level ladder in order', () => {
  expect(TXN_TOPOLOGY).toEqual(['RU', 'RC', 'SI', 'SER']);
});

test('three presets, one per anomaly, in ladder order', () => {
  expect(PRESETS.map((p) => p.id)).toEqual(['dirty-read', 'lost-update', 'write-skew']);
});

test('every preset is well-formed: begin first, exactly one commit/abort last per txn', () => {
  for (const p of PRESETS) {
    for (const txn of TXN_IDS) {
      const ops = p.steps.filter((s) => s.txn === txn).map((s) => s.op.op);
      if (ops.length === 0) continue;
      expect(ops[0]).toBe('begin');
      expect(['commit', 'abort']).toContain(ops[ops.length - 1]);
      expect(ops.slice(0, -1).filter((o) => o === 'commit' || o === 'abort')).toEqual([]);
    }
  }
});

test('presets only touch keys seeded in their initial store', () => {
  for (const p of PRESETS) {
    const keys = new Set(Object.keys(p.initial));
    for (const s of p.steps) {
      if (s.op.op === 'read' || s.op.op === 'write') expect(keys.has(s.op.key)).toBe(true);
      if (s.op.op === 'ensure') for (const k of s.op.keys) expect(keys.has(k)).toBe(true);
    }
  }
});

test('opLabel renders every op shape', () => {
  expect(opLabel({ txn: 'T1', op: { op: 'begin' } })).toBe('T1 begin');
  expect(opLabel({ txn: 'T1', op: { op: 'write', key: 'x', value: 99 } })).toBe('T1 write x=99');
  expect(opLabel({ txn: 'T2', op: { op: 'write', key: 'counter', value: { inc: 1 } } })).toBe('T2 write counter+=1');
  expect(opLabel({ txn: 'T2', op: { op: 'read', key: 'x' } })).toBe('T2 read x');
  expect(opLabel({ txn: 'T1', op: { op: 'ensure', keys: ['alice', 'bob'], atLeast: 2 } })).toBe('T1 ensure alice+bob ≥ 2');
  expect(opLabel({ txn: 'T2', op: { op: 'commit' } })).toBe('T2 commit');
  expect(opLabel({ txn: 'T1', op: { op: 'abort' } })).toBe('T1 abort');
});

test('presetById finds each preset', () => {
  expect(presetById('write-skew').initial).toEqual({ alice: 1, bob: 1 });
});
