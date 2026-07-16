// src/modules/txn-shared.ts
// Ch7 Isolation Anomaly Lab — shared vocabulary: levels, schedule ops, presets.
// Four nodes = four isolation levels interpreting the same schedule.

export type Level = 'RU' | 'RC' | 'SI' | 'SER';
export type TxnId = 'T1' | 'T2';

export const TXN_TOPOLOGY: Level[] = ['RU', 'RC', 'SI', 'SER'];
export const TXN_IDS: TxnId[] = ['T1', 'T2'];

/** One-line semantics shown at the top of each panel. */
export const CREDOS: Record<Level, string> = {
  RU: 'reads may see uncommitted data',
  RC: 'reads see the last committed value',
  SI: 'reads from a begin-time snapshot; first committer wins',
  SER: 'one transaction at a time',
};

/** {inc:n} = the value this txn last read for the key, plus n (read-modify-write). */
export type WriteValue = number | { inc: number };

export type Op =
  | { op: 'begin' }
  | { op: 'read'; key: string }
  | { op: 'write'; key: string; value: WriteValue }
  /** App-level check-then-act: read all keys; abort the txn if their sum < atLeast. */
  | { op: 'ensure'; keys: string[]; atLeast: number }
  | { op: 'commit' }
  | { op: 'abort' };

export interface ScheduleStep {
  txn: TxnId;
  op: Op;
}

export type PresetId = 'dirty-read' | 'lost-update' | 'write-skew';

export interface Preset {
  id: PresetId;
  title: string;
  blurb: string;
  initial: Record<string, number>;
  steps: ScheduleStep[];
}

export type TxnPayload = { schedule: ScheduleStep };

export const PRESETS: Preset[] = [
  {
    id: 'dirty-read',
    title: 'Dirty read',
    blurb: 'T2 reads T1’s unfinished write — then T1 aborts.',
    initial: { x: 10 },
    steps: [
      { txn: 'T1', op: { op: 'begin' } },
      { txn: 'T1', op: { op: 'write', key: 'x', value: 99 } },
      { txn: 'T2', op: { op: 'begin' } },
      { txn: 'T2', op: { op: 'read', key: 'x' } },
      { txn: 'T2', op: { op: 'commit' } },
      { txn: 'T1', op: { op: 'abort' } },
    ],
  },
  {
    id: 'lost-update',
    title: 'Lost update',
    blurb: 'Two read-modify-write increments race on one counter.',
    initial: { counter: 10 },
    steps: [
      { txn: 'T1', op: { op: 'begin' } },
      { txn: 'T2', op: { op: 'begin' } },
      { txn: 'T1', op: { op: 'read', key: 'counter' } },
      { txn: 'T2', op: { op: 'read', key: 'counter' } },
      { txn: 'T1', op: { op: 'write', key: 'counter', value: { inc: 1 } } },
      { txn: 'T1', op: { op: 'commit' } },
      { txn: 'T2', op: { op: 'write', key: 'counter', value: { inc: 1 } } },
      { txn: 'T2', op: { op: 'commit' } },
    ],
  },
  {
    id: 'write-skew',
    title: 'Write skew — doctors on call',
    blurb: 'Both doctors check the rota, then both go off call.',
    initial: { alice: 1, bob: 1 },
    steps: [
      { txn: 'T1', op: { op: 'begin' } },
      { txn: 'T2', op: { op: 'begin' } },
      { txn: 'T1', op: { op: 'ensure', keys: ['alice', 'bob'], atLeast: 2 } },
      { txn: 'T2', op: { op: 'ensure', keys: ['alice', 'bob'], atLeast: 2 } },
      { txn: 'T1', op: { op: 'write', key: 'alice', value: 0 } },
      { txn: 'T1', op: { op: 'commit' } },
      { txn: 'T2', op: { op: 'write', key: 'bob', value: 0 } },
      { txn: 'T2', op: { op: 'commit' } },
    ],
  },
];

export function presetById(id: PresetId): Preset {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown preset: ${id}`);
  return p;
}

/** Monospace row label for the schedule list, e.g. "T1 write x=99". */
export function opLabel(step: ScheduleStep): string {
  const { txn, op } = step;
  switch (op.op) {
    case 'begin':
    case 'commit':
    case 'abort':
      return `${txn} ${op.op}`;
    case 'read':
      return `${txn} read ${op.key}`;
    case 'write':
      return typeof op.value === 'number'
        ? `${txn} write ${op.key}=${op.value}`
        : `${txn} write ${op.key}+=${op.value.inc}`;
    case 'ensure':
      return `${txn} ensure ${op.keys.join('+')} ≥ ${op.atLeast}`;
  }
}
