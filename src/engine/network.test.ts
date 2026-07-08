import { expect, test } from 'vitest';
import { SeededRng } from './rng';
import { SimNetwork } from './network';

test('delivers exactly once within latency bounds by default', () => {
  const net = new SimNetwork({ latency: [5, 10] });
  const rng = new SeededRng(1);
  for (let i = 0; i < 200; i++) {
    const ds = net.plan('a', 'b', rng);
    expect(ds).toHaveLength(1);
    expect(ds[0].delay).toBeGreaterThanOrEqual(5);
    expect(ds[0].delay).toBeLessThanOrEqual(10);
  }
});

test('dropRate=1 drops everything', () => {
  const net = new SimNetwork({ dropRate: 1 });
  const rng = new SeededRng(1);
  for (let i = 0; i < 50; i++) expect(net.plan('a', 'b', rng)).toEqual([]);
});

test('duplicateRate=1 always delivers twice', () => {
  const net = new SimNetwork({ duplicateRate: 1 });
  const rng = new SeededRng(1);
  for (let i = 0; i < 50; i++) expect(net.plan('a', 'b', rng)).toHaveLength(2);
});

test('partition blocks cross-group, allows in-group', () => {
  const net = new SimNetwork();
  const rng = new SeededRng(1);
  net.partition([['a', 'b'], ['c']]);
  expect(net.canReach('a', 'b')).toBe(true);
  expect(net.canReach('a', 'c')).toBe(false);
  expect(net.canReach('c', 'a')).toBe(false);
  expect(net.plan('a', 'c', rng)).toEqual([]);
  expect(net.plan('a', 'b', rng)).toHaveLength(1);
});

test('heal removes the partition', () => {
  const net = new SimNetwork();
  net.partition([['a'], ['b']]);
  expect(net.canReach('a', 'b')).toBe(false);
  net.heal();
  expect(net.canReach('a', 'b')).toBe(true);
});

test('snapshot/restore round-trips options and partition', () => {
  const net = new SimNetwork({ latency: [2, 4], dropRate: 0.5 });
  net.partition([['a'], ['b']]);
  const snap = net.snapshot();
  net.heal();
  net.opts.dropRate = 0;
  net.restore(snap);
  expect(net.canReach('a', 'b')).toBe(false);
  expect(net.opts.dropRate).toBe(0.5);
  expect(net.opts.latency).toEqual([2, 4]);
});
