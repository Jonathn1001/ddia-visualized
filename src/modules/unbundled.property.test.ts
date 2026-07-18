import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { Simulation } from '../engine';
import {
  ADVANCE_EVERY,
  CATEGORIES,
  DB,
  UNBUNDLED_NODES,
  VIEWS,
  deriveAnalytics,
  deriveCache,
  deriveSearch,
  type Category,
} from './unbundled-shared';
import { unbundled, type DbState, type UnbundledPayload } from './unbundled';

function makeSim(seed: number): Simulation<DbState, UnbundledPayload> {
  const sim = new Simulation<DbState, UnbundledPayload>({ module: unbundled, config: { nodeIds: UNBUNDLED_NODES }, seed });
  sim.runSteps(UNBUNDLED_NODES.length);
  return sim;
}
const CATZ: Category[] = CATEGORIES;
// A small script of writes: (key p0..p5, title from a tiny vocab, category).
const writeArb = fc.record({
  key: fc.integer({ min: 0, max: 5 }).map((n) => `p${n}`),
  title: fc.subarray(['raft', 'kafka', 'spark', 'flink', 'redis', 'saga'], { minLength: 1, maxLength: 2 }).map((ws) => ws.join(' ')),
  category: fc.constantFrom(...CATZ),
});
const scriptArb = fc.array(writeArb, { minLength: 1, maxLength: 8 });

function applyWrites(
  sim: Simulation<DbState, UnbundledPayload>,
  writes: { key: string; title: string; category: Category }[],
) {
  for (const w of writes) sim.external(DB, { cmd: 'write', key: w.key, value: { title: w.title, category: w.category } });
}
const CATCHUP = ADVANCE_EVERY * 60;

describe('property: eventual consistency', () => {
  test('after full catch-up every view equals its reference derivation', () => {
    fc.assert(
      fc.property(scriptArb, fc.integer({ min: 1, max: 999 }), (writes, seed) => {
        const sim = makeSim(seed);
        applyWrites(sim, writes);
        sim.runSteps(CATCHUP);
        const s = sim.getState(DB);
        expect(s.cache.map).toEqual(deriveCache(s.log));
        expect(s.analytics.tally).toEqual(deriveAnalytics(s.log));
        expect(s.search.index).toEqual(deriveSearch(s.log));
      }),
      { numRuns: 40 },
    );
  });
});

describe('property: rebuild exactness', () => {
  test('wiping any view at any time then replaying is exact', () => {
    fc.assert(
      fc.property(scriptArb, fc.constantFrom(...VIEWS), fc.integer({ min: 1, max: 999 }), (writes, view, seed) => {
        const sim = makeSim(seed);
        applyWrites(sim, writes);
        sim.runSteps(ADVANCE_EVERY * 10); // partial progress
        sim.external(DB, { cmd: 'wipe', view });
        sim.runSteps(CATCHUP);
        const s = sim.getState(DB);
        if (view === 'cache') expect(s.cache.map).toEqual(deriveCache(s.log));
        else if (view === 'analytics') expect(s.analytics.tally).toEqual(deriveAnalytics(s.log));
        else expect(s.search.index).toEqual(deriveSearch(s.log));
      }),
      { numRuns: 40 },
    );
  });
});

describe('property: exactly-once under dedup', () => {
  test('with dedup on, any number of redelivers leaves analytics exact', () => {
    fc.assert(
      fc.property(scriptArb, fc.integer({ min: 1, max: 6 }), fc.integer({ min: 1, max: 999 }), (writes, redeliveries, seed) => {
        const sim = makeSim(seed);
        applyWrites(sim, writes);
        sim.runSteps(CATCHUP);
        sim.external(DB, { cmd: 'toggle-dedup', view: 'analytics' });
        for (let i = 0; i < redeliveries; i++) sim.external(DB, { cmd: 'redeliver', view: 'analytics' });
        // Simulation.external() only enqueues — commands are processed on the next
        // runSteps(). Without draining here, the toggle + redelivers above would sit
        // unprocessed in the queue and this assertion would trivially compare the
        // already-caught-up post-CATCHUP state to itself, never exercising dedup at
        // all. Drain them: up to VIEWS.length-1 same-tick "advance" timers can be
        // queued ahead of our externals (same virtual time, lower seq), so budget a
        // margin above the strict "1 toggle + N redelivers" minimum.
        sim.runSteps(redeliveries + 5);
        expect(sim.getState(DB).analytics.tally).toEqual(deriveAnalytics(sim.getState(DB).log));
      }),
      { numRuns: 40 },
    );
  });
});
