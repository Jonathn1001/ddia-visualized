import { describe, expect, test } from 'vitest';
import { Simulation } from '../engine';
import { ADVANCE_EVERY, DB, UNBUNDLED_NODES, deriveAnalytics, deriveCache } from './unbundled-shared';
import { unbundled, type DbState, type UnbundledPayload } from './unbundled';

function boot(seed = 7): Simulation<DbState, UnbundledPayload> {
  const sim = new Simulation<DbState, UnbundledPayload>({ module: unbundled, config: { nodeIds: UNBUNDLED_NODES }, seed });
  sim.runSteps(UNBUNDLED_NODES.length);
  return sim;
}
const db = (sim: Simulation<DbState, UnbundledPayload>) => sim.getState(DB);

describe('C1 — stale read (read-your-writes)', () => {
  test('paused search misses a fresh key the log already has, then hits after resume', () => {
    const sim = boot();
    sim.external(DB, { cmd: 'pause', view: 'search' });
    sim.external(DB, { cmd: 'write', key: 'p9', value: { title: 'zookeeper quorum', category: 'tool' } });
    // drain: both externals are queued at the current virtual time, strictly before the
    // t=ADVANCE_EVERY advance timers — 2 steps lands exactly the pause + the write without
    // letting any advance timer fire (Simulation.external() only enqueues — see sim.ts).
    sim.runSteps(2);
    // MISS: the log has p9, but the paused index does not.
    expect(db(sim).log.some((r) => r.key === 'p9')).toBe(true);
    expect(db(sim).search.index['zookeeper']).toBeUndefined();
    // Resume + play → HIT.
    sim.external(DB, { cmd: 'resume', view: 'search' });
    sim.runSteps(ADVANCE_EVERY * 40);
    expect(db(sim).search.index['zookeeper']).toEqual(['p9']);
  });
});

describe('C2 — rebuild from log', () => {
  test('a wiped cache rebuilds byte-exact and offset returns to head', () => {
    const sim = boot();
    sim.external(DB, { cmd: 'write', key: 'p9', value: { title: 'materialize view', category: 'book' } });
    sim.runSteps(ADVANCE_EVERY * 30);
    sim.external(DB, { cmd: 'wipe', view: 'cache' });
    // drain: one same-tick advance timer was already queued ahead of this external (lower
    // seq at the same virtual time), then the wipe command itself (Simulation.external()
    // only enqueues — see sim.ts). Without this the assert below reads the pre-wipe cache.
    sim.runSteps(2);
    expect(db(sim).cache.map).toEqual({});
    sim.runSteps(ADVANCE_EVERY * 40);
    const s = db(sim);
    expect(s.cache.offset).toBe(s.log.length);
    expect(s.cache.map).toEqual(deriveCache(s.log));
  });
});

describe('C3 — exactly-once', () => {
  test('over-count with dedup off; exact after dedup on + rebuild + redeliver', () => {
    const sim = boot();
    sim.external(DB, { cmd: 'write', key: 'p9', value: { title: 'debezium cdc', category: 'book' } });
    sim.runSteps(ADVANCE_EVERY * 30);
    // Phase A: dedup off, redeliver → over-count.
    sim.external(DB, { cmd: 'redeliver', view: 'analytics' });
    // drain: one same-tick advance timer was already queued ahead of this external (lower
    // seq at the same virtual time), then the redeliver command itself (Simulation.external()
    // only enqueues — see sim.ts). Without this the redeliver never runs and the +1 below
    // would fail against an already-exact tally.
    sim.runSteps(2);
    expect(db(sim).analytics.tally.book).toBe(deriveAnalytics(db(sim).log).book + 1);
    // Phase B: dedup on, wipe+replay to truth, redeliver again → stays exact.
    sim.external(DB, { cmd: 'toggle-dedup', view: 'analytics' });
    sim.external(DB, { cmd: 'wipe', view: 'analytics' });
    sim.runSteps(ADVANCE_EVERY * 40);
    sim.external(DB, { cmd: 'redeliver', view: 'analytics' });
    // drain: same reasoning as Phase A — without this the redeliver command is still queued
    // and the assert below would pass trivially (nothing yet re-applied to double-count),
    // instead of proving dedup actually absorbs the redelivery.
    sim.runSteps(2);
    expect(db(sim).analytics.tally).toEqual(deriveAnalytics(db(sim).log));
  });
});
