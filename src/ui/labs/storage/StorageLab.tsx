// src/ui/labs/storage/StorageLab.tsx
import { useEffect, useState } from 'react';
import { Simulation, type NodeId } from '../../../engine';
import { storage, readValue, type StorageState } from '../../../modules/storage';
import { LSM, BTREE, STORAGE_TOPOLOGY, L0_TRIGGER, type StorageFault } from '../../../modules/storage-shared';
import type { LsmInspect } from '../../../modules/lsm';
import type { BtreeInspect } from '../../../modules/btree';
import { SimDriver } from '../../bridge/SimDriver';
import { useSimStore } from '../../bridge/simStore';
import { ChallengePanel } from '../../kit/ChallengePanel';
import { MetricsPanel } from '../../kit/MetricsPanel';
import { TimelineScrubber } from '../../kit/TimelineScrubber';
import { btn, inputBox } from '../../kit/classes';
import { LsmView } from './LsmView';
import { BtreeView } from './BtreeView';
import { StorageScoreboard } from './StorageScoreboard';
import { StorageFaultBar } from './StorageFaultBar';

export function StorageLab() {
  const [epoch, setEpoch] = useState(0);
  const [key, setKey] = useState('k0');
  const [val, setVal] = useState('1');
  const [nextBulk, setNextBulk] = useState(0);
  const [probe, setProbe] = useState<{ key: string; val: string } | null>(null);
  // Whether a crash-mid-write fault has been fired since the probe key was written.
  // The crash challenge is only won if the key survives *a crash* — not merely the write.
  const [crashed, setCrashed] = useState(false);
  const [driver, setDriver] = useState<SimDriver<StorageState> | null>(null);

  // Driver-in-effect pattern: build the sim in the commit phase, never during render.
  useEffect(() => {
    useSimStore.getState().reset();
    const seed = 3000 + epoch;
    const sim = new Simulation<StorageState>({ module: storage, config: { nodeIds: STORAGE_TOPOLOGY }, seed });
    const d = new SimDriver({ sim, seed, publish: (v) => useSimStore.getState().publish(v) });
    setDriver(d);
    setNextBulk(0);
    setProbe(null);
    setCrashed(false);
    return () => d.pause();
  }, [epoch]);

  const view = useSimStore();
  if (!driver) return null;

  const statesOf = () => new Map<NodeId, StorageState>(STORAGE_TOPOLOGY.map((id) => [id, driver.sim.getState(id)] as const));
  const both = (payload: unknown) => {
    driver.external(LSM, payload);
    driver.external(BTREE, payload);
  };
  const faultBoth = (f: StorageFault['fault']) => {
    both({ fault: f });
    if (f === 'crash-mid-write') setCrashed(true);
  };

  const inspects = new Map(view.nodes.map((n) => [n.id, n.inspect]));
  const lsm = inspects.get(LSM) as unknown as LsmInspect | undefined;
  const btree = inspects.get(BTREE) as unknown as BtreeInspect | undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
        <button className={btn} onClick={() => setEpoch((e) => e + 1)}>reset (new seed)</button>
        <span className="text-dim">same key/value drives both engines</span>
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
        {lsm && <LsmView inspect={lsm} />}
        {btree && <BtreeView inspect={btree} />}
        <MetricsPanel history={view.metricsHistory} />
      </div>

      {lsm && btree && <StorageScoreboard lsm={lsm} btree={btree} />}

      <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
        <input className={`w-16 ${inputBox}`} value={key} onChange={(e) => setKey(e.target.value)} aria-label="key" />
        <input className={`w-16 ${inputBox}`} value={val} onChange={(e) => setVal(e.target.value)} aria-label="value" />
        <button className={btn} onClick={() => { both({ op: 'put', key, val }); setProbe({ key, val }); setCrashed(false); }}>write</button>
        <button className={btn} onClick={() => both({ op: 'get', key })}>read</button>
        <button className={btn} onClick={() => both({ op: 'delete', key })}>delete</button>
        <button className={btn} onClick={() => { for (let i = 0; i < 8; i++) both({ op: 'put', key: `b${nextBulk + i}`, val: 'v' }); setNextBulk((n) => n + 8); }}>bulk +8</button>
      </div>

      <StorageFaultBar onFault={faultBoth} />

      <ChallengePanel
        title="Chaos: crash mid-write — what does the WAL save?"
        storageKeyPrefix="ddia:ch03:crash"
        prompt="Write a key, then hit 'crash mid-write'. Predict: does the key survive on each engine?"
        runningHint="write a key (both engines), then 'crash mid-write', then read it back."
        check={() => {
          if (!probe || !crashed) return null; // only a win once a crash has actually been fired
          const s = statesOf();
          const ok = readValue(s, LSM, probe.key) === probe.val && readValue(s, BTREE, probe.key) === probe.val;
          return ok ? { key: probe.key } : null;
        }}
        onWin={() => driver.pause()}
        renderWin={(w, prediction) => (
          <>
            <p>key <code className="text-set">{w.key}</code> survived the crash on both engines — the WAL replayed it after recovery. Volatile memtable / uncommitted split pages were lost; the log was not.</p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />

      <ChallengePanel
        title="Chaos: disk full — compaction stalls, splits fail"
        storageKeyPrefix="ddia:ch03:diskfull"
        prompt="Fill the disk, then bulk-load. Predict: which engine degrades, which rejects?"
        runningHint="hit 'disk full', then 'bulk +8' a few times."
        check={() => {
          const l = driver.sim.getState(LSM);
          const b = driver.sim.getState(BTREE);
          const lFull = l.engine === 'lsm' && l.diskFull;
          const bFull = b.engine === 'btree' && b.diskFull;
          const stalled = l.engine === 'lsm' && l.sstables.filter((t) => t.level === 0).length >= L0_TRIGGER;
          return lFull && bFull && stalled ? { stalled: true } : null;
        }}
        onWin={() => driver.pause()}
        renderWin={(_w, prediction) => (
          <>
            <p>LSM keeps serving but read-amp climbs — compaction needs headroom it doesn't have, so L0 piles up. The B-tree refused the split outright. Space vs availability, made concrete.</p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />

      <ChallengePanel
        title="Chaos: torn write — detect the corruption"
        storageKeyPrefix="ddia:ch03:torn"
        prompt="Flush a run, then tear a write. Predict: is the corruption detected or silently served?"
        runningHint="bulk-load to flush an SSTable, then 'torn write', then 'recover'."
        check={() => {
          const l = driver.sim.getState(LSM);
          return l.engine === 'lsm' && l.sstables.some((t) => t.torn) ? { torn: true } : null;
        }}
        onWin={() => driver.pause()}
        renderWin={(_w, prediction) => (
          <>
            <p>the torn run is flagged, not served as truth — <code>recover</code> rebuilds it from the WAL. A checksum is what turns silent corruption into a detectable fault.</p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />
    </div>
  );
}
