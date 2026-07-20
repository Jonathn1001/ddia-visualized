import { useEffect, useState } from 'react';
import { Simulation } from '../../../engine';
import { load, type LoadPayload } from '../../../modules/load';
import { LOAD_MAX, LOAD_NODES, SLA, SVC, type LoadInspect, type LoadState } from '../../../modules/load-shared';
import { SimDriver } from '../../bridge/SimDriver';
import { useSimStore } from '../../bridge/simStore';
import { ChallengePanel } from '../../kit/ChallengePanel';
import { MetricsPanel } from '../../kit/MetricsPanel';
import { TimelineScrubber } from '../../kit/TimelineScrubber';
import { btn } from '../../kit/classes';
import { PercentilePanel } from './PercentilePanel';

const MAX_DOTS = 30; // queue dots drawn before collapsing to "+N"

export function LoadLab() {
  const [epoch, setEpoch] = useState(0);
  const [driver, setDriver] = useState<SimDriver<LoadState, LoadPayload> | null>(null);

  // knob UI state — immediate feedback; the command is also sent to the sim
  // (external() only enqueues, so the module applies it on the next step/play).
  const [loadLevel, setLoadLevel] = useState(8);
  const [servers, setServers] = useState(1);
  const [cachePct, setCachePct] = useState(0);
  const [varianceOn, setVarianceOn] = useState(true);
  const [fanout, setFanout] = useState(1);

  useEffect(() => {
    useSimStore.getState().reset();
    const seed = 1000 + epoch;
    const sim = new Simulation<LoadState, LoadPayload>({ module: load, config: { nodeIds: LOAD_NODES }, seed });
    const d = new SimDriver({ sim, seed, publish: (v) => useSimStore.getState().publish(v) });
    // Drain the single init event to arm the arrival loop. The arrival timer
    // keeps the queue non-empty forever, so do NOT loop-drain to empty.
    for (let i = 0; i < LOAD_NODES.length; i++) d.stepOnce();
    setDriver(d);
    setLoadLevel(8);
    setServers(1);
    setCachePct(0);
    setVarianceOn(true);
    setFanout(1);
    return () => d.pause();
  }, [epoch]);

  const view = useSimStore();
  const svc = driver
    ? (view.nodes.find((n) => n.id === SVC)?.inspect as unknown as LoadInspect | undefined)
    : undefined;

  if (!driver || !svc) return null;

  const setLoad = (level: number) => {
    setLoadLevel(level);
    driver.external(SVC, { cmd: 'set-load', level });
  };
  const setServersTo = (c: number) => {
    const next = Math.max(1, c);
    setServers(next);
    driver.external(SVC, { cmd: 'set-servers', c: next });
  };
  const setCache = (pct: number) => {
    setCachePct(pct);
    driver.external(SVC, { cmd: 'set-cache', h: pct / 100 });
  };
  const toggleVariance = () => {
    const on = !varianceOn;
    setVarianceOn(on);
    driver.external(SVC, { cmd: 'set-variance', on });
  };
  const setFanoutTo = (n: number) => {
    const next = Math.max(1, n);
    setFanout(next);
    driver.external(SVC, { cmd: 'set-fanout', n: next });
  };

  const slots = Array.from({ length: servers }, (_, i) => i < svc.inService);
  const dots = Math.min(svc.queueLen, MAX_DOTS);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
        <button className={btn} onClick={() => setEpoch((e) => e + 1)}>
          reset (new seed)
        </button>
        <button data-action="lab-step" className={btn} onClick={() => driver.stepOnce()} disabled={view.running}>
          step
        </button>
        <span className="text-dim">
          drag the load up and watch p99 detonate near capacity — then add a replica or a cache to rescue the tail
        </span>
      </div>

      {/* control strip */}
      <div className="flex flex-wrap items-center gap-4 font-mono text-xs border border-line bg-panel rounded p-3">
        <label className="flex items-center gap-2">
          <span className="text-dim">load</span>
          <input
            aria-label="load"
            type="range"
            min={1}
            max={LOAD_MAX}
            value={loadLevel}
            onChange={(e) => setLoad(Number(e.target.value))}
          />
          <span className="text-fg tabular-nums w-6">{loadLevel}</span>
        </label>

        <span className="flex items-center gap-1">
          <span className="text-dim">servers</span>
          <button className={btn} onClick={() => setServersTo(servers - 1)}>−</button>
          <span className="text-fg tabular-nums w-4 text-center">{servers}</span>
          <button data-action="add-replica" className={btn} onClick={() => setServersTo(servers + 1)}>+</button>
        </span>

        <label className="flex items-center gap-2">
          <span className="text-dim">cache</span>
          <input
            aria-label="cache"
            type="range"
            min={0}
            max={100}
            step={5}
            value={cachePct}
            onChange={(e) => setCache(Number(e.target.value))}
          />
          <span className="text-fg tabular-nums w-8">{cachePct}%</span>
        </label>

        <button className={btn} onClick={toggleVariance}>
          variance: {varianceOn ? 'on' : 'off'}
        </button>

        <span className="flex items-center gap-1">
          <span className="text-dim">fan-out</span>
          <button className={btn} onClick={() => setFanoutTo(fanout - 1)}>−</button>
          <span className="text-fg tabular-nums w-6 text-center">{fanout}</span>
          <button className={btn} onClick={() => setFanoutTo(fanout + 1)}>+</button>
        </span>
      </div>

      {/* queue visual */}
      <div className="flex flex-wrap items-center gap-2 font-mono text-xs border border-line bg-panel rounded p-3">
        <span className="text-dim mr-1">servers</span>
        {slots.map((busy, i) => (
          <span
            key={i}
            className={`h-4 w-4 rounded ${busy ? 'bg-set' : 'bg-ink border border-line'}`}
            title={busy ? 'busy' : 'idle'}
          />
        ))}
        <span className="text-dim mx-2">queue</span>
        {Array.from({ length: dots }, (_, i) => (
          <span key={i} className="h-2 w-2 rounded-full bg-warn" />
        ))}
        {svc.queueLen > MAX_DOTS && <span className="text-warn">+{svc.queueLen - MAX_DOTS}</span>}
        {svc.queueLen === 0 && <span className="text-dim">(empty)</span>}
      </div>

      <TimelineScrubber
        processed={view.processed}
        pending={view.pending}
        running={view.running}
        onPlayPause={() => (view.running ? driver.pause() : driver.start())}
        onStep={() => driver.stepOnce()}
        onScrub={(i) => {
          // forward only (Ch8 lesson): a backward scrub can't be replayed against
          // the module-latched challenge flags without desyncing.
          if (i >= view.processed) driver.scrubTo(i);
        }}
      />

      <PercentilePanel view={svc} />

      <MetricsPanel history={view.metricsHistory} />

      <ChallengePanel
        title="Challenge: the knee — tail latency explodes near capacity"
        storageKeyPrefix="ddia:ch01:knee"
        prompt={`Drag the load slider up toward capacity (one server). Predict: which breaks first — the median (p50) or the tail (p99) — and once p99 blows past the SLA of ${SLA}, will adding a single replica pull it back under?`}
        runningHint="raise the load until p99 crosses the SLA line (breach), then click servers + to add a replica and play until p99 drops back under the line."
        check={() => (svc.ch.c1.breached && svc.ch.c1.rescued ? { p99: svc.p99 } : null)}
        onWin={() => driver.pause()}
        renderWin={(_w, prediction) => (
          <>
            <p>
              Near capacity the queue stops draining as fast as it fills, and waiting time — not service time
              — comes to dominate. The median barely moved while p99 exploded past the SLA: the average hid a
              tail that every unlucky request felt. Adding one replica roughly halved the utilisation, the
              queue drained, and the same load now clears well under the SLA. Tail latency is a capacity
              cliff, not a smooth slope — and the fix is capacity, not optimisation.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />

      <ChallengePanel
        title="Challenge: variance drives the tail"
        storageKeyPrefix="ddia:ch01:variance"
        prompt="Give the service tier plenty of servers so nothing queues, and turn service-time variance ON. Predict: with almost no queueing, why is p99 still many times p50 — and what happens to that gap the instant you switch variance OFF?"
        runningHint="add servers until utilisation is low, variance ON → play (p99 ≫ p50), then variance OFF → play (p99 collapses toward p50)."
        check={() => (svc.ch.c2.hiTail && svc.ch.c2.loTail ? { ok: true } : null)}
        onWin={() => driver.pause()}
        renderWin={(_w, prediction) => (
          <>
            <p>
              With capacity to spare there was almost no queue, yet the tail stayed fat — because the tail is
              made of variance. A handful of long service times land in p99 no matter how idle the servers
              are, and one slow request blocks the ones behind it (head-of-line blocking). Switching to
              constant service time collapsed the tail onto the mean: p99 ≈ p50. Averages lie precisely
              because they smooth over the variance that percentiles expose.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />

      <ChallengePanel
        title="Challenge: tail-latency amplification"
        storageKeyPrefix="ddia:ch01:amplification"
        prompt="Keep load low and servers high so the backend is healthy, then fan every user request out to 20+ backend calls (it waits for the slowest). Predict: if only 1-in-20 backend calls is slow, roughly what fraction of USER requests end up slow?"
        runningHint="low load, many servers, fan-out ≥ 20 → play. Watch the user p50 climb up to the backend p95: the median user now feels the backend's tail."
        check={() => (svc.ch.c3.amplified ? { p50: svc.p50, bp95: svc.bp95 } : null)}
        onWin={() => driver.pause()}
        renderWin={(w, prediction) => (
          <>
            <p>
              A user request that fans out to N backend calls is only as fast as its slowest call, so its
              latency is the max of N samples. With N=20, a request almost always includes at least one call
              from the backend's slow tail — so the median user request (p50 ≈ {w.p50}) now feels what was the
              backend's 95th percentile (p95 ≈ {w.bp95}). This is tail-latency amplification: the more you fan
              out, the more the rare backend slow-case becomes the common user experience. The real fix is
              fewer backend calls, or hedged requests.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />
    </div>
  );
}
