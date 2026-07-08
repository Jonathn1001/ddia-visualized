import { expect, test } from 'vitest';
import { fnv1a, hashEventLog } from './hash';
import type { LoggedEvent } from './sim';

test('fnv1a matches known 32-bit FNV-1a vectors', () => {
  expect(fnv1a('').toString(16)).toBe('811c9dc5');
  expect(fnv1a('a').toString(16)).toBe('e40c292c');
  expect(fnv1a('foobar').toString(16)).toBe('bf9cf968');
});

test('hashEventLog is order- and content-sensitive', () => {
  const e = (index: number, payload: unknown): LoggedEvent => ({
    index,
    time: index * 10,
    target: 'a',
    kind: 'message',
    payload,
  });
  const h1 = hashEventLog([e(0, 'x'), e(1, 'y')]);
  const h2 = hashEventLog([e(0, 'y'), e(1, 'x')]);
  const h3 = hashEventLog([e(0, 'x'), e(1, 'y')]);
  expect(h1).not.toBe(h2);
  expect(h1).toBe(h3);
  expect(h1).toMatch(/^[0-9a-f]{8}$/);
});
