import { describe, expect, test } from 'vitest';
import { Simulation } from '../engine';
import { LOAD_NODES, SVC, CACHE_TICKS, SERVICE_MEAN, type LoadInspect, type LoadState } from './load-shared';
import { load, type LoadPayload } from './load';

function makeSim(seed = 1) {
  return new Simulation<LoadState, LoadPayload>({ module: load, config: { nodeIds: LOAD_NODES }, seed });
}
const svc = (sim: Simulation<LoadState, LoadPayload>) => sim.getState(SVC);
const view = (sim: Simulation<LoadState, LoadPayload>) => load.inspect(svc(sim)) as unknown as LoadInspect;

// ---- Task 2: queue mechanics ----
describe('boot arms the arrival loop', () => {
  test('requests complete under load; inService never exceeds servers', () => {
    const sim = makeSim();
    sim.runSteps(1); // init
    sim.external(SVC, { cmd: 'set-load', level: 18 }); // overload c=1
    sim.runSteps(400);
    const v = view(sim);
    expect(v.completed).toBeGreaterThan(0);
    expect(v.inService).toBeLessThanOrEqual(v.servers);
  });
});

describe('response time >= service time (wait never negative)', () => {
  test('every recorded user + backend latency is >= 1 tick', () => {
    const sim = makeSim();
    sim.runSteps(1);
    sim.external(SVC, { cmd: 'set-load', level: 10 });
    sim.runSteps(600);
    const s = svc(sim);
    for (const c of s.user) expect(c.lat).toBeGreaterThanOrEqual(1);
    for (const b of s.backend) expect(b).toBeGreaterThanOrEqual(1);
  });
});

describe('percentile ordering holds on a real run', () => {
  test('p50 <= p95 <= p99', () => {
    const sim = makeSim();
    sim.runSteps(1);
    sim.external(SVC, { cmd: 'set-load', level: 16 });
    sim.runSteps(1000);
    const v = view(sim);
    expect(v.p50).toBeLessThanOrEqual(v.p95);
    expect(v.p95).toBeLessThanOrEqual(v.p99);
  });
});

describe('queue drains when load is low, backs up when high', () => {
  test('high load builds a bigger queue than low load', () => {
    const hi = makeSim();
    hi.runSteps(1);
    hi.external(SVC, { cmd: 'set-load', level: 19 });
    hi.runSteps(1500);
    const lo = makeSim();
    lo.runSteps(1);
    lo.external(SVC, { cmd: 'set-load', level: 3 });
    lo.runSteps(1500);
    expect(view(hi).queueLen).toBeGreaterThan(view(lo).queueLen);
  });
});

// ---- Task 3: knob behaviours ----
describe('cache bypass', () => {
  test('h=1: no job ever waits in the queue and latencies are ~CACHE_TICKS', () => {
    const sim = makeSim();
    sim.runSteps(1);
    sim.external(SVC, { cmd: 'set-cache', h: 1 });
    sim.external(SVC, { cmd: 'set-load', level: 19 });
    sim.runSteps(1000);
    const s = svc(sim);
    expect(s.queue.length).toBe(0);
    expect(Math.max(...s.user.map((c) => c.lat))).toBeLessThanOrEqual(CACHE_TICKS);
  });
});

describe('fan-out join', () => {
  test('user latency = max of its N children, so user p50 >= backend p50', () => {
    const sim = makeSim();
    sim.runSteps(1);
    sim.external(SVC, { cmd: 'set-servers', c: 8 });
    sim.external(SVC, { cmd: 'set-fanout', n: 5 });
    sim.external(SVC, { cmd: 'set-load', level: 4 }); // low load: backend unsaturated
    sim.runSteps(3000);
    const v = view(sim);
    expect(v.completed).toBeGreaterThan(0);
    expect(v.p50).toBeGreaterThanOrEqual(v.bp50); // max-of-N is never below a single sample's median
  });
});

describe('variance off = deterministic service', () => {
  test('variance off with no queueing gives a tight tail (p99 ~ p50)', () => {
    const sim = makeSim();
    sim.runSteps(1);
    sim.external(SVC, { cmd: 'set-variance', on: false });
    sim.external(SVC, { cmd: 'set-servers', c: 4 });
    sim.external(SVC, { cmd: 'set-load', level: 6 }); // ρ well under 1
    sim.runSteps(3000);
    const v = view(sim);
    expect(v.p99).toBeLessThanOrEqual(v.p50 * 2 + SERVICE_MEAN);
  });
});

// ---- Task 4: challenge epoch gating ----
describe('challenge epoch gating', () => {
  test('set-load resets C1 flags (fresh knee attempt)', () => {
    const sim = makeSim();
    sim.runSteps(1);
    sim.external(SVC, { cmd: 'set-load', level: 18 });
    sim.runSteps(3000);
    sim.external(SVC, { cmd: 'set-load', level: 5 });
    sim.runSteps(2);
    expect(svc(sim).ch.c1.breached).toBe(false);
  });
  test('set-variance on resets C2 flags', () => {
    const sim = makeSim();
    sim.runSteps(1);
    sim.external(SVC, { cmd: 'set-variance', on: true });
    sim.runSteps(2);
    expect(svc(sim).ch.c2).toEqual({ hiTail: false, loTail: false });
  });
});
