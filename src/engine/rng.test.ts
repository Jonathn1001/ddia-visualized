import { expect, test } from 'vitest';
import { SeededRng } from './rng';

test('same seed produces the same sequence', () => {
  const a = new SeededRng(42);
  const b = new SeededRng(42);
  for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
});

test('different seeds produce different sequences', () => {
  const a = new SeededRng(1);
  const b = new SeededRng(2);
  const seqA = Array.from({ length: 10 }, () => a.next());
  const seqB = Array.from({ length: 10 }, () => b.next());
  expect(seqA).not.toEqual(seqB);
});

test('next() stays in [0, 1)', () => {
  const rng = new SeededRng(7);
  for (let i = 0; i < 1000; i++) {
    const v = rng.next();
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  }
});

test('int(min, maxExcl) stays in range and hits both ends eventually', () => {
  const rng = new SeededRng(7);
  const seen = new Set<number>();
  for (let i = 0; i < 1000; i++) {
    const v = rng.int(3, 6);
    expect(v).toBeGreaterThanOrEqual(3);
    expect(v).toBeLessThan(6);
    seen.add(v);
  }
  expect(seen).toEqual(new Set([3, 4, 5]));
});

test('getState/setState replays the stream exactly', () => {
  const rng = new SeededRng(99);
  rng.next();
  rng.next();
  const state = rng.getState();
  const ahead = [rng.next(), rng.next(), rng.next()];
  rng.setState(state);
  expect([rng.next(), rng.next(), rng.next()]).toEqual(ahead);
});
