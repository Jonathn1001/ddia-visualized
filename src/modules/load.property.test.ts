import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import { Simulation } from '../engine';
import { LOAD_NODES, SVC, percentile, type LoadState } from './load-shared';
import { load, type LoadPayload } from './load';

function make(seed: number) {
  return new Simulation<LoadState, LoadPayload>({ module: load, config: { nodeIds: LOAD_NODES }, seed });
}

/** Run to `steps` events under fixed knobs; returns the SVC state. */
function runSteps(seed: number, level: number, servers: number, variance: boolean, steps: number): LoadState {
  const sim = make(seed);
  sim.runSteps(1);
  sim.external(SVC, { cmd: 'set-servers', c: servers });
  sim.external(SVC, { cmd: 'set-variance', on: variance });
  sim.external(SVC, { cmd: 'set-load', level });
  sim.runSteps(steps);
  return sim.getState(SVC);
}

/** Run to virtual time `t` under fixed knobs — arrivals are identical across server counts. */
function runToTime(seed: number, level: number, servers: number, t: number): LoadState {
  const sim = make(seed);
  sim.runSteps(1);
  sim.external(SVC, { cmd: 'set-servers', c: servers });
  sim.external(SVC, { cmd: 'set-load', level });
  sim.runSteps(3); // drain the two externals + the queued first arrival cannot pass `t`
  sim.runUntil(t);
  return sim.getState(SVC);
}

describe('load module invariants', () => {
  test('(a) percentile ordering: p50 <= p95 <= p99 <= max', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 1, max: 20 }), (seed, level) => {
        const s = runSteps(seed, level, 2, true, 800);
        const lat = s.user.map((c) => c.lat);
        if (lat.length === 0) return;
        expect(percentile(lat, 50)).toBeLessThanOrEqual(percentile(lat, 95));
        expect(percentile(lat, 95)).toBeLessThanOrEqual(percentile(lat, 99));
        expect(percentile(lat, 99)).toBeLessThanOrEqual(Math.max(...lat));
      }),
      { numRuns: 40 },
    );
  });

  test('(b) response >= service: all recorded latencies >= 1 tick', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1000 }), (seed) => {
        const s = runSteps(seed, 12, 2, true, 800);
        for (const c of s.user) expect(c.lat).toBeGreaterThanOrEqual(1);
        for (const b of s.backend) expect(b).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 40 },
    );
  });

  test('(c) server-count monotonicity by coupling: by time T, c+1 completes >= as many as c', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 8, max: 18 }), (seed, level) => {
        // Same seed + same command times => identical arrival + service stream (service drawn at
        // arrival, arrival draws independent of server count). More servers => each request
        // completes no later (FIFO coupling) => at least as many done by any fixed time T.
        const T = 4000;
        const c1 = runToTime(seed, level, 1, T);
        const c2 = runToTime(seed, level, 2, T);
        expect(c2.completed).toBeGreaterThanOrEqual(c1.completed);
      }),
      { numRuns: 40 },
    );
  });

  test('(d) utilisation bound: busyTicks <= servers * elapsed (servers constant)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 3 }),
        (seed, level, c) => {
          const s = runSteps(seed, level, c, true, 800);
          expect(s.busyTicks).toBeLessThanOrEqual(s.servers * s.lastEventT + 1e-9);
        },
      ),
      { numRuns: 40 },
    );
  });
});
