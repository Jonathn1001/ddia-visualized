// src/modules/batch-lesson.test.ts
// Deterministic challenge-matrix choreography — the challenge-verifier contract,
// asserted clause by clause. Own helpers (do NOT import from batch.test.ts).
import { expect, test } from 'vitest';
import { Simulation } from '../engine';
import { batch, type BatchState, type SchedState } from './batch';
import { BATCH_NODES, EXPECTED_COUNTS, JT, MAP_EXEC_TICKS, type BatchPayload } from './batch-shared';

function fresh(seed: number) {
  const sim = new Simulation<BatchState, BatchPayload>({
    module: batch,
    config: { nodeIds: BATCH_NODES },
    seed,
  });
  sim.runSteps(BATCH_NODES.length);
  return sim;
}
const jt = (sim: ReturnType<typeof fresh>) => sim.getState(JT) as SchedState;
const runJob = (sim: ReturnType<typeof fresh>) => sim.external(JT, { cmd: 'run-job' });

function until(sim: ReturnType<typeof fresh>, cond: () => boolean, budget = 20000) {
  for (let i = 0; i < budget && !cond(); i++) {
    if (sim.pending === 0) break;
    sim.runSteps(1);
  }
  if (!cond()) throw new Error(`until(): not reached (time=${sim.time}, pending=${sim.pending})`);
}

const countsOf = (rows: [string, number][]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [u, n] of rows) out[u] = (out[u] ?? 0) + n;
  return out;
};

test('lesson A — rerun + damage: one kill re-executes an MR map and restarts dataflow, df wastes more', () => {
  const sim = fresh(10042);
  runJob(sim);
  // both jobs mid-flight — by construction m0 → W1 (lowest-idle) and df r0 → W1,
  // so killing W1 hits a running MR map AND live dataflow reducer state at once.
  until(sim, () => jt(sim).mr.tasks.m0.status === 'running' && jt(sim).df.execTicks > 0);
  expect(jt(sim).mr.tasks.m0.worker).toBe('W1');
  expect(jt(sim).df.placement.r0).toBe('W1');

  sim.control({ type: 'kill', node: 'W1' });
  until(sim, () => jt(sim).live.W1 === false); // ping loop declares death

  expect(jt(sim).mr.reexecuted).toBeGreaterThanOrEqual(1); // challenge 1's engine half
  expect(jt(sim).df.restarts).toBeGreaterThanOrEqual(1);

  sim.control({ type: 'revive', node: 'W1' });
  until(sim, () => jt(sim).mr.completionTick !== null && jt(sim).df.completionTick !== null, 60000);

  expect(countsOf(jt(sim).mr.output)).toEqual(EXPECTED_COUNTS);
  expect(countsOf(jt(sim).df.output)).toEqual(EXPECTED_COUNTS);
  expect(jt(sim).df.wasted).toBeGreaterThan(jt(sim).mr.wasted); // challenge 3's engine half
  expect(jt(sim).mr.wasted).toBeGreaterThan(0);
}, 30_000);

test('lesson B — done is not safe: killing a done-but-unfetched mapper re-runs its map, wasting a full attempt', () => {
  const sim = fresh(10043);
  runJob(sim);
  until(sim, () => Object.keys(jt(sim).mr.diskAt).length === 1); // first map done, shuffle not started
  const [m, w] = Object.entries(jt(sim).mr.diskAt)[0] as [string, string];

  sim.control({ type: 'kill', node: w });
  until(sim, () => jt(sim).live[w] === false);

  expect(jt(sim).mr.lostAfterDone).toBeGreaterThanOrEqual(1);
  expect(jt(sim).mr.tasks[m as 'm0'].status).not.toBe('done'); // re-queued

  sim.control({ type: 'revive', node: w });
  until(sim, () => jt(sim).mr.completionTick !== null);

  expect(countsOf(jt(sim).mr.output)).toEqual(EXPECTED_COUNTS);
  expect(jt(sim).mr.wasted).toBeGreaterThanOrEqual(MAP_EXEC_TICKS); // the full first attempt was discarded
}, 30_000);
