// src/modules/lease.test.ts
import { expect, test } from 'vitest';
import { SeededRng, Simulation } from '../engine';
import { lease, type LeaseInspect, type LeaseState, type LockState, type StoreState, type WorkerState } from './lease';
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

test('a holding worker writes to the store on its loop; fencing off accepts in-order writes as ok', () => {
  const sim = fresh();
  sim.external(W1, { cmd: 'acquire' });
  until(sim, () => storeOf(sim).history.length >= 2, 2000);
  const st = storeOf(sim);
  expect(st.history.every((h) => h.writer === W1)).toBe(true);
  expect(st.history.every((h) => h.outcome === 'ok')).toBe(true);
  expect(st.lastToken).toBe(1);
  expect(st.value).toMatch(/^W1#/);
});

test('the worker stops writing once its own clock says the lease is over', () => {
  const sim = fresh();
  sim.external(W1, { cmd: 'acquire' });
  until(sim, () => workerOf(sim, W1).state === 'holding');
  sim.runUntil(sim.time + LEASE_TTL * 3);
  expect(workerOf(sim, W1).state).toBe('idle');
  const writes = storeOf(sim).history.length;
  sim.runUntil(sim.time + LEASE_TTL);
  expect(storeOf(sim).history.length).toBe(writes); // no zombie writes
});

test('a clean handover (no faults) is anomaly-free at either fencing setting', () => {
  // W1's honest clock stops it before expiry, W2 takes over with a higher token —
  // no stale writes, no rejects. The negative baseline the fault tests corrupt.
  const sim = fresh();
  sim.external(STORE, { cmd: 'fencing', on: true });
  sim.runSteps(1);
  sim.external(W1, { cmd: 'acquire' });
  until(sim, () => lockOf(sim).holder === W1);
  sim.external(W2, { cmd: 'acquire' });
  until(sim, () => lockOf(sim).holder === W2, 3000); // W1 expired, W2 holds token 2
  until(sim, () => storeOf(sim).lastToken === 2, 2000); // W2's first write landed
  expect(storeOf(sim).rejects).toBe(0);
  expect(storeOf(sim).staleAccepts).toBe(0);
});

test('gc-pause mid-work: the worker wakes and completes the write with its stale token (fig 8-4)', () => {
  const sim = fresh();
  sim.external(W1, { cmd: 'acquire' });
  until(sim, () => workerOf(sim, W1).working === true, 2000);
  // paused past the whole lease; the work timer is in flight and will be deferred
  sim.external(W1, { fault: 'gc-pause', ticks: LEASE_TTL * 3 });
  sim.external(W2, { cmd: 'acquire' });
  until(sim, () => lockOf(sim).holder === W2, 4000);
  until(sim, () => storeOf(sim).lastToken === 2, 3000); // W2 wrote with token 2
  // let W1 wake and its deferred work timer fire
  until(sim, () => storeOf(sim).staleAccepts >= 1, 6000);
  const st = storeOf(sim);
  const stale = st.history.find((h) => h.outcome === 'stale');
  expect(stale?.writer).toBe(W1);
  expect(stale?.token).toBe(1);
  expect(stale && stale.token < st.lastToken).toBe(true);
});

test('with fencing ON the same choreography ends in a reject, not corruption', () => {
  const sim = fresh();
  sim.external(STORE, { cmd: 'fencing', on: true });
  sim.runSteps(1);
  sim.external(W1, { cmd: 'acquire' });
  until(sim, () => workerOf(sim, W1).working === true, 2000);
  sim.external(W1, { fault: 'gc-pause', ticks: LEASE_TTL * 3 });
  sim.external(W2, { cmd: 'acquire' });
  until(sim, () => storeOf(sim).lastToken === 2, 6000);
  until(sim, () => storeOf(sim).rejects >= 1, 6000);
  expect(storeOf(sim).staleAccepts).toBe(0);
  // and the rejected worker corrected its belief
  expect(workerOf(sim, W1).state).toBe('idle');
});

test('backlog preserves order: deferred events replay in arrival order at wake', () => {
  const sim = fresh();
  sim.external(W1, { cmd: 'acquire' });
  until(sim, () => workerOf(sim, W1).working === true, 2000);
  const pausedAt = sim.time;
  sim.external(W1, { fault: 'gc-pause', ticks: LEASE_TTL * 2 });
  until(sim, () => storeOf(sim).history.some((h) => h.writer === W1 && h.at > pausedAt), 6000);
  // the write that lands after the pause must come from the DEFERRED work timer —
  // i.e. the worker never re-checked (a re-check at wake would have dropped the lease)
  const w1 = workerOf(sim, W1);
  expect(w1.state).toBe('idle'); // after the backlog drained, the deferred check ended it
});

test('pausing while paused extends the pause', () => {
  const sim = fresh();
  sim.external(W1, { cmd: 'acquire' });
  until(sim, () => workerOf(sim, W1).state === 'holding');
  sim.external(W1, { fault: 'gc-pause', ticks: 50 });
  sim.runUntil(sim.time + 10);
  sim.external(W1, { fault: 'gc-pause', ticks: 200 });
  // external() only enqueues at the current virtual time (src/engine/sim.ts) — it
  // does not process the event. Step once so the second fault is actually applied
  // before we read state; every other test in this file does the same via
  // until()/runSteps() before inspecting post-external state.
  sim.runSteps(1);
  const w1 = workerOf(sim, W1);
  expect(w1.pausedUntil).not.toBeNull();
  expect(w1.pausedUntil as number).toBeGreaterThan(sim.time + 150);
});

test('a slow clock (rate 0.5) keeps the worker writing past true expiry → stale accepts, no pause involved', () => {
  const sim = fresh();
  sim.external(W1, { fault: 'clock-skew', rate: 0.5 });
  sim.external(W1, { cmd: 'acquire' });
  until(sim, () => workerOf(sim, W1).state === 'holding');
  sim.external(W2, { cmd: 'acquire' });
  // true expiry hands the lease to W2 while W1's slow clock still believes
  until(sim, () => lockOf(sim).holder === W2, 4000);
  until(sim, () => storeOf(sim).staleAccepts >= 1, 6000);
  const stale = storeOf(sim).history.find((h) => h.outcome === 'stale');
  expect(stale?.writer).toBe(W1);
  expect(workerOf(sim, W1).pausedUntil).toBeNull(); // no pause was needed
});

test('an honest clock (rate 1) never produces a stale write on its own', () => {
  const sim = fresh();
  sim.external(W1, { cmd: 'acquire' });
  sim.external(W2, { cmd: 'acquire' });
  sim.runUntil(sim.time + LEASE_TTL * 4);
  expect(storeOf(sim).staleAccepts).toBe(0);
});

test('inspect exposes the panel contract per role', () => {
  const sim = fresh();
  sim.external(W1, { cmd: 'acquire' });
  until(sim, () => workerOf(sim, W1).state === 'holding');
  const li = lease.inspect(lockOf(sim)) as unknown as LeaseInspect;
  expect(li.role).toBe('lock');
  if (li.role === 'lock') expect(li.holder).toBe(W1);
  const wi = lease.inspect(workerOf(sim, W1)) as unknown as LeaseInspect;
  expect(wi.role).toBe('worker');
  if (wi.role === 'worker') {
    expect(wi.state).toBe('holding');
    expect(wi.rate).toBe(1);
  }
  const si = lease.inspect(storeOf(sim)) as unknown as LeaseInspect;
  expect(si.role).toBe('store');
  if (si.role === 'store') expect(si.fencing).toBe(false);
});

test('metrics are namespaced: tokens granted, store outcomes, worker pause flags', () => {
  const sim = fresh();
  const states = new Map(LEASE_TOPOLOGY.map((id) => [id, sim.getState(id)] as const));
  const names = lease.metrics(states, sim.time).map((m) => m.name);
  expect(names).toEqual(
    expect.arrayContaining(['lock/tokens-granted', 'store/writes-ok', 'store/stale-accepts', 'store/rejects', 'w1/paused', 'w2/paused']),
  );
});
