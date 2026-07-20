import { describe, expect, test } from 'vitest';
import {
  SERVICE_MEAN,
  LOAD_MAX,
  WINDOW_MIN,
  SLA,
  FANOUT_MIN,
  interArrivalMean,
  expTick,
  percentile,
  evalChallenges,
  freshChallenges,
} from './load-shared';

describe('interArrivalMean', () => {
  test('is >= 1 and never increases as load rises', () => {
    let prev = Infinity;
    for (let level = 1; level <= LOAD_MAX; level++) {
      const m = interArrivalMean(level);
      expect(m).toBeGreaterThanOrEqual(1);
      expect(m).toBeLessThanOrEqual(prev);
      prev = m;
    }
  });
});

describe('expTick', () => {
  test('u=1 (from rng 0) clamps to 1 tick, never Infinity', () => {
    expect(expTick(SERVICE_MEAN, 1)).toBe(1);
    expect(Number.isFinite(expTick(SERVICE_MEAN, 1e-9))).toBe(true);
  });
  test('is an integer >= 1 across the unit interval', () => {
    for (const u of [1, 0.9, 0.5, 0.1, 0.001]) {
      const t = expTick(SERVICE_MEAN, u);
      expect(Number.isInteger(t)).toBe(true);
      expect(t).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('percentile', () => {
  test('empty is 0; ordered p50 <= p95 <= p99 <= max', () => {
    expect(percentile([], 99)).toBe(0);
    const xs = [5, 1, 9, 3, 7, 2, 8, 4, 6, 10];
    const p50 = percentile(xs, 50);
    const p95 = percentile(xs, 95);
    const p99 = percentile(xs, 99);
    expect(p50).toBeLessThanOrEqual(p95);
    expect(p95).toBeLessThanOrEqual(p99);
    expect(p99).toBeLessThanOrEqual(Math.max(...xs));
  });
  test('nearest-rank: p100 is the max, p0 is the min', () => {
    const xs = [10, 20, 30, 40];
    expect(percentile(xs, 100)).toBe(40);
    expect(percentile(xs, 0)).toBe(10);
  });
});

describe('evalChallenges (latching, warmup-gated)', () => {
  const fill = (n: number, v: number) => Array.from({ length: n }, () => v);

  test('below WINDOW_MIN completions never latches', () => {
    const c = evalChallenges(freshChallenges(), {
      servers: 1,
      varianceOn: true,
      fanout: 1,
      user: [SLA + 50],
      backend: [],
    });
    expect(c.c1.breached).toBe(false);
  });

  test('C1 breached when c=1, p99>SLA, p50<SLA', () => {
    // 39 small (p50 < SLA) + 1 slow (p99 = max > SLA)
    const user = fill(WINDOW_MIN - 1, SLA - 50).concat([SLA + 200]);
    const c = evalChallenges(freshChallenges(), { servers: 1, varianceOn: true, fanout: 1, user, backend: [] });
    expect(c.c1.breached).toBe(true);
    expect(c.c1.rescued).toBe(false);
  });

  test('C1 rescued only after breached, at servers>=2, p99<SLA', () => {
    const breached = { ...freshChallenges(), c1: { breached: true, rescued: false } };
    const c = evalChallenges(breached, {
      servers: 2,
      varianceOn: true,
      fanout: 1,
      user: fill(WINDOW_MIN, SLA - 60),
      backend: [],
    });
    expect(c.c1.rescued).toBe(true);
  });

  test('C2 hiTail when variance on and p99 >= MULT*p50', () => {
    const user = fill(WINDOW_MIN - 1, 20).concat([200]); // p50=20, p99=200 (>= 3*20)
    const c = evalChallenges(freshChallenges(), { servers: 3, varianceOn: true, fanout: 1, user, backend: [] });
    expect(c.c2.hiTail).toBe(true);
    expect(c.c2.loTail).toBe(false);
  });

  test('C3 amplified when fanout>=FANOUT_MIN and user p50 >= backend p95', () => {
    const c = evalChallenges(freshChallenges(), {
      servers: 4,
      varianceOn: true,
      fanout: FANOUT_MIN,
      user: fill(WINDOW_MIN, 100),
      backend: fill(WINDOW_MIN, 10),
    });
    expect(c.c3.amplified).toBe(true);
  });
});
