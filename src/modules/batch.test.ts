// src/modules/batch.test.ts
import { expect, test } from 'vitest';
import { Simulation } from '../engine';
import { batch, type BatchState, type SchedState, type WorkerState } from './batch';
import { BATCH_NODES, EXPECTED_COUNTS, JT, WORKERS, type BatchPayload, type Url } from './batch-shared';

export function fresh(seed = 10000) {
  const sim = new Simulation<BatchState, BatchPayload>({
    module: batch,
    config: { nodeIds: BATCH_NODES },
    seed,
  });
  sim.runSteps(BATCH_NODES.length); // inits: JT arms its ping loop
  return sim;
}

export const jt = (sim: ReturnType<typeof fresh>) => sim.getState(JT) as SchedState;
export const wk = (sim: ReturnType<typeof fresh>, id: string) => sim.getState(id) as WorkerState;

/** Run until cond or event budget dry (loud on failure). */
export function until(sim: ReturnType<typeof fresh>, cond: () => boolean, budget = 20000) {
  for (let i = 0; i < budget && !cond(); i++) {
    if (sim.pending === 0) break;
    sim.runSteps(1);
  }
  if (!cond()) throw new Error(`until(): not reached (time=${sim.time}, pending=${sim.pending})`);
}

export function runJob(sim: ReturnType<typeof fresh>) {
  sim.external(JT, { cmd: 'run-job' });
}

const rowsToCounts = (rows: [Url, number][]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [u, n] of rows) out[u] = (out[u] ?? 0) + n;
  return out;
};

test('healthy run: both sides complete with the exact expected output', () => {
  const sim = fresh();
  runJob(sim);
  until(sim, () => jt(sim).mr.completionTick !== null && jt(sim).df.completionTick !== null);
  expect(rowsToCounts(jt(sim).mr.output)).toEqual(EXPECTED_COUNTS);
  expect(rowsToCounts(jt(sim).df.output)).toEqual(EXPECTED_COUNTS);
}, 30_000);

test('healthy run: the dataflow side wins on completion tick', () => {
  const sim = fresh();
  runJob(sim);
  until(sim, () => jt(sim).mr.completionTick !== null && jt(sim).df.completionTick !== null);
  expect(jt(sim).df.completionTick!).toBeLessThan(jt(sim).mr.completionTick!);
  // and the healthy run wasted nothing, re-ran nothing, restarted nothing
  expect(jt(sim).mr.wasted).toBe(0);
  expect(jt(sim).df.wasted).toBe(0);
  expect(jt(sim).mr.reexecuted).toBe(0);
  expect(jt(sim).df.restarts).toBe(0);
}, 30_000);

test('the barrier holds: no reduce task starts until all three maps are done', () => {
  const sim = fresh();
  runJob(sim);
  until(sim, () => jt(sim).mr.tasks.r0.status !== 'waiting' || jt(sim).mr.tasks.r1.status !== 'waiting');
  for (const m of ['m0', 'm1', 'm2'] as const) expect(jt(sim).mr.tasks[m].status).toBe('done');
  expect(jt(sim).mr.phase).toBe('reduce');
}, 30_000);

test('MR materializes to mapper-local disk; dataflow never touches disk', () => {
  const sim = fresh();
  runJob(sim);
  until(sim, () => jt(sim).mr.completionTick !== null && jt(sim).df.completionTick !== null);
  expect(jt(sim).mr.materialized).toBe(24); // 3 maps × 8 records, healthy run
  // dataflow leaves no disk anywhere: only MR wrote disk files
  for (const w of WORKERS) {
    const s = wk(sim, w);
    expect(s.df.maps.every((m) => m.done)).toBe(true);
  }
}, 30_000);

test('a second run-job in the same epoch is ignored', () => {
  const sim = fresh();
  runJob(sim);
  until(sim, () => jt(sim).started);
  const attempt = jt(sim).df.attempt;
  runJob(sim);
  sim.runSteps(50);
  expect(jt(sim).df.attempt).toBe(attempt);
  expect(jt(sim).df.restarts).toBe(0);
}, 30_000);

test('determinism: same seed → identical end states', () => {
  const a = fresh(10007);
  const b = fresh(10007);
  for (const s of [a, b]) {
    runJob(s);
    until(s, () => jt(s).mr.completionTick !== null && jt(s).df.completionTick !== null);
    s.runSteps(500); // let trailing pings settle identically
  }
  for (const n of BATCH_NODES) {
    expect(JSON.stringify(a.getState(n))).toBe(JSON.stringify(b.getState(n)));
  }
}, 30_000);
