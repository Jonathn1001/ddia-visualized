// src/modules/lease.test.ts
import { expect, test } from 'vitest';
import { SeededRng, Simulation } from '../engine';
import { lease, type LeaseState, type LockState, type StoreState, type WorkerState } from './lease';
import { LEASE_TOPOLOGY, LEASE_TTL, LOCK, STORE, W1, W2, type LeasePayload } from './lease-shared';

export function fresh(seed = 8000) {
  const sim = new Simulation<LeaseState, LeasePayload>({
    module: lease,
    config: { nodeIds: LEASE_TOPOLOGY },
    seed,
  });
  sim.runSteps(LEASE_TOPOLOGY.length); // deliver inits
  return sim;
}

export const lockOf = (sim: ReturnType<typeof fresh>) => sim.getState(LOCK) as LockState;
export const workerOf = (sim: ReturnType<typeof fresh>, id: string) => sim.getState(id) as WorkerState;
export const storeOf = (sim: ReturnType<typeof fresh>) => sim.getState(STORE) as StoreState;

/** Run the sim forward until cond holds or the event budget runs dry (loud on timeout). */
export function until(sim: ReturnType<typeof fresh>, cond: () => boolean, budget = 2000) {
  for (let i = 0; i < budget && !cond(); i++) {
    if (sim.pending === 0) break; // nothing scheduled — advancing can't help
    sim.runSteps(1);
  }
  if (!cond()) throw new Error(`until(): condition not reached (time=${sim.time}, pending=${sim.pending})`);
}

test('init assigns roles by node id', () => {
  const sim = fresh();
  expect(lockOf(sim).role).toBe('lock');
  expect(workerOf(sim, W1).role).toBe('worker');
  expect(workerOf(sim, W2).role).toBe('worker');
  expect(storeOf(sim).role).toBe('store');
});

test('acquire → grant: the Lock hands out token 1 with the TTL and arms expiry', () => {
  const sim = fresh();
  sim.external(W1, { cmd: 'acquire' });
  until(sim, () => workerOf(sim, W1).state === 'holding');
  const lock = lockOf(sim);
  expect(lock.holder).toBe(W1);
  expect(lock.token).toBe(1);
  expect(lock.expiresAt).not.toBeNull();
  expect(workerOf(sim, W1).token).toBe(1);
  expect(workerOf(sim, W1).ttl).toBe(LEASE_TTL);
});

test('a second acquire queues; expiry hands the lease over with the next token', () => {
  const sim = fresh();
  sim.external(W1, { cmd: 'acquire' });
  until(sim, () => lockOf(sim).holder === W1);
  sim.external(W2, { cmd: 'acquire' });
  until(sim, () => lockOf(sim).queue.includes(W2));
  until(sim, () => lockOf(sim).holder === W2, 2000);
  expect(lockOf(sim).token).toBe(2);
  expect(lockOf(sim).queue).toEqual([]);
});

test('a stale expiry timer (older token) is ignored after a re-grant', () => {
  const sim = fresh();
  sim.external(W1, { cmd: 'acquire' });
  until(sim, () => lockOf(sim).holder === W1);
  sim.external(W2, { cmd: 'acquire' });
  // let the first lease expire and W2 take over
  until(sim, () => lockOf(sim).holder === W2, 2000);
  const tokenAfter = lockOf(sim).token;
  // run well past where W1's old expiry timer would fire again if mishandled
  sim.runUntil(sim.time + LEASE_TTL / 2);
  expect(lockOf(sim).token).toBe(tokenAfter);
  expect(lockOf(sim).holder).toBe(W2); // still W2 — old timer didn't evict it early
});

test('sim virtual time actually advances under this module (unlike Ch7)', () => {
  const sim = fresh();
  const t0 = sim.time;
  sim.external(W1, { cmd: 'acquire' });
  until(sim, () => workerOf(sim, W1).state === 'holding');
  expect(sim.time).toBeGreaterThan(t0);
});

test('a second gc-pause before the wake fires delays the backlog but never loses it', () => {
  const sim = fresh();
  sim.external(W1, { cmd: 'acquire' });
  sim.runSteps(1); // acquire message is now in flight toward the Lock
  sim.external(W1, { fault: 'gc-pause', ticks: 30 }); // grant will arrive mid-pause → deferred
  until(sim, () => sim.time >= 10, 200);
  sim.external(W1, { fault: 'gc-pause', ticks: 100 }); // extends past the first wake
  until(sim, () => workerOf(sim, W1).state === 'holding', 4000); // the grant must survive both pauses
  expect(workerOf(sim, W1).token).toBe(1);
});

test('an acquire from the recorded holder releases and re-serves instead of vanishing', () => {
  const sim = fresh();
  sim.external(W1, { fault: 'clock-skew', rate: 4 }); // fast clock: drops the lease early
  sim.external(W1, { cmd: 'acquire' });
  until(sim, () => workerOf(sim, W1).state === 'holding');
  until(sim, () => workerOf(sim, W1).state === 'idle', 2000); // fast clock gave it up early
  sim.external(W1, { cmd: 'acquire' }); // Lock still thinks W1 holds token 1
  until(sim, () => workerOf(sim, W1).state === 'holding' && workerOf(sim, W1).token === 2, 4000);
  expect(lockOf(sim).holder).toBe(W1);
  expect(lockOf(sim).token).toBe(2);
});

test('a duplicated acquire cannot desync worker and lock tokens', () => {
  const sim = fresh();
  sim.control({ type: 'net', opts: { duplicateRate: 1 } });
  sim.external(W1, { cmd: 'acquire' });
  until(sim, () => workerOf(sim, W1).state === 'holding', 4000);
  // let the duplicated acquire arrive and get re-served (token bumps to 2)…
  until(sim, () => lockOf(sim).token === 2, 4000);
  // …then the re-served grant must land: the worker adopts the higher token
  until(sim, () => workerOf(sim, W1).token === lockOf(sim).token, 4000);
  expect(lockOf(sim).holder).toBe(W1);
});

test('a stale reject (older token) cannot evict a fresh lease', () => {
  const sim = fresh();
  sim.external(W1, { cmd: 'acquire' });
  until(sim, () => workerOf(sim, W1).state === 'holding');
  const w = workerOf(sim, W1);
  // hand-deliver a stale reject for a token the worker no longer uses
  sim.external(W1, { fault: 'clock-skew', rate: 1 }); // no-op spacer keeps external ordering obvious
  // real path: inject via the module's message shape — simulate with a direct external is not possible,
  // so drive it through state: the guard is unit-visible via applying reduce directly.
  const rng = new SeededRng(1);
  const [after] = lease.reduce(w, { kind: 'message', self: W1, from: STORE, time: sim.time, payload: { kind: 'reject', token: 999 } }, rng);
  expect((after as WorkerState).state).toBe('holding'); // token 999 ≠ 1 → ignored
  const [after2] = lease.reduce(w, { kind: 'message', self: W1, from: STORE, time: sim.time, payload: { kind: 'reject', token: w.token as number } }, rng);
  expect((after2 as WorkerState).state).toBe('idle'); // matching token → honored
});
