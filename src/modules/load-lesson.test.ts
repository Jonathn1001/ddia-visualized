import { describe, expect, test } from 'vitest';
import { Simulation } from '../engine';
import { LOAD_NODES, SVC, FANOUT_MIN, type LoadState } from './load-shared';
import { load, type LoadPayload } from './load';

function makeSim(seed: number) {
  const sim = new Simulation<LoadState, LoadPayload>({ module: load, config: { nodeIds: LOAD_NODES }, seed });
  sim.runSteps(1);
  return sim;
}
const flags = (sim: Simulation<LoadState, LoadPayload>) => sim.getState(SVC).ch;

describe('C1 — the knee + rescue', () => {
  test('near-capacity c=1 breaches the SLA tail, then a replica rescues it in one epoch', () => {
    const sim = makeSim(7);
    sim.external(SVC, { cmd: 'set-load', level: 12 }); // ρ(c=1) ≈ 1: the knee, queue-driven tail explosion
    sim.runSteps(6000);
    expect(flags(sim).c1.breached).toBe(true); // p99 (~241) > SLA (150)
    sim.external(SVC, { cmd: 'set-servers', c: 2 }); // ρ(c=2) ≈ 0.5
    sim.runSteps(6000);
    expect(flags(sim).c1.rescued).toBe(true); // p99 (~54) < SLA (150)
  });
});

describe('C2 — variance drives the tail', () => {
  test('variance on gives a fat tail; toggling off collapses it, in one epoch', () => {
    const sim = makeSim(11);
    sim.external(SVC, { cmd: 'set-servers', c: 4 });
    sim.external(SVC, { cmd: 'set-variance', on: true });
    sim.external(SVC, { cmd: 'set-load', level: 12 }); // ρ ≈ 0.25 so queueing isn't the cause
    sim.runSteps(6000);
    expect(flags(sim).c2.hiTail).toBe(true); // p99/p50 (~5.7) >= 3
    sim.external(SVC, { cmd: 'set-variance', on: false });
    sim.runSteps(6000);
    expect(flags(sim).c2.loTail).toBe(true); // p99/p50 (~1.0) < 1.5
  });
});

describe('C3 — tail-latency amplification', () => {
  test('fan-out makes the median user request feel the backend tail', () => {
    const sim = makeSim(5);
    sim.external(SVC, { cmd: 'set-servers', c: 12 }); // backend unsaturated (util ~0.27)
    sim.external(SVC, { cmd: 'set-variance', on: true });
    sim.external(SVC, { cmd: 'set-fanout', n: FANOUT_MIN });
    sim.external(SVC, { cmd: 'set-load', level: 2 }); // low λ; N sub-requests still fit
    sim.runSteps(30000);
    expect(flags(sim).c3.amplified).toBe(true); // user p50 (~36) >= backend p95 (~31)
  });
});
