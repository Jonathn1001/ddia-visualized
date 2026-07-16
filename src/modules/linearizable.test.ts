import { expect, test } from 'vitest';
import { checkLinearizable, type CompletedOp } from './linearizable';
import { RAFT_NODES, CHECK_CAP } from './raft-shared';

const w = (value: number, invokedAt: number, respondedAt: number): CompletedOp => ({ op: 'write', value, invokedAt, respondedAt });
const r = (value: number, invokedAt: number, respondedAt: number): CompletedOp => ({ op: 'read', value, invokedAt, respondedAt });

test('raft topology is five nodes', () => {
  expect(RAFT_NODES).toHaveLength(5);
});

test('empty and write-only histories are linearizable', () => {
  expect(checkLinearizable([]).verdict).toBe('ok');
  expect(checkLinearizable([w(1, 0, 5), w(2, 10, 15)]).verdict).toBe('ok');
});

test('sequential write-then-read of that value is ok; of another value is a violation', () => {
  expect(checkLinearizable([w(7, 0, 5), r(7, 10, 15)]).verdict).toBe('ok');
  const bad = checkLinearizable([w(7, 0, 5), r(9, 10, 15)]);
  expect(bad.verdict).toBe('violation');
  expect((bad as { culprit: number }).culprit).toBe(1);
});

test('a read may see either value while concurrent with the write', () => {
  expect(checkLinearizable([w(1, 0, 20), r(0, 5, 10)]).verdict).toBe('ok'); // read linearized before the write
  expect(checkLinearizable([w(1, 0, 20), r(1, 5, 10)]).verdict).toBe('ok'); // or after
});

test('the classic stale read: acknowledged overwrite, then a read of the old value', () => {
  // w(1) done; w(2) done strictly after; then a read strictly after both returns 1 → violation
  const bad = checkLinearizable([w(1, 0, 5), w(2, 10, 15), r(1, 20, 25)]);
  expect(bad.verdict).toBe('violation');
  expect((bad as { culprit: number }).culprit).toBe(2);
});

test('reads observing opposite orders of two concurrent writes: one order works → ok', () => {
  // writes concurrent; two sequential reads both see 2 then both see 2 → fine
  expect(
    checkLinearizable([w(1, 0, 30), w(2, 0, 30), r(2, 40, 45), r(2, 50, 55)]).verdict,
  ).toBe('ok');
  // but 2-then-1 with the reads strictly ordered AND after both writes is a violation
  const bad = checkLinearizable([w(1, 0, 10), w(2, 12, 20), r(2, 30, 35), r(1, 40, 45)]);
  expect(bad.verdict).toBe('violation');
});

test('initial register value is 0: a leading read of 0 is fine, of anything else is not', () => {
  expect(checkLinearizable([r(0, 0, 5)]).verdict).toBe('ok');
  expect(checkLinearizable([r(3, 0, 5)]).verdict).toBe('violation');
});

test('histories beyond the cap are refused, not judged', () => {
  const many: CompletedOp[] = [];
  for (let i = 0; i < CHECK_CAP + 1; i++) many.push(w(i, i * 10, i * 10 + 5));
  expect(checkLinearizable(many).verdict).toBe('too-long');
});
