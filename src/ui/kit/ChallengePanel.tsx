import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useSimStore } from '../bridge/simStore';
import { btnPrimary } from './classes';

/**
 * Generic chaos-challenge lifecycle (DESIGN_PLAN §3): predict-before-run,
 * engine-verified win, prediction-vs-reality reveal. Each lab supplies its
 * verifier (`check`) and win renderer; persistence keys derive from
 * `storageKeyPrefix` (`<prefix>:attempt`, `<prefix>:prediction:<n>`).
 */
export function ChallengePanel<R>({
  title,
  storageKeyPrefix,
  prompt,
  runningHint,
  check,
  onWin,
  renderWin,
}: {
  title: string;
  storageKeyPrefix: string;
  prompt: string;
  runningHint: string;
  check: () => R | null;
  onWin?: () => void;
  renderWin: (result: R, prediction: string) => ReactNode;
}) {
  const processed = useSimStore((s) => s.processed);
  const [attempt, setAttempt] = useState<number | null>(null);
  const [prediction, setPrediction] = useState('');
  const [win, setWin] = useState<R | null>(null);

  useEffect(() => {
    if (attempt === null || win) return;
    const result = check();
    if (result) {
      setWin(result);
      onWin?.();
    }
  }, [processed, attempt, win, check, onWin]);

  const start = () => {
    const n = Number(localStorage.getItem(`${storageKeyPrefix}:attempt`) ?? '0') + 1;
    localStorage.setItem(`${storageKeyPrefix}:attempt`, String(n));
    localStorage.setItem(`${storageKeyPrefix}:prediction:${n}`, prediction);
    setAttempt(n);
    setWin(null);
  };

  return (
    <section className="border border-line bg-panel rounded p-3 space-y-2 max-w-xl">
      <h2 className="font-bold text-sm text-fg">{title}</h2>
      {attempt === null && (
        <>
          <textarea
            className="w-full bg-ink border border-line rounded p-2 text-xs font-mono text-fg"
            rows={2}
            placeholder={prompt}
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
          attempt #{attempt} running — {runningHint}
        </p>
      )}
      {attempt !== null && win && (
        <div className="text-xs font-mono space-y-1 text-fg">
          <p className="text-set font-bold">✓ challenge complete — verified by the engine</p>
          {renderWin(
            win,
            localStorage.getItem(`${storageKeyPrefix}:prediction:${attempt}`) || '(skipped)',
          )}
          <button className="underline text-fg" onClick={() => setAttempt(null)}>
            try again
          </button>
        </div>
      )}
    </section>
  );
}
