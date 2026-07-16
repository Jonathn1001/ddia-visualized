// src/modules/lease-lesson.test.ts
// The Ch8 lesson, pinned: a lock + lease is not enough; fencing tokens are.
import { expect, test } from 'vitest';
import { Simulation } from '../engine';
import { lease, type LeaseState, type LockState, type StoreState, type WorkerState } from './lease';
import { LEASE_TOPOLOGY, LEASE_TTL, LOCK, STORE, W1, W2, type LeasePayload } from './lease-shared';

function fresh(seed: number) {
  const sim = new Simulation<LeaseState, LeasePayload>({ module: lease, config: { nodeIds: LEASE_TOPOLOGY }, seed });
  sim.runSteps(LEASE_TOPOLOGY.length);
  return sim;
}
const lockOf = (sim: ReturnType<typeof fresh>) => sim.getState(LOCK) as LockState;
const workerOf = (sim: ReturnType<typeof fresh>, id: string) => sim.getState(id) as WorkerState;
const storeOf = (sim: ReturnType<typeof fresh>) => sim.getState(STORE) as StoreState;
function until(sim: ReturnType<typeof fresh>, cond: () => boolean, budget = 2000) {
  for (let i = 0; i < budget && !cond(); i++) {
    if (sim.pending === 0) break;
    sim.runSteps(1);
  }
  if (!cond()) throw new Error(`until(): condition not reached (time=${sim.time}, pending=${sim.pending})`);
}

function fig84(fencing: boolean) {
  const sim = fresh(8042);
  if (fencing) {
    sim.external(STORE, { cmd: 'fencing', on: true });
    sim.runSteps(1);
  }
  sim.external(W1, { cmd: 'acquire' });
  until(sim, () => workerOf(sim, W1).working === true, 2000);
  sim.external(W1, { fault: 'gc-pause', ticks: LEASE_TTL * 3 });
  sim.external(W2, { cmd: 'acquire' });
  until(sim, () => lockOf(sim).holder === W2, 4000);
  until(sim, () => storeOf(sim).lastToken === 2, 4000);
  // wake + drain
  until(sim, () => storeOf(sim).history.some((h) => h.writer === W1 && h.token === 1 && h.at > LEASE_TTL), 8000);
  return sim;
}

test('pinned: fencing OFF — the paused worker corrupts the store on wake', () => {
  const sim = fig84(false);
  const st = storeOf(sim);
  expect(st.staleAccepts).toBe(1);
  const stale = st.history.find((h) => h.outcome === 'stale');
  expect(stale?.writer).toBe(W1);
  expect(stale?.token).toBe(1);
});

test('pinned: fencing ON — the same wake-up write bounces off the token check', () => {
  const sim = fig84(true);
  const st = storeOf(sim);
  expect(st.staleAccepts).toBe(0);
  expect(st.rejects).toBeGreaterThanOrEqual(1);
  const rejected = st.history.find((h) => h.outcome === 'rejected');
  expect(rejected?.writer).toBe(W1);
  expect(st.history.filter((h) => h.writer === W2).every((h) => h.outcome === 'ok')).toBe(true);
});

test('pinned: a slow clock corrupts without any pause (fencing OFF)', () => {
  const sim = fresh(8043);
  sim.external(W1, { fault: 'clock-skew', rate: 0.5 });
  sim.external(W1, { cmd: 'acquire' });
  until(sim, () => workerOf(sim, W1).state === 'holding');
  sim.external(W2, { cmd: 'acquire' });
  until(sim, () => storeOf(sim).staleAccepts >= 1, 8000);
  expect(workerOf(sim, W1).pausedUntil).toBeNull();
});
