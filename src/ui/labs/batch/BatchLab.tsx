// src/ui/labs/batch/BatchLab.tsx
import { useEffect, useState } from 'react';
import { Simulation, type ControlAction } from '../../../engine';
import { batch, type BatchSchedInspect, type BatchState, type BatchWorkerInspect, type SchedState } from '../../../modules/batch';
import { BATCH_NODES, JT, WORKERS, type BatchPayload, type Side } from '../../../modules/batch-shared';
import { SimDriver } from '../../bridge/SimDriver';
import { useSimStore } from '../../bridge/simStore';
import { ChallengePanel } from '../../kit/ChallengePanel';
import { ChaosToolbar } from '../../kit/ChaosToolbar';
import { MetricsPanel } from '../../kit/MetricsPanel';
import { TimelineScrubber } from '../../kit/TimelineScrubber';
import { btn, btnPrimary } from '../../kit/classes';
import { StagePanel, type ShuffleDot } from './StagePanel';

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function BatchLab() {
  const [epoch, setEpoch] = useState(0);
  const [driver, setDriver] = useState<SimDriver<BatchState, BatchPayload> | null>(null);
  const [jobFired, setJobFired] = useState(false);
  // Challenge gates — engine-verified wins still require the UI flag to have
  // fired first this epoch (Ch3/Ch8/Ch9 lesson: no auto-win off a stale state).
  const [killedRunningMr, setKilledRunningMr] = useState(false);
  const [userKilled, setUserKilled] = useState(false);
  const [killedWhileBoth, setKilledWhileBoth] = useState(false);

  useEffect(() => {
    useSimStore.getState().reset();
    const seed = 10000 + epoch;
    const sim = new Simulation<BatchState, BatchPayload>({ module: batch, config: { nodeIds: BATCH_NODES }, seed });
    const d = new SimDriver({ sim, seed, publish: (v) => useSimStore.getState().publish(v) });
    // Drain exactly BATCH_NODES.length init events so every node's ping loop is
    // armed (src/modules/batch.test.ts `fresh()` precedent). JT's ping loop
    // never settles — heartbeats re-arm forever — so an unbounded drain here
    // would hang the mount effect, unlike LeaseLab's `while (pending > 0)`.
    for (let i = 0; i < BATCH_NODES.length; i++) d.stepOnce();
    setDriver(d);
    setJobFired(false);
    setKilledRunningMr(false);
    setUserKilled(false);
    setKilledWhileBoth(false);
    return () => d.pause();
  }, [epoch]);

  const view = useSimStore();
  if (!driver) return null;

  const sched = view.nodes.find((n) => n.id === JT)?.inspect as unknown as BatchSchedInspect | undefined;
  const workers = WORKERS.map((id) => view.nodes.find((n) => n.id === id)?.inspect as unknown as BatchWorkerInspect)
    .filter((w): w is BatchWorkerInspect => w !== undefined);
  const deadNodes = view.nodes.filter((n) => n.dead).map((n) => n.id);

  const dots = (side: Side): ShuffleDot[] =>
    view.inFlight
      .filter((m) => {
        const p = m.payload as { side?: string; kind?: string };
        return p.side === side && (p.kind === 'fetch-resp' || p.kind === 'df-record');
      })
      .map((m, i) => ({
        // sentAt + index keep the key unique: two records can share
        // from/target/deliverAt when the network assigns the same latency.
        id: `${m.from}-${m.target}-${m.sentAt}-${m.deliverAt}-${i}`,
        from: m.from,
        to: m.target,
        frac: clamp01((view.time - m.sentAt) / Math.max(1, m.deliverAt - m.sentAt)),
      }));

  if (!sched) return null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
        <button className={btn} onClick={() => setEpoch((e) => e + 1)}>reset (new seed)</button>
        <button data-action="lab-step" className={btn} onClick={() => driver.stepOnce()}>step</button>
        <button
          data-action="run-job"
          className={btnPrimary}
          disabled={jobFired}
          onClick={() => {
            driver.external(JT, { cmd: 'run-job' });
            setJobFired(true);
          }}
        >
          run job
        </button>
        <span className="text-dim">same URL-count job, two engines — materialize-and-barrier vs pipeline-and-stream</span>
      </div>

      <TimelineScrubber
        processed={view.processed}
        pending={view.pending}
        running={view.running}
        onPlayPause={() => (view.running ? driver.pause() : driver.start())}
        onStep={() => driver.stepOnce()}
        onScrub={(i) => {
          // forward only: a backward scrub can't be replayed against the
          // React-side challenge flags (killedRunningMr/userKilled/killedWhileBoth),
          // which survive the scrub and would desync from the replayed sim
          if (i >= view.processed) driver.scrubTo(i);
        }}
      />

      <StagePanel side="mr" title="MapReduce" sched={sched} workers={workers} deadNodes={deadNodes} dots={dots('mr')} />
      <StagePanel side="df" title="Dataflow" sched={sched} workers={workers} deadNodes={deadNodes} dots={dots('df')} />

      <MetricsPanel history={view.metricsHistory} />

      <ChaosToolbar
        caps={batch.chaos}
        nodeIds={WORKERS}
        deadNodes={deadNodes}
        onAction={(a: ControlAction) => {
          if (a.type === 'kill') {
            const jt = driver.sim.getState(JT) as SchedState;
            setUserKilled(true);
            const runningHere = Object.values(jt.mr.tasks).some(
              (row) => row.status === 'running' && row.worker === a.node,
            );
            if (runningHere) setKilledRunningMr(true);
            if (
              (jt.mr.phase === 'map' || jt.mr.phase === 'reduce') &&
              jt.mr.completionTick === null &&
              jt.df.started &&
              jt.df.completionTick === null
            ) {
              setKilledWhileBoth(true);
            }
          }
          driver.control(a);
        }}
      />

      <ChallengePanel
        title="Challenge: kill a mapper mid-task"
        storageKeyPrefix="ddia:ch10:rerun"
        prompt="Run the job, then kill a worker while it is actively running a map task — its chip shows 'running', not 'done'. Predict: what happens to that mapper's partial work, and does the final output still come out exact?"
        runningHint="run job → step into the map phase → kill a worker whose chip shows a running task → play out."
        check={() => {
          if (!killedRunningMr) return null;
          const jt = driver.sim.getState(JT) as SchedState;
          if (jt.mr.completionTick !== null && jt.mr.reexecuted >= 1) {
            return { reexecuted: jt.mr.reexecuted, completionTick: jt.mr.completionTick };
          }
          return null;
        }}
        onWin={() => driver.pause()}
        renderWin={(w, prediction) => (
          <>
            <p>
              The killed worker's partial map execution counted for nothing — JT re-assigned that exact task
              (attempt #{w.reexecuted}) to another live worker, which ran it from scratch. The barrier waited;
              the output finished at tick {w.completionTick} with the same exact URL counts as a healthy run.
              Task-granular re-execution is the payoff of materializing every stage to disk: a single lost task
              costs one re-run, never the whole job.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />

      <ChallengePanel
        title="Challenge: done isn't safe until fetched"
        storageKeyPrefix="ddia:ch10:lostdisk"
        prompt="Watch a map task's chip turn 'done' — its output now lives only on that worker's local disk. Kill that worker right after, before any reducer's shuffle dot has left it. Predict: is that map output really finished, or does it die with the disk?"
        runningHint="watch the disk row — kill a worker right AFTER its map chip turns done but BEFORE the shuffle dots leave it."
        check={() => {
          if (!userKilled) return null;
          const jt = driver.sim.getState(JT) as SchedState;
          if (jt.mr.completionTick !== null && jt.mr.lostAfterDone >= 1) {
            return { lostAfterDone: jt.mr.lostAfterDone, completionTick: jt.mr.completionTick };
          }
          return null;
        }}
        onWin={() => driver.pause()}
        renderWin={(w, prediction) => (
          <>
            <p>
              'Done' only means the map finished executing and wrote its partitions to the mapper's local disk —
              it does not mean the data is safe. That worker's disk died with it, and {w.lostAfterDone} map
              output(s) still needed by a reducer had to be re-executed from scratch, even though they had
              already completed once. Local disk is not replicated: a done-but-unfetched map is one kill away
              from being un-done.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />

      <ChallengePanel
        title="Challenge: same kill, unequal damage"
        storageKeyPrefix="ddia:ch10:damage"
        prompt="Kill one worker while BOTH engines are mid-job — neither has finished yet. Let both recover and finish. Predict: which engine wastes more work, the one with a local disk or the one without?"
        runningHint="one kill while both panels are busy, then let both finish and compare the wasted counters."
        check={() => {
          if (!killedWhileBoth) return null;
          const jt = driver.sim.getState(JT) as SchedState;
          if (jt.mr.completionTick !== null && jt.df.completionTick !== null && jt.df.wasted > jt.mr.wasted) {
            return { mrWasted: jt.mr.wasted, dfWasted: jt.df.wasted };
          }
          return null;
        }}
        onWin={() => driver.pause()}
        renderWin={(w, prediction) => (
          <>
            <p>
              Same kill, same tick — unequal damage. MapReduce wasted only {w.mrWasted} ticks: the materialized
              stages before the kill survived on disk, so recovery re-ran just the lost task. Dataflow has no
              checkpoint to fall back to, so a lost worker poisons the whole in-flight attempt — it wasted{' '}
              {w.dfWasted} ticks restarting the streaming pipeline from the input. Pipelining buys speed on the
              happy path; materialization buys cheap recovery when something dies.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />
    </div>
  );
}
