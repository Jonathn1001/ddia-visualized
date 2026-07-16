// src/ui/labs/lease/LeaseLab.tsx
import { useEffect, useState } from 'react';
import { Simulation } from '../../../engine';
import { lease, type LeaseState, type LockInspect, type StoreState, type StoreInspect, type WorkerInspect, type WorkerState } from '../../../modules/lease';
import { LEASE_TOPOLOGY, LOCK, STORE, W1, W2 } from '../../../modules/lease-shared';
import { SimDriver } from '../../bridge/SimDriver';
import { useSimStore } from '../../bridge/simStore';
import { ChallengePanel } from '../../kit/ChallengePanel';
import { ChaosToolbar } from '../../kit/ChaosToolbar';
import { ClusterView } from '../../kit/ClusterView';
import { MetricsPanel } from '../../kit/MetricsPanel';
import { TimelineScrubber } from '../../kit/TimelineScrubber';
import { btn } from '../../kit/classes';
import { LeaseFaultBar } from './LeaseFaultBar';
import { LeasePanel } from './LeasePanel';
import { StorePanel } from './StorePanel';

export function LeaseLab() {
  const [epoch, setEpoch] = useState(0);
  const [driver, setDriver] = useState<SimDriver<LeaseState> | null>(null);
  const [fencing, setFencing] = useState(false);
  // Store counters snapshotted at the MOST RECENT pause click (null = no pause
  // this epoch). Challenge wins compare against this base so a stale/reject
  // earned before the pause (e.g. via clock-skew) can't bleed into the
  // pause-choreography challenges.
  const [pauseBase, setPauseBase] = useState<{ stale: number; rejects: number } | null>(null);
  const [skewFlag, setSkewFlag] = useState(false);
  const [staleAtFence, setStaleAtFence] = useState(0);

  useEffect(() => {
    useSimStore.getState().reset();
    const seed = 8000 + epoch;
    const sim = new Simulation<LeaseState>({ module: lease, config: { nodeIds: LEASE_TOPOLOGY }, seed });
    const d = new SimDriver({ sim, seed, publish: (v) => useSimStore.getState().publish(v) });
    while (d.sim.pending > 0) d.stepOnce(); // drain inits so panels render immediately
    setDriver(d);
    setFencing(false);
    setPauseBase(null);
    setSkewFlag(false);
    setStaleAtFence(0);
    return () => d.pause();
  }, [epoch]);

  const view = useSimStore();
  if (!driver) return null;

  const storeState = () => driver.sim.getState(STORE) as StoreState;
  const workerState = (id: string) => driver.sim.getState(id) as WorkerState;

  const inspects = new Map(view.nodes.map((n) => [n.id, n.inspect]));
  const lock = inspects.get(LOCK) as unknown as LockInspect | undefined;
  const store = inspects.get(STORE) as unknown as StoreInspect | undefined;
  const workers = [W1, W2]
    .map((id) => inspects.get(id) as unknown as WorkerInspect | undefined)
    .filter((w): w is WorkerInspect => w !== undefined && w.role === 'worker');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
        <button className={btn} onClick={() => setEpoch((e) => e + 1)}>reset (new seed)</button>
        <button data-action="lab-step" className={btn} onClick={() => driver.stepOnce()}>step</button>
        <span className="text-dim">a lease is a promise about time — and time here lies</span>
      </div>

      <TimelineScrubber
        processed={view.processed}
        pending={view.pending}
        running={view.running}
        onPlayPause={() => (view.running ? driver.pause() : driver.start())}
        onStep={() => driver.stepOnce()}
        onScrub={(i) => driver.scrubTo(i)}
      />

      <div className="flex flex-wrap items-start gap-4">
        <ClusterView nodes={view.nodes} inFlight={view.inFlight} time={view.time} />
        {lock && workers.length === 2 && <LeasePanel lock={lock} workers={workers} time={view.time} />}
        {store && store.role === 'store' && <StorePanel store={store} />}
        <MetricsPanel history={view.metricsHistory} />
      </div>

      <LeaseFaultBar
        fencing={fencing}
        onAcquire={(w) => driver.external(w, { cmd: 'acquire' })}
        onPause={(w, ticks) => {
          driver.external(w, { fault: 'gc-pause', ticks });
          // every pause click re-snapshots the store counters at pause time
          setPauseBase({ stale: storeState().staleAccepts, rejects: storeState().rejects });
        }}
        onSkew={(w, rate) => {
          driver.external(w, { fault: 'clock-skew', rate });
          setSkewFlag(true);
        }}
        onFencing={(on) => {
          driver.external(STORE, { cmd: 'fencing', on });
          setFencing(on);
          if (on) setStaleAtFence(storeState().staleAccepts);
        }}
      />

      <ChaosToolbar
        caps={lease.chaos}
        nodeIds={driver.sim.config.nodeIds}
        deadNodes={view.nodes.filter((n) => n.dead).map((n) => n.id)}
        onAction={(a) => driver.control(a)}
      />

      <ChallengePanel
        title="Challenge: the lease is a lie"
        storageKeyPrefix="ddia:ch08:lease"
        prompt="Fencing off. Acquire with W1, GC-pause it mid-work (⚙) past the TTL, let W2 take over. Predict: what does W1 do when it wakes?"
        runningHint="W1 acquire → click step until ⚙ working shows → ⏸ W1 → W2 acquire → play (or keep stepping). Play mode is too fast to catch the window — the step button is your freeze-frame."
        check={() => {
          if (pauseBase === null) return null; // no auto-win without an actual pause (Ch3 lesson)
          const s = storeState();
          // a stale accept that happened AFTER the most recent pause
          return s.staleAccepts > pauseBase.stale ? { stale: s.staleAccepts } : null;
        }}
        onWin={() => driver.pause()}
        renderWin={(_w, prediction) => (
          <>
            <p>
              W1 woke up and finished the write it had already decided to make — token 1 landed on top of
              W2's token-2 data and the store took it. The lock did everything right; the <em>store</em> had
              no way to know the lease was dead. That is DDIA figure 8-4.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />

      <ChallengePanel
        title="Challenge: fence it"
        storageKeyPrefix="ddia:ch08:fence"
        prompt="Same choreography, fencing ON first. Predict: what happens to W1's wake-up write?"
        runningHint="fencing: on → W1 acquire → step until ⚙ working → ⏸ W1 → W2 acquire → play (or keep stepping)."
        check={() => {
          if (!fencing || pauseBase === null) return null;
          const s = storeState();
          // a rejection that happened AFTER the most recent pause, with no
          // stale accept slipping through since fencing was enabled
          return s.rejects > pauseBase.rejects && s.staleAccepts <= staleAtFence
            ? { rejects: s.rejects }
            : null;
        }}
        onWin={() => driver.pause()}
        renderWin={(_w, prediction) => (
          <>
            <p>
              the write arrived with token 1, the store had already seen token 2 — rejected. One monotonic
              number turned a corruption into a no-op. The token does what the lease could not, because it
              travels <em>with the write</em>.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />

      <ChallengePanel
        title="Challenge: the clock lies too"
        storageKeyPrefix="ddia:ch08:clock"
        prompt="Fencing off, no pause. Slow W1's clock (×0.5), acquire with both. Predict: can the store get corrupted with no GC pause at all?"
        runningHint="🕰 W1 → W1 acquire → W2 acquire → play until the stale row appears."
        check={() => {
          if (pauseBase !== null || !skewFlag) return null; // this one must be pause-free
          const s = storeState();
          const w1 = workerState(W1);
          return s.staleAccepts >= 1 && w1.rate !== 1 ? { stale: s.staleAccepts } : null;
        }}
        onWin={() => driver.pause()}
        renderWin={(_w, prediction) => (
          <>
            <p>
              nobody paused anything — W1's clock just ran slow, so its 60-tick lease "lasted" 120 real
              ticks. Leases are promises about time, and a process can only check them against its own
              clock. Never build mutual exclusion on elapsed time you didn't measure yourself.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />
    </div>
  );
}
