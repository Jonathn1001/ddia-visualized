import { useEffect, useState } from 'react';
import { detectStaleRead, type RepPayload, type RepState, type StaleReadResult } from '../../../modules/replication';
import type { SimDriver } from '../../bridge/SimDriver';
import { useSimStore } from '../../bridge/simStore';
import { btnPrimary } from '../../kit/classes';

const ATTEMPT_KEY = 'ddia:ch05:stale-read:attempt';
const predictionKey = (n: number) => `ddia:ch05:stale-read:prediction:${n}`;

/**
 * Chaos Challenge #1 (DESIGN_PLAN §3): "Produce a stale read."
 * Predict-before-run: the prediction is captured before the attempt and
 * shown beside the engine-verified outcome — prediction vs reality.
 */
export function ChallengePanel({ driver }: { driver: SimDriver<RepState, RepPayload> }) {
  const processed = useSimStore((s) => s.processed);
  const [attempt, setAttempt] = useState<number | null>(null);
  const [prediction, setPrediction] = useState('');
  const [win, setWin] = useState<StaleReadResult | null>(null);

  useEffect(() => {
    if (attempt === null || win) return;
    const states = new Map(driver.sim.config.nodeIds.map((id) => [id, driver.sim.getState(id)] as const));
    const result = detectStaleRead(states);
    if (result) {
      setWin(result);
      driver.pause();
    }
  }, [processed, attempt, win, driver]);

  const start = () => {
    const n = Number(localStorage.getItem(ATTEMPT_KEY) ?? '0') + 1;
    localStorage.setItem(ATTEMPT_KEY, String(n));
    localStorage.setItem(predictionKey(n), prediction);
    setAttempt(n);
    setWin(null);
  };

  return (
    <section className="border border-line bg-panel rounded p-3 space-y-2 max-w-xl">
      <h2 className="font-bold text-sm text-fg">Chaos Challenge: produce a stale read</h2>
      {attempt === null && (
        <>
          <textarea
            className="w-full bg-ink border border-line rounded p-2 text-xs font-mono text-fg"
            rows={2}
            placeholder="Predict first: how will you cause a stale read? (skippable)"
            value={prediction}
            onChange={(e) => setPrediction(e.target.value)}
          />
          <button className={btnPrimary} onClick={start}>
            start attempt
          </button>
        </>
      )}
      {attempt !== null && !win && (
        <p className="text-xs text-dim font-mono">
          attempt #{attempt} running — make a read return older data than an acknowledged write.
        </p>
      )}
      {attempt !== null && win && (
        <div className="text-xs font-mono space-y-1">
          <p className="text-set font-bold">✓ challenge complete — stale read verified by the engine</p>
          <p className="text-fg">
            read <code className="text-warn">{win.read.key}</code> @ {win.read.node} returned seq{' '}
            {win.read.returnedSeq} at t={win.read.time}, after write seq {win.ack.seq} was acked at t=
            {win.ack.time}.
          </p>
          <p className="text-dim">
            your prediction: “{localStorage.getItem(predictionKey(attempt)) || '(skipped)'}”
          </p>
          <button className="underline text-fg" onClick={() => setAttempt(null)}>
            try again
          </button>
        </div>
      )}
    </section>
  );
}
