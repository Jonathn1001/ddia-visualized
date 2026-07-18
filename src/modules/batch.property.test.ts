// src/modules/batch.property.test.ts
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { Simulation } from '../engine';
import { batch, type BatchState, type SchedState } from './batch';
import { BATCH_NODES, EXPECTED_COUNTS, JT, WORKERS, type BatchPayload } from './batch-shared';

type Cmd = { at: number; kill: string } | { at: number; revive: string };

const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
  fc.record({ at: fc.integer({ min: 5, max: 600 }), kill: fc.constantFrom(...WORKERS) }),
  fc.record({ at: fc.integer({ min: 5, max: 600 }), revive: fc.constantFrom(...WORKERS) }),
);
const script = fc.array(cmdArb, { minLength: 0, maxLength: 6 });

const jt = (sim: Simulation<BatchState, BatchPayload>) => sim.getState(JT) as SchedState;
const done = (sim: Simulation<BatchState, BatchPayload>) =>
  jt(sim).mr.completionTick !== null && jt(sim).df.completionTick !== null;

function run(cmds: Cmd[], seed: number) {
  const sim = new Simulation<BatchState, BatchPayload>({ module: batch, config: { nodeIds: BATCH_NODES }, seed });
  sim.runSteps(BATCH_NODES.length);
  sim.external(JT, { cmd: 'run-job' });
  const dead = new Set<string>();
  const ordered = [...cmds].sort((a, b) => a.at - b.at);
  for (const c of ordered) {
    for (let i = 0; i < 20000 && sim.time < c.at && sim.pending > 0; i++) sim.runSteps(1);
    if ('kill' in c && !dead.has(c.kill)) { sim.control({ type: 'kill', node: c.kill }); dead.add(c.kill); }
    else if ('revive' in c && dead.has(c.revive)) { sim.control({ type: 'revive', node: c.revive }); dead.delete(c.revive); }
  }
  for (const w of [...dead]) sim.control({ type: 'revive', node: w });
  for (let i = 0; i < 200000 && !done(sim) && sim.pending > 0; i++) sim.runSteps(1);
  return sim;
}

const countsOf = (rows: [string, number][]) => {
  const out: Record<string, number> = {};
  for (const [u, n] of rows) out[u] = (out[u] ?? 0) + n;
  return out;
};

test('(a)+(b) any kill/revive script that ends revived → both sides complete with the exact output', () => {
  fc.assert(
    fc.property(script, fc.integer({ min: 1, max: 400 }), (cmds, s) => {
      const sim = run(cmds, 10100 + s);
      expect(done(sim)).toBe(true);
      expect(countsOf(jt(sim).mr.output)).toEqual(EXPECTED_COUNTS);
      expect(countsOf(jt(sim).df.output)).toEqual(EXPECTED_COUNTS);
    }),
    { numRuns: 12 },
  );
}, 30_000);

test('(c) a single kill that triggers a dataflow restart while both jobs run → mr wastes no more than df', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 30, max: 250 }), // kill time — inside the working window
      fc.constantFrom(...WORKERS),
      fc.integer({ min: 1, max: 400 }),
      (at, w, s) => {
        const sim = run([{ at, kill: w }], 10200 + s);
        const st = jt(sim);
        // the claim only holds when the kill actually poisoned the pipeline mid-run
        if (st.df.restarts >= 1 && st.mr.completionTick !== null && st.df.completionTick !== null) {
          expect(st.mr.wasted).toBeLessThanOrEqual(st.df.wasted);
        }
      },
    ),
    { numRuns: 15 },
  );
}, 30_000);

test('(d) determinism: same script + seed → identical states', () => {
  fc.assert(
    fc.property(script, (cmds) => {
      const a = run(cmds, 10300);
      const b = run(cmds, 10300);
      for (const n of BATCH_NODES) {
        expect(JSON.stringify(a.getState(n))).toBe(JSON.stringify(b.getState(n)));
      }
    }),
    { numRuns: 8 },
  );
}, 30_000);

// Pinned regressions — exact counterexamples the property suite shrank out during
// Task 6. Each exposed a distinct recovery gap under an INVISIBLE kill+revive (one
// faster than DEAD_AFTER, so JT's ping loop never declares the death). The property
// runs above use low numRuns and won't reliably re-hit these, so pin them.
const REGRESSIONS: { name: string; seed: number; cmds: Cmd[] }[] = [
  // dropped assign-map: a fast kill drops the in-flight MR assign; JT re-drives it on ping.
  { name: 'invisible kill drops the MR assign', seed: 10268,
    cmds: [{ at: 49, kill: 'W1' }, { at: 223, revive: 'W1' }, { at: 262, kill: 'W1' }, { at: 164, kill: 'W2' }] },
  // healthy network reorder: a mapper's df-record outruns the reducer's df-start; buffered then drained.
  { name: 'healthy df-record reorder before df-start', seed: 10476, cmds: [] },
  // dropped df-start: a fast kill drops the reducer's df-start; JT re-drives df-start on ping, buffer drains.
  { name: 'invisible kill drops the df-start', seed: 10163,
    cmds: [{ at: 5, kill: 'W1' }, { at: 6, kill: 'W1' }] },
  // lost pushed record: an invisibly-killed reducer loses in-flight records; the df stall watchdog restarts.
  { name: 'invisible kill loses a pushed df record', seed: 10200,
    cmds: [{ at: 5, kill: 'W1' }, { at: 11, revive: 'W1' }] },
  // stale fetch sources: a map relocates during a blackout; JT refreshes running reducers' sources on ping.
  { name: 'blackout relocates a map under a fetching reducer', seed: 10306,
    cmds: [{ at: 136, kill: 'W1' }, { at: 6, kill: 'W2' }, { at: 131, kill: 'W3' }, { at: 542, revive: 'W1' }] },
  // stranded done-map: a re-running reduce needs a done map whose disk died and wasn't re-queued; re-run it.
  { name: 're-running reduce needs a done map whose disk is gone', seed: 10244,
    cmds: [{ at: 106, kill: 'W2' }, { at: 145, revive: 'W1' }, { at: 126, kill: 'W1' }] },
];

for (const { name, seed, cmds } of REGRESSIONS) {
  test(`regression: ${name}`, () => {
    const sim = run(cmds, seed);
    expect(done(sim)).toBe(true);
    expect(countsOf(jt(sim).mr.output)).toEqual(EXPECTED_COUNTS);
    expect(countsOf(jt(sim).df.output)).toEqual(EXPECTED_COUNTS);
  }, 30_000);
}
