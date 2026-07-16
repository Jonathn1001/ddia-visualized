// src/ui/labs/txn/TxnLab.tsx
import { useEffect, useState } from 'react';
import { Simulation } from '../../../engine';
import { committedValue, txn, type TxnInspect, type TxnState } from '../../../modules/txn';
import {
  PRESETS,
  presetById,
  TXN_TOPOLOGY,
  type Level,
  type PresetId,
} from '../../../modules/txn-shared';
import { SimDriver } from '../../bridge/SimDriver';
import { useSimStore } from '../../bridge/simStore';
import { ChallengePanel } from '../../kit/ChallengePanel';
import { IsolationPanel } from './IsolationPanel';
import { SchedulePanel } from './SchedulePanel';
import { TxnScoreboard } from './TxnScoreboard';

export function TxnLab() {
  const [presetId, setPresetId] = useState<PresetId>('dirty-read');
  const [epoch, setEpoch] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [driver, setDriver] = useState<SimDriver<TxnState> | null>(null);

  const preset = presetById(presetId);

  // Driver-in-effect pattern: build the sim in the commit phase, never during render.
  useEffect(() => {
    useSimStore.getState().reset();
    const seed = 7000 + epoch;
    const sim = new Simulation<TxnState>({
      module: txn,
      config: { nodeIds: TXN_TOPOLOGY, params: { initial: presetById(presetId).initial } },
      seed,
    });
    const d = new SimDriver({ sim, seed, publish: (v) => useSimStore.getState().publish(v) });
    while (d.sim.pending > 0) d.stepOnce(); // drain the four inits so panels render immediately
    setDriver(d);
    setCursor(0);
    return () => d.pause();
  }, [presetId, epoch]);

  const view = useSimStore();
  if (!driver) return null;

  const drain = () => {
    while (driver.sim.pending > 0) driver.stepOnce();
  };
  const inject = (i: number) => {
    for (const id of TXN_TOPOLOGY) driver.external(id, { schedule: preset.steps[i] });
    drain();
  };
  const step = () => {
    if (cursor >= preset.steps.length) return;
    inject(cursor);
    setCursor((c) => c + 1);
  };
  const runAll = () => {
    for (let i = cursor; i < preset.steps.length; i++) inject(i);
    setCursor(preset.steps.length);
  };
  const reset = () => setEpoch((e) => e + 1); // rebuilds the sim, cursor back to 0

  const done = cursor >= preset.steps.length;
  const stateOf = (id: Level) => driver.sim.getState(id);
  const panels = TXN_TOPOLOGY.map(
    (id) => view.nodes.find((n) => n.id === id)?.inspect as unknown as TxnInspect | undefined,
  ).filter((p): p is TxnInspect => p !== undefined && p.txns !== undefined);

  const anomaliesOf = (id: Level) => stateOf(id).anomalies.map((a) => a.type);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <SchedulePanel
          presets={PRESETS}
          activeId={presetId}
          cursor={cursor}
          onPick={(id) => {
            setPresetId(id);
            setEpoch((e) => e + 1);
          }}
          onStep={step}
          onRunAll={runAll}
          onReset={reset}
        />
        {panels.length === 4 && <TxnScoreboard panels={panels} />}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 items-start">
        {panels.map((p) => (
          <IsolationPanel key={p.level} inspect={p} />
        ))}
      </div>

      {/* No TimelineScrubber here: this lab drains every step synchronously, so there is
          never pending work to play — and a backward scrub would rewind the panels while
          the SchedulePanel cursor stays put. The schedule IS the timeline; reset rewinds. */}
      <ChallengePanel
        title="Challenge: read a lie"
        storageKeyPrefix="ddia:ch07:dirty"
        prompt="Run the dirty-read schedule. Predict: which levels let T2 read a value that never existed?"
        runningHint="pick the 'Dirty read' preset and run it to the end."
        check={() => {
          if (presetId !== 'dirty-read' || !done) return null;
          const dirtyAtRuOnly =
            anomaliesOf('RU').includes('dirty-read') &&
            (['RC', 'SI', 'SER'] as const).every((id) => anomaliesOf(id).length === 0);
          return dirtyAtRuOnly ? { ok: true } : null;
        }}
        onWin={() => driver.pause()}
        renderWin={(_w, prediction) => (
          <>
            <p>
              only <code className="text-sign">RU</code> read T1's uncommitted 99 — a value that, after the
              abort, never existed. One rung up, Read Committed already refuses to serve unfinished writes.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />

      <ChallengePanel
        title="Challenge: the vanishing increment"
        storageKeyPrefix="ddia:ch07:lost"
        prompt="Run the lost-update schedule. Predict the final counter at each level (it started at 10)."
        runningHint="pick the 'Lost update' preset and run it to the end."
        check={() => {
          if (presetId !== 'lost-update' || !done) return null;
          const rcLost =
            anomaliesOf('RC').includes('lost-update') && committedValue(stateOf('RC'), 'counter') === 11;
          const siAborted = stateOf('SI').txns.T2.abortReason?.includes('first committer wins') ?? false;
          const serRight =
            committedValue(stateOf('SER'), 'counter') === 12 && anomaliesOf('SER').length === 0;
          return rcLost && siAborted && serRight ? { ok: true } : null;
        }}
        onWin={() => driver.pause()}
        renderWin={(_w, prediction) => (
          <>
            <p>
              RC quietly ate an increment (11). SI refused to be lied to — it aborted T2 instead
              (first committer wins). Only serial execution got <code className="text-set">12</code> with
              no casualties.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />

      <ChallengePanel
        title="Challenge: nobody's on call"
        storageKeyPrefix="ddia:ch07:skew"
        prompt="Run the write-skew schedule. Predict: which levels end with zero doctors on call?"
        runningHint="pick the 'Write skew' preset and run it to the end."
        check={() => {
          if (presetId !== 'write-skew' || !done) return null;
          const onCall = (id: Level) =>
            (committedValue(stateOf(id), 'alice') ?? 0) + (committedValue(stateOf(id), 'bob') ?? 0);
          const weakBroke = (['RU', 'RC', 'SI'] as const).every(
            (id) => anomaliesOf(id).includes('write-skew') && onCall(id) === 0,
          );
          const serHeld =
            onCall('SER') >= 1 && (stateOf('SER').txns.T2.abortReason?.includes('ensure failed') ?? false);
          return weakBroke && serHeld ? { ok: true } : null;
        }}
        onWin={() => driver.pause()}
        renderWin={(_w, prediction) => (
          <>
            <p>
              even <code className="text-sign">SI</code> let both doctors leave — each snapshot showed two on
              call, the writes touched different keys, no conflict was detected. Kleppmann's point exactly:
              write skew is the anomaly snapshot isolation cannot see. Serial execution made T2 re-check —
              and its <code>ensure</code> said no.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />
    </div>
  );
}
