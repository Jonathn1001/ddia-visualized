import { useEffect, useState } from 'react';
import { Simulation } from '../../../engine';
import { unbundled, type DbInspect, type DbState, type UnbundledPayload } from '../../../modules/unbundled';
import {
  CATEGORIES,
  DB,
  UNBUNDLED_NODES,
  VIEWS,
  deriveAnalytics,
  deriveCache,
  tokenize,
  type Category,
  type RecordValue,
  type ViewId,
} from '../../../modules/unbundled-shared';
import { SimDriver } from '../../bridge/SimDriver';
import { useSimStore } from '../../bridge/simStore';
import { ChallengePanel } from '../../kit/ChallengePanel';
import { MetricsPanel } from '../../kit/MetricsPanel';
import { TimelineScrubber } from '../../kit/TimelineScrubber';
import { btn, btnPrimary, inputBox } from '../../kit/classes';
import { DerivedPanel } from './DerivedPanel';

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const VIEW_LABEL: Record<ViewId, string> = { search: 'Search Index', cache: 'Cache', analytics: 'Analytics' };
const WRITE_KEYS = Array.from({ length: 9 }, (_, i) => `p${i + 1}`);
const sumTally = (t: Record<string, number>) => Object.values(t).reduce((a, b) => a + b, 0);

function getPaused(dbv: DbInspect, v: ViewId): boolean {
  return v === 'search' ? dbv.search.paused : v === 'cache' ? dbv.cache.paused : dbv.analytics.paused;
}
function getDedup(dbv: DbInspect, v: ViewId): boolean {
  return v === 'search' ? dbv.search.dedup : v === 'cache' ? dbv.cache.dedup : dbv.analytics.dedup;
}

type QueryResult =
  | { view: 'search'; term: string; hits: string[]; inLog: boolean }
  | { view: 'cache'; key: string; value: RecordValue | undefined; truth: RecordValue | undefined }
  | { view: 'analytics'; category: string; count: number; truth: number };

