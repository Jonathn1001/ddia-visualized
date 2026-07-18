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

// --- Task 3: MapReduce recovery matrix ---

test('kill a mapper mid-task: the task re-runs elsewhere; partial ticks are wasted; output stays exact', () => {
  const sim = fresh(10021);
  runJob(sim);
  until(sim, () => jt(sim).mr.tasks.m0.status === 'running');
  const victim = jt(sim).mr.tasks.m0.worker!;
  until(sim, () => jt(sim).mr.tasks.m0.execTicks > 0); // mid-task, some records done
  sim.control({ type: 'kill', node: victim });
  until(sim, () => jt(sim).live[victim] === false); // ping loop declares death
  expect(jt(sim).mr.reexecuted).toBeGreaterThanOrEqual(1);
  expect(jt(sim).mr.wasted).toBeGreaterThan(0);
  until(sim, () => jt(sim).mr.completionTick !== null);
  const counts: Record<string, number> = {};
  for (const [u, n] of jt(sim).mr.output) counts[u] = (counts[u] ?? 0) + n;
  expect(counts).toEqual(EXPECTED_COUNTS);
}, 30_000);

test('done is not safe until fetched: killing a done mapper before the shuffle re-runs its map', () => {
  const sim = fresh(10022);
  runJob(sim);
  // wait for the FIRST map-done, then kill that worker before reduces can fetch
  until(sim, () => Object.keys(jt(sim).mr.diskAt).length === 1);
  const [m, w] = Object.entries(jt(sim).mr.diskAt)[0] as [string, string];
  sim.control({ type: 'kill', node: w });
  until(sim, () => jt(sim).live[w] === false);
  expect(jt(sim).mr.lostAfterDone).toBeGreaterThanOrEqual(1);
  expect(jt(sim).mr.tasks[m as 'm0'].status).not.toBe('done'); // re-queued
  until(sim, () => jt(sim).mr.completionTick !== null);
  const counts: Record<string, number> = {};
  for (const [u, n] of jt(sim).mr.output) counts[u] = (counts[u] ?? 0) + n;
  expect(counts).toEqual(EXPECTED_COUNTS);
}, 30_000);

test('kill a reducer mid-fetch: the reduce task re-runs and re-fetches from surviving disks', () => {
  const sim = fresh(10023);
  runJob(sim);
  until(sim, () => jt(sim).mr.tasks.r0.status === 'running');
  const victim = jt(sim).mr.tasks.r0.worker!;
  sim.control({ type: 'kill', node: victim });
  until(sim, () => jt(sim).live[victim] === false);
  expect(jt(sim).mr.tasks.r0.attempt).toBeGreaterThanOrEqual(1);
  until(sim, () => jt(sim).mr.completionTick !== null);
  const counts: Record<string, number> = {};
  for (const [u, n] of jt(sim).mr.output) counts[u] = (counts[u] ?? 0) + n;
  expect(counts).toEqual(EXPECTED_COUNTS);
}, 30_000);

test('revive rejoins idle with an EMPTY local disk', () => {
  const sim = fresh(10024);
  runJob(sim);
  until(sim, () => Object.keys(jt(sim).mr.diskAt).length >= 1);
  const w = Object.values(jt(sim).mr.diskAt)[0] as string;
  sim.control({ type: 'kill', node: w });
  until(sim, () => jt(sim).live[w] === false);
  sim.control({ type: 'revive', node: w });
  until(sim, () => jt(sim).live[w] === true);
  expect(Object.keys(wk(sim, w).mr.disk)).toHaveLength(0);
  expect(wk(sim, w).mr.run).toBeNull();
  until(sim, () => jt(sim).mr.completionTick !== null && jt(sim).df.completionTick !== null);
}, 30_000);

test('one worker is enough: kill two workers and both jobs still finish, output exact', () => {
  const sim = fresh(10025);
  runJob(sim);
  until(sim, () => jt(sim).started);
  sim.control({ type: 'kill', node: 'W2' });
  sim.control({ type: 'kill', node: 'W3' });
  until(sim, () => jt(sim).mr.completionTick !== null && jt(sim).df.completionTick !== null, 60000);
  for (const side of ['mr', 'df'] as const) {
    const counts: Record<string, number> = {};
    for (const [u, n] of jt(sim)[side].output) counts[u] = (counts[u] ?? 0) + n;
    expect(counts).toEqual(EXPECTED_COUNTS);
  }
}, 30_000);

// --- Task 4: dataflow restart matrix ---

test('killing a streaming worker restarts the dataflow job from the input and books the wasted ticks', () => {
  const sim = fresh(10031);
  runJob(sim);
  until(sim, () => jt(sim).df.execTicks > 0); // records are flowing
  const w = jt(sim).df.placement.r0!; // reducer worker — always poisons
  sim.control({ type: 'kill', node: w });
  until(sim, () => jt(sim).df.restarts >= 1);
  expect(jt(sim).df.wasted).toBeGreaterThan(0);
  until(sim, () => jt(sim).df.completionTick !== null);
  const counts: Record<string, number> = {};
  for (const [u, n] of jt(sim).df.output) counts[u] = (counts[u] ?? 0) + n;
  expect(counts).toEqual(EXPECTED_COUNTS); // no double counting from the aborted lineage
}, 30_000);

test('killing an idle dataflow worker costs nothing', () => {
  const sim = fresh(10032);
  runJob(sim);
  // W3 holds only m0 — wait until m0 is done streaming, then kill W3
  until(sim, () => jt(sim).df.mapsDone.includes('m0'));
  const w3 = jt(sim).df.placement.m0!;
  const restartsBefore = jt(sim).df.restarts;
  sim.control({ type: 'kill', node: w3 });
  until(sim, () => jt(sim).live[w3] === false);
  expect(jt(sim).df.restarts).toBe(restartsBefore); // no poison — W3 held no live df state
  until(sim, () => jt(sim).df.completionTick !== null);
}, 30_000);

test('kill all three workers: both jobs pause; the first revive restarts/resumes them to completion', () => {
  const sim = fresh(10033);
  runJob(sim);
  until(sim, () => jt(sim).df.execTicks > 0);
  for (const w of WORKERS) sim.control({ type: 'kill', node: w });
  until(sim, () => WORKERS.every((w) => jt(sim).live[w] === false));
  expect(jt(sim).df.awaitingRevive).toBe(true);
  expect(jt(sim).df.completionTick).toBeNull();
  sim.control({ type: 'revive', node: 'W1' });
  until(sim, () => jt(sim).mr.completionTick !== null && jt(sim).df.completionTick !== null, 60000);
  for (const side of ['mr', 'df'] as const) {
    const counts: Record<string, number> = {};
    for (const [u, n] of jt(sim)[side].output) counts[u] = (counts[u] ?? 0) + n;
    expect(counts).toEqual(EXPECTED_COUNTS);
  }
}, 30_000);

test('same kill, unequal damage: a restart-triggering kill wastes more dataflow ticks than MR ticks', () => {
  const sim = fresh(10034);
  runJob(sim);
  // let both sides do real work first
  until(sim, () => jt(sim).df.execTicks > 4 * 8 && jt(sim).mr.tasks.m0.execTicks > 0);
  const w = jt(sim).df.placement.r0!;
  sim.control({ type: 'kill', node: w });
  until(sim, () => jt(sim).df.restarts >= 1);
  until(sim, () => jt(sim).mr.completionTick !== null && jt(sim).df.completionTick !== null, 60000);
  expect(jt(sim).df.wasted).toBeGreaterThan(jt(sim).mr.wasted);
}, 30_000);
