import { expect, test } from 'vitest';
import { Simulation } from '../../engine';
import { pingPong, type PPPayload, type PPState } from '../../modules/pingpong';
import { SimDriver, type PublishedView } from './SimDriver';

function fakeRaf() {
  const q: (() => void)[] = [];
  return {
    raf: (cb: () => void) => {
      q.push(cb);
      return q.length;
    },
    caf: (id: number) => {
      q[id - 1] = () => undefined;
    },
    flush: () => {
      const cbs = q.splice(0, q.length);
      for (const cb of cbs) cb();
    },
  };
}

function makeDriver() {
  const views: PublishedView[] = [];
  const { raf, caf, flush } = fakeRaf();
  const sim = new Simulation<PPState, PPPayload>({
    module: pingPong,
    config: { nodeIds: ['a', 'b', 'c'] },
    seed: 42,
  });
  const driver = new SimDriver<PPState, PPPayload>({ sim, seed: 42, publish: (v) => views.push(v), raf, caf });
  return { driver, sim, views, flush };
}

test('publishes an initial view on construction', () => {
  const { views } = makeDriver();
  expect(views).toHaveLength(1);
  expect(views[0].nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
  expect(views[0].running).toBe(false);
});

test('start steps speed events per frame; pause stops stepping', () => {
  const { driver, sim, views, flush } = makeDriver();
  driver.setSpeed(5);
  driver.start();
  flush();
  expect(sim.processed).toBe(5);
  expect(views.at(-1)!.processed).toBe(5);
  driver.pause();
  flush();
  expect(sim.processed).toBe(5);
  expect(views.at(-1)!.running).toBe(false);
});

test('external and control are recorded for session export', () => {
  const { driver } = makeDriver();
  driver.control({ type: 'kill', node: 'b' });
  driver.external('a', { poke: true });
  const session = JSON.parse(driver.exportSession('learned something'));
  expect(session.seed).toBe(42);
  expect(session.actions).toEqual([
    { at: 0, type: 'control', action: { type: 'kill', node: 'b' } },
    { at: 0, type: 'external', target: 'a', payload: { poke: true } },
  ]);
  expect(session.journal).toBe('learned something');
});

test('backward scrub + new control rewrites the timeline deterministically', () => {
  const { driver, sim } = makeDriver();
  for (let i = 0; i < 100; i++) driver.stepOnce();
  expect(sim.processed).toBe(100);
  driver.scrubTo(50);
  expect(sim.processed).toBe(50);
  driver.control({ type: 'kill', node: 'c' });
  driver.stepOnce();
  expect(sim.eventLog[50]!.kind).toBe('control'); // injected action is the new event 50
});

test('metrics point per publish carries virtual time', () => {
  const { driver, views } = makeDriver();
  driver.stepOnce();
  const last = views.at(-1)!;
  expect(last.metricsHistory).toHaveLength(1);
  expect(last.metricsHistory[0].time).toBe(last.time);
});