export function UnbundledLab() {
  const [epoch, setEpoch] = useState(0);
  const [driver, setDriver] = useState<SimDriver<DbState, UnbundledPayload> | null>(null);

  // write form
  const [wKey, setWKey] = useState('p9');
  const [wTitle, setWTitle] = useState('kafka streams');
  const [wCat, setWCat] = useState<Category>('tool');

  // query bar
  const [qView, setQView] = useState<ViewId>('search');
  const [qInput, setQInput] = useState('zookeeper');
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);

  // challenge flags (epoch-scoped)
  const [c1Miss, setC1Miss] = useState<string | null>(null);
  const [c3SawOver, setC3SawOver] = useState(false);
  const [c3Redup, setC3Redup] = useState(false);

  useEffect(() => {
    useSimStore.getState().reset();
    const seed = 12000 + epoch;
    const sim = new Simulation<DbState, UnbundledPayload>({ module: unbundled, config: { nodeIds: UNBUNDLED_NODES }, seed });
    const d = new SimDriver({ sim, seed, publish: (v) => useSimStore.getState().publish(v) });
    // Drain exactly UNBUNDLED_NODES.length (== 1) init events to arm the three
    // advance timers (plan Global Constraints). The advance timers keep the
    // queue non-empty forever, so do NOT loop-drain to empty.
    for (let i = 0; i < UNBUNDLED_NODES.length; i++) d.stepOnce();
    setDriver(d);
    setC1Miss(null);
    setC3SawOver(false);
    setC3Redup(false);
    setQueryResult(null);
    return () => d.pause();
  }, [epoch]);

  const view = useSimStore();
  const dbv = driver
    ? (view.nodes.find((n) => n.id === DB)?.inspect as unknown as DbInspect | undefined)
    : undefined;

  // C3's over-count is detected reactively from the render snapshot, never
  // synchronously right after driver.external() — external() only enqueues;
  // the redeliver hasn't been processed until the next step/play (harness
  // fact, same as Tasks 2-5). Over-counting analytics is only reachable via
  // a dedup-off redeliver, so this reliably means "the user drove one".
  useEffect(() => {
    if (!dbv) return;
    if (sumTally(dbv.analytics.tally) > sumTally(deriveAnalytics(dbv.log))) setC3SawOver(true);
  }, [dbv]);

  if (!driver || !dbv) return null;

  // C2's wipe is read from a DURABLE marker (dbv.cache.wipes), not a transient
  // render state. Watching for the transient post-wipe snapshot (offset back
  // to 0, contents empty) is fragile under batching: SimDriver.tick() runs
  // `speed` (25) events per animation frame before publishing once, and a
  // cache wipe only needs ~4 advance firings (~12-13 events) to fully
  // rebuild — so under "play" the zeroed intermediate state can be skipped
  // entirely between two publishes and this challenge could never be won
  // except via the single-step button. `wipes` increments on every wipe and
  // never resets on rebuild, so it survives batching either way.
  //
  // No instant-win regression: driver.external({cmd:'wipe',...}) only
  // enqueues — publishNow() right after the click still reflects the
  // PRE-wipe state, where cache.wipes hasn't incremented yet, so c2Wiped is
  // false and check() can't win off the click alone. Only once the wipe
  // event is actually processed (next step/tick) does wipes become >0.
  const c2Wiped = dbv.cache.wipes > 0;

  const onView = (v: ViewId) => ({
    onPause: () => driver.external(DB, { cmd: getPaused(dbv, v) ? 'resume' : 'pause', view: v }),
    onWipe: () => driver.external(DB, { cmd: 'wipe', view: v }),
    onRedeliver: () => {
      // Click intent: was dedup ON at the moment the reader chose to redeliver?
      // Reading dbv here is fine — it reflects the current (already-processed)
      // dedup flag, not the not-yet-processed redeliver itself.
      const dedupOn = getDedup(dbv, v);
      driver.external(DB, { cmd: 'redeliver', view: v });
      if (v === 'analytics' && dedupOn) setC3Redup(true);
    },
    onToggleDedup: () => driver.external(DB, { cmd: 'toggle-dedup', view: v }),
  });

  const runSearchQuery = (raw: string) => {
    const term = raw.trim().toLowerCase();
    const hits = dbv.search.index[term] ?? [];
    const inLog = dbv.log.some((r) => tokenize(r.value.title).includes(term));
    setQueryResult({ view: 'search', term, hits, inLog });
    if (hits.length === 0 && inLog) setC1Miss(term); // miss while the log already has it → RYW armed
  };
  const runCacheQuery = (raw: string) => {
    const key = raw.trim();
    setQueryResult({ view: 'cache', key, value: dbv.cache.map[key], truth: deriveCache(dbv.log)[key] });
  };
  const runAnalyticsQuery = (raw: string) => {
    const category = raw.trim().toLowerCase() as Category;
    setQueryResult({
      view: 'analytics',
      category,
      count: dbv.analytics.tally[category] ?? 0,
      truth: deriveAnalytics(dbv.log)[category] ?? 0,
    });
  };
  const runQuery = () => {
    if (qView === 'search') runSearchQuery(qInput);
    else if (qView === 'cache') runCacheQuery(qInput);
    else runAnalyticsQuery(qInput);
  };

  const searchBody = (
    <ul className="space-y-0.5">
      {Object.keys(dbv.search.index).length === 0 && <li className="text-dim">(empty)</li>}
      {Object.entries(dbv.search.index).map(([term, keys]) => (
        <li key={term}>
          <span className="text-dim">{term}</span> → {keys.join(', ')}
        </li>
      ))}
    </ul>
  );
  const cacheBody = (
    <table className="w-full text-left">
      <tbody>
        {Object.keys(dbv.cache.map).length === 0 && (
          <tr>
            <td className="text-dim">(empty)</td>
          </tr>
        )}
        {Object.entries(dbv.cache.map).map(([key, v]) => (
          <tr key={key}>
            <td className="pr-2 text-dim">{key}</td>
            <td className="pr-2">{v.title}</td>
            <td className="text-dim">{v.category}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  const analyticsBody = (
    <div className="flex gap-3">
      {CATEGORIES.map((c) => (
        <span key={c}>
          <span className="text-dim">{c}</span>: {dbv.analytics.tally[c]}
        </span>
      ))}
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
        <button className={btn} onClick={() => setEpoch((e) => e + 1)}>reset (new seed)</button>
        <button data-action="lab-step" className={btn} onClick={() => driver.stepOnce()} disabled={view.running}>step</button>
        <span className="text-dim">one log, three lagging views — write, then step or play to watch them catch up</span>
      </div>

      <div className="flex flex-wrap items-center gap-2 font-mono text-xs border border-line bg-panel rounded p-3">
        <span className="text-dim">write</span>
        <select className={inputBox} value={wKey} onChange={(e) => setWKey(e.target.value)}>
          {WRITE_KEYS.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
        <input
          className={inputBox}
          value={wTitle}
          onChange={(e) => setWTitle(e.target.value)}
          placeholder="title"
        />
        <select className={inputBox} value={wCat} onChange={(e) => setWCat(e.target.value as Category)}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <button
          data-action="write"
          className={btnPrimary}
          onClick={() => driver.external(DB, { cmd: 'write', key: wKey, value: { title: wTitle, category: wCat } })}
        >
          write
        </button>
      </div>

      <div className="flex flex-wrap gap-1 items-center font-mono text-xs border border-line bg-panel rounded p-3">
        <span className="text-dim mr-2">log · head {dbv.head}</span>
        {dbv.log.map((r) => (
          <span
            key={r.offset}
            data-offset={r.offset}
            title={`${r.key}: ${r.value.title} (${r.value.category})`}
            className={`px-1.5 py-0.5 rounded border ${
              r.offset === dbv.head - 1 ? 'border-set text-set' : 'border-line text-dim'
            }`}
          >
            {r.offset}:{r.key}
          </span>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 font-mono text-xs border border-line bg-panel rounded p-3">
        <span className="text-dim">query</span>
        <select className={inputBox} value={qView} onChange={(e) => setQView(e.target.value as ViewId)}>
          {VIEWS.map((v) => (
            <option key={v} value={v}>{VIEW_LABEL[v]}</option>
          ))}
        </select>
        <input
          className={inputBox}
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          placeholder={qView === 'search' ? 'term' : qView === 'cache' ? 'key (p1..p9)' : 'category'}
        />
        <button data-action="query" className={btn} onClick={runQuery}>ask</button>
        {queryResult?.view === 'search' && (
          <span className="text-fg">
            “{queryResult.term}” → {queryResult.hits.length ? queryResult.hits.join(', ') : 'MISS'}
            {' '}(log has it: {queryResult.inLog ? 'yes' : 'no'})
          </span>
        )}
        {queryResult?.view === 'cache' && (
          <span className="text-fg">
            {queryResult.key} → view: {queryResult.value ? queryResult.value.title : 'MISS'} · log truth:{' '}
            {queryResult.truth ? queryResult.truth.title : '(none)'}
          </span>
        )}
        {queryResult?.view === 'analytics' && (
          <span className="text-fg">
            {queryResult.category} → view: {queryResult.count} · log truth: {queryResult.truth}
          </span>
        )}
      </div>

      <TimelineScrubber
        processed={view.processed}
        pending={view.pending}
        running={view.running}
        onPlayPause={() => (view.running ? driver.pause() : driver.start())}
        onStep={() => driver.stepOnce()}
        onScrub={(i) => {
          // forward only: a backward scrub can't be replayed against the
          // React-side challenge flags (c1Miss/c2Wiped/c3SawOver/c3Redup),
          // which survive the scrub and would desync from the replayed sim
          if (i >= view.processed) driver.scrubTo(i);
        }}
      />

      <DerivedPanel
        view="search"
        label={VIEW_LABEL.search}
        head={dbv.head}
        offset={dbv.search.offset}
        paused={dbv.search.paused}
        dedup={dbv.search.dedup}
        body={searchBody}
        {...onView('search')}
      />
      <DerivedPanel
        view="cache"
        label={VIEW_LABEL.cache}
        head={dbv.head}
        offset={dbv.cache.offset}
        paused={dbv.cache.paused}
        dedup={dbv.cache.dedup}
        body={cacheBody}
        {...onView('cache')}
      />
      <DerivedPanel
        view="analytics"
        label={VIEW_LABEL.analytics}
        head={dbv.head}
        offset={dbv.analytics.offset}
        paused={dbv.analytics.paused}
        dedup={dbv.analytics.dedup}
        body={analyticsBody}
        {...onView('analytics')}
      />

      <MetricsPanel history={view.metricsHistory} />

      <ChallengePanel
        title="Challenge: the read-your-write miss"
        storageKeyPrefix="ddia:ch12:staleread"
        prompt="Pause the Search view, then write a fresh record. Query the index for a word from that new title before it catches up. Predict: does the search hit or miss — and does resuming + playing change the answer to that exact same query?"
        runningHint="pause search → write a new key → query for a word in its title (expect a miss) → resume → step/play → query again."
        check={() => (c1Miss && (dbv.search.index[c1Miss]?.length ?? 0) > 0 ? { term: c1Miss } : null)}
        onWin={() => driver.pause()}
        renderWin={(w, prediction) => (
          <>
            <p>
              The word “{w.term}” was in the log the instant you wrote it — the source of truth updated
              immediately. But the search index only reflects the prefix of the log it has consumed, and it
              was paused, so your query came back empty: a stale read, the read-your-writes anomaly. Resuming
              let the advance timer replay the record it had missed, and the exact same query now hits. The
              index was never wrong — it was just behind. Lag is not corruption.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />

      <ChallengePanel
        title="Challenge: wipe the cache, rebuild from the log"
        storageKeyPrefix="ddia:ch12:rebuild"
        prompt="Wipe the Cache view — its contents vanish and its offset resets to zero. Predict: is that data gone for good, or can stepping/playing alone bring it back byte-for-byte, with no backup involved?"
        runningHint="wipe the cache → step or play until its offset catches back up to head."
        check={() =>
          c2Wiped && dbv.cache.offset === dbv.head && eq(dbv.cache.map, deriveCache(dbv.log))
            ? { head: dbv.head }
            : null
        }
        onWin={() => driver.pause()}
        renderWin={(w, prediction) => (
          <>
            <p>
              The cache never held anything the log didn't already have — it was a materialized copy, nothing
              more. Wiping it destroyed no information, because the log itself never moved. Playing out let the
              advance timer replay every record from offset 0, and by the time it reached head {w.head} the
              cache was back to a byte-exact copy of the log's own derivation. Derived data can be thrown away
              precisely because it's redundant — the log is the one copy that has to survive.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />

      <ChallengePanel
        title="Challenge: redeliver twice, count once"
        storageKeyPrefix="ddia:ch12:exactlyonce"
        prompt="With idempotence off, redeliver the last record to Analytics — watch its tally climb past the log's true count. A double-added count can't be subtracted, so wipe Analytics to force a clean rebuild, turn dedup on, then redeliver once more. Predict: does that final redelivery double-count again, or does something make it a safe no-op this time?"
        runningHint="redeliver analytics with dedup off (tally exceeds truth) → toggle dedup on → wipe analytics → step/play until it rebuilds to head → redeliver once more → tally settles exact."
        check={() =>
          c3SawOver && c3Redup && eq(dbv.analytics.tally, deriveAnalytics(dbv.log)) ? { ok: true } : null
        }
        onWin={() => driver.pause()}
        renderWin={(_w, prediction) => (
          <>
            <p>
              With dedup off, redelivering the last record re-ran the same aggregation twice — analytics has
              no idea a record is a retry, so its monotonic counter double-counted it. That's the
              at-least-once default: a crash-retry can always duplicate, and once counted twice there's no
              subtracting your way back — you rebuilt Analytics from the log to erase the corruption. With
              dedup on, the final redeliver left the tally exact, because idempotence keyed on offset
              recognizes "I've already applied this one" and skips the replay. This is the end-to-end argument
              in miniature: exactly-once delivery is a fiction the network can't provide — the endpoint has to
              make the retry safe itself.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />
    </div>
  );
}
