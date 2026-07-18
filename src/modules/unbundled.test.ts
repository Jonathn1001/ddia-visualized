import { describe, expect, test } from 'vitest';
import { Simulation } from '../engine';
import {
  ADVANCE_EVERY,
  DB,
  SEED_WRITES,
  UNBUNDLED_NODES,
  deriveAnalytics,
  deriveCache,
  deriveSearch,
} from './unbundled-shared';
import { unbundled, type DbInspect, type DbState, type UnbundledPayload } from './unbundled';

function makeSim(seed = 1): Simulation<DbState, UnbundledPayload> {
  return new Simulation<DbState, UnbundledPayload>({ module: unbundled, config: { nodeIds: UNBUNDLED_NODES }, seed });
}
/** Drain the init event (arms the 3 advance timers), leaving views caught up to the seed. */
function boot(sim: Simulation<DbState, UnbundledPayload>) {
  sim.runSteps(UNBUNDLED_NODES.length);
}
const db = (sim: Simulation<DbState, UnbundledPayload>) => sim.getState(DB);

describe('init', () => {
  test('log holds the seed; views start caught up to it', () => {
    const sim = makeSim();
    boot(sim);
    const s = db(sim);
    expect(s.log).toHaveLength(SEED_WRITES.length);
    expect(s.log[0]).toEqual({ offset: 0, key: SEED_WRITES[0].key, value: SEED_WRITES[0].value });
    // views caught up: offset == head, contents == derive(seed)
    expect(s.search.offset).toBe(SEED_WRITES.length);
    expect(s.cache.map).toEqual(deriveCache(s.log));
    expect(s.analytics.tally).toEqual(deriveAnalytics(s.log));
    expect(s.search.index).toEqual(deriveSearch(s.log));
    for (const v of [s.search, s.cache, s.analytics]) {
      expect(v.paused).toBe(false);
      expect(v.dedup).toBe(false);
    }
  });
  test('inspect exposes head + per-view offset/paused/dedup + contents', () => {
    const sim = makeSim();
    boot(sim);
    const tree = unbundled.inspect(db(sim)) as unknown as DbInspect;
    expect(tree.head).toBe(SEED_WRITES.length);
    expect(tree.cache.offset).toBe(SEED_WRITES.length);
    expect(tree.analytics.tally).toEqual(deriveAnalytics(db(sim).log));
  });
});

describe('write appends to the log and bumps head; views trail', () => {
  test('a fresh write is in the log immediately but not yet in a paused view', () => {
    const sim = makeSim();
    boot(sim);
    sim.external(DB, { cmd: 'pause', view: 'cache' });
    sim.external(DB, { cmd: 'write', key: 'p9', value: { title: 'kafka streams', category: 'tool' } });
    sim.runSteps(2); // drain the two queued external events (Simulation.external() only enqueues — see sim.ts)
    const s = db(sim);
    expect(s.log.at(-1)!.key).toBe('p9'); // source of truth has it
    expect(s.cache.map['p9']).toBeUndefined(); // paused view has NOT caught up
    expect(s.log.length - s.cache.offset).toBeGreaterThanOrEqual(1); // lag > 0
  });
});

describe('advance timer catches an unpaused view up to head', () => {
  test('after enough ticks every view equals its reference derivation', () => {
    const sim = makeSim();
    boot(sim);
    sim.external(DB, { cmd: 'write', key: 'p9', value: { title: 'kafka streams', category: 'tool' } });
    sim.runSteps(ADVANCE_EVERY * 30); // plenty of advance fires
    const s = db(sim);
    expect(s.cache.offset).toBe(s.log.length);
    expect(s.cache.map).toEqual(deriveCache(s.log));
    expect(s.search.index).toEqual(deriveSearch(s.log));
    expect(s.analytics.tally).toEqual(deriveAnalytics(s.log));
  });
  test('a paused view holds its offset while others advance', () => {
    const sim = makeSim();
    boot(sim);
    sim.external(DB, { cmd: 'pause', view: 'search' });
    sim.external(DB, { cmd: 'write', key: 'p9', value: { title: 'kafka streams', category: 'tool' } });
    const before = db(sim).search.offset;
    sim.runSteps(ADVANCE_EVERY * 30);
    const s = db(sim);
    expect(s.search.offset).toBe(before); // frozen
    expect(s.cache.offset).toBe(s.log.length); // caught up
  });
});

describe('resume drains the backlog', () => {
  test('resuming a paused view lets it catch up', () => {
    const sim = makeSim();
    boot(sim);
    sim.external(DB, { cmd: 'pause', view: 'cache' });
    sim.external(DB, { cmd: 'write', key: 'p9', value: { title: 'redis stream', category: 'tool' } });
    sim.runSteps(ADVANCE_EVERY * 5);
    expect(db(sim).cache.map['p9']).toBeUndefined();
    sim.external(DB, { cmd: 'resume', view: 'cache' });
    sim.runSteps(ADVANCE_EVERY * 30);
    expect(db(sim).cache.map['p9']).toEqual({ title: 'redis stream', category: 'tool' });
  });
});
