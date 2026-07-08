import { expect, test } from 'vitest';
import { Simulation } from './sim';
import { TimelineRecorder } from './recorder';
import { hashEventLog } from './hash';
import { chatty } from './fixtures';

const mk = () =>
  new Simulation({
    module: chatty,
    config: { nodeIds: ['a', 'b', 'c'] },
    seed: 7,
    network: { latency: [1, 10], dropRate: 0.05, duplicateRate: 0.05 },
  });

test('snapshot/restore resumes identically', () => {
  const sim = mk();
  sim.runSteps(300);
  const snap = sim.snapshot();
  sim.runSteps(200);
  const hashAhead = hashEventLog(sim.eventLog);
  sim.restore(snap);
  expect(sim.processed).toBe(300);
  sim.runSteps(200);
  expect(hashEventLog(sim.eventLog)).toBe(hashAhead);
});

test('scrubTo(k) reproduces exactly a fresh k-step run, back and forward', () => {
  const rec = new TimelineRecorder(mk(), 100);
  rec.runSteps(2500);
  const hashFull = hashEventLog(rec.sim.eventLog);

  rec.scrubTo(1234); // backward
  const fresh = mk();
  fresh.runSteps(1234);
  expect(rec.position).toBe(1234);
  expect(hashEventLog(rec.sim.eventLog)).toBe(hashEventLog(fresh.eventLog));
  expect(rec.sim.getState('b')).toEqual(fresh.getState('b'));

  rec.scrubTo(2500); // forward again
  expect(rec.position).toBe(2500);
  expect(hashEventLog(rec.sim.eventLog)).toBe(hashFull);
});

test('diverging after a backward scrub: invalidateFuture keeps scrubbing correct', () => {
  const rec = new TimelineRecorder(mk(), 100);
  rec.runSteps(1000);
  rec.scrubTo(250);
  rec.sim.control({ type: 'partition', groups: [['a'], ['b', 'c']] });
  rec.invalidateFuture();
  rec.runSteps(500);
  expect(rec.position).toBe(750);

  rec.scrubTo(600);
  const fresh = mk();
  fresh.runSteps(250);
  fresh.control({ type: 'partition', groups: [['a'], ['b', 'c']] });
  fresh.runSteps(350);
  expect(hashEventLog(rec.sim.eventLog)).toBe(hashEventLog(fresh.eventLog));
});

test('DoD: scrub across 10k events lands anywhere in under 100ms', () => {
  const rec = new TimelineRecorder(mk(), 500);
  rec.runSteps(10_000);
  for (const target of [9_999, 5_000, 1, 7_777, 0]) {
    const t0 = performance.now();
    rec.scrubTo(target);
    const dt = performance.now() - t0;
    expect(rec.position).toBe(target);
    expect(dt).toBeLessThan(100);
  }
});
