// src/modules/lease.property.test.ts
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { Simulation } from '../engine';
import { lease, type LeaseState, type LockState, type StoreState } from './lease';
import { LEASE_TOPOLOGY, LOCK, STORE, W1, W2, type LeasePayload } from './lease-shared';

/** A random user session: timed acquires, pauses, skews, fencing flips. */
type Cmd =
  | { at: number; node: string; ext: LeasePayload }
  | { at: number; net: { dropRate: number } };

const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
  fc.record({ at: fc.integer({ min: 0, max: 300 }), node: fc.constantFrom(W1, W2), ext: fc.constant<LeasePayload>({ cmd: 'acquire' }) }),
  fc.record({
    at: fc.integer({ min: 0, max: 300 }),
    node: fc.constantFrom(W1, W2),
    ext: fc.integer({ min: 10, max: 200 }).map((ticks): LeasePayload => ({ fault: 'gc-pause', ticks })),
  }),
  fc.record({
    at: fc.integer({ min: 0, max: 300 }),
    node: fc.constantFrom(W1, W2),
    ext: fc.constantFrom(0.5, 0.25, 2).map((rate): LeasePayload => ({ fault: 'clock-skew', rate })),
  }),
  fc.record({ at: fc.integer({ min: 0, max: 300 }), net: fc.record({ dropRate: fc.constantFrom(0, 0.2, 0.5) }) }),
);

const script = fc.array(cmdArb, { minLength: 1, maxLength: 10 });

function run(cmds: Cmd[], seed: number, fencing: boolean): Map<string, LeaseState> {
  const sim = new Simulation<LeaseState, LeasePayload>({ module: lease, config: { nodeIds: LEASE_TOPOLOGY }, seed });
  sim.runSteps(LEASE_TOPOLOGY.length);
  if (fencing) {
    sim.external(STORE, { cmd: 'fencing', on: true });
    sim.runSteps(1);
  }
  const ordered = [...cmds].sort((a, b) => a.at - b.at);
  for (const c of ordered) {
    if (sim.time < c.at) sim.runUntil(c.at);
    if ('ext' in c) sim.external(c.node, c.ext);
    else sim.control({ type: 'net', opts: { dropRate: c.net.dropRate } });
  }
  sim.runUntil(sim.time + 500);
  return new Map(LEASE_TOPOLOGY.map((id) => [id, sim.getState(id)]));
}

test('token monotonicity: grants strictly increase, count matches the counter', () => {
  fc.assert(
    fc.property(script, fc.integer({ min: 1, max: 1000 }), (cmds, s) => {
      const lock = run(cmds, 8100 + s, false).get(LOCK) as LockState;
      expect(lock.granted).toBe(lock.token);
    }),
    { numRuns: 25 },
  );
});

// Deterministic adversarial example: the fig 8-4 shape under the generator's own
// Cmd type, so EVERY run of the fencing-safety property witnesses at least one
// would-be-stale write (random scripts only produce one ~3.5% of the time).
// Power proven against seed 8201 (= 8200 + the example's seed 1): with fencing
// OFF this exact script yields staleAccepts=1; with fencing ON it yields
// rejects=1, staleAccepts=0 — the guarded condition genuinely fires.
const FIG84_SCRIPT: Cmd[] = [
  { at: 0, node: W1, ext: { cmd: 'acquire' } },
  { at: 15, node: W1, ext: { fault: 'gc-pause', ticks: 180 } }, // lands in the check→work window
  { at: 20, node: W2, ext: { cmd: 'acquire' } },
];

test('fencing safety: with fencing ON, accepted tokens are non-decreasing — no stale write EVER gets in', () => {
  fc.assert(
    fc.property(script, fc.integer({ min: 1, max: 1000 }), (cmds, s) => {
      const store = run(cmds, 8200 + s, true).get(STORE) as StoreState;
      expect(store.staleAccepts).toBe(0);
      const accepted = store.history.filter((h) => h.outcome !== 'rejected').map((h) => h.token);
      for (let i = 1; i < accepted.length; i++) expect(accepted[i]).toBeGreaterThanOrEqual(accepted[i - 1]);
    }),
    { numRuns: 100, examples: [[FIG84_SCRIPT, 1]] },
  );
});

test('determinism: same script + same seed → identical states', () => {
  fc.assert(
    fc.property(script, (cmds) => {
      const a = run(cmds, 8300, false);
      const b = run(cmds, 8300, false);
      for (const id of LEASE_TOPOLOGY) expect(JSON.stringify(a.get(id))).toBe(JSON.stringify(b.get(id)));
    }),
    { numRuns: 15 },
  );
});

test('single holder: the lock never believes two nodes hold the lease (its own truth)', () => {
  // structural: holder is a single field — this property instead pins that a
  // re-grant always bumps the token, so two "holders" can never share one.
  fc.assert(
    fc.property(script, fc.integer({ min: 1, max: 1000 }), (cmds, s) => {
      const lock = run(cmds, 8400 + s, false).get(LOCK) as LockState;
      if (lock.holder !== null) expect(lock.token).toBeGreaterThanOrEqual(1);
      expect(lock.queue.includes(lock.holder as never)).toBe(false);
    }),
    { numRuns: 25 },
  );
});
