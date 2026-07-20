import { useEffect, useState } from 'react';
import { Simulation } from '../../../engine';
import { models, type ModelsInspect, type ModelsPayload, type ModelsState } from '../../../modules/models';
import { DM, MODELS, MODELS_NODES, USERS, type Id } from '../../../modules/models-shared';
import { SimDriver } from '../../bridge/SimDriver';
import { useSimStore } from '../../bridge/simStore';
import { ChallengePanel } from '../../kit/ChallengePanel';
import { MetricsPanel } from '../../kit/MetricsPanel';
import { TimelineScrubber } from '../../kit/TimelineScrubber';
import { btn, btnPrimary, inputBox } from '../../kit/classes';
import { ModelPanel } from './ModelPanel';

type Scenario = 'fof' | 'm2m' | 'schema';
const LABEL: Record<'relational' | 'document' | 'graph', string> = {
  relational: 'Relational',
  document: 'Document',
  graph: 'Graph',
};

export function ModelShifterLab() {
  const [epoch, setEpoch] = useState(0);
  const [driver, setDriver] = useState<SimDriver<ModelsState, ModelsPayload> | null>(null);
  const [scenario, setScenario] = useState<Scenario>('fof');
  const [root, setRoot] = useState<Id>('alice');

  useEffect(() => {
    useSimStore.getState().reset();
    const seed = 2000 + epoch;
    const sim = new Simulation<ModelsState, ModelsPayload>({ module: models, config: { nodeIds: MODELS_NODES }, seed });
    const d = new SimDriver({ sim, seed, publish: (v) => useSimStore.getState().publish(v) });
    for (let i = 0; i < MODELS_NODES.length; i++) d.stepOnce();
    setDriver(d);
    setScenario('fof');
    setRoot('alice');
    return () => d.pause();
  }, [epoch]);

  const view = useSimStore();
  const mv = driver ? (view.nodes.find((n) => n.id === DM)?.inspect as unknown as ModelsInspect | undefined) : undefined;

  if (!driver || !mv) return null;

  const pickFof = (r: Id) => {
    setScenario('fof');
    setRoot(r);
    driver.external(DM, { cmd: 'set-query', query: 'fof', root: r });
  };
  const pickM2m = () => {
    setScenario('m2m');
    driver.external(DM, { cmd: 'set-query', query: 'm2m' });
  };
  const pickSchema = () => setScenario('schema');

  // The schema scenario hides the transport, so its one-shot commands must be applied
  // immediately: external() only enqueues, so step once to process it (no animation).
  const applyNow = (payload: ModelsPayload) => {
    driver.external(DM, payload);
    driver.stepOnce();
  };

  const isQuery = scenario === 'fof' || scenario === 'm2m';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
        <button className={btn} onClick={() => setEpoch((e) => e + 1)}>
          reset (new seed)
        </button>
        {isQuery && (
          <button data-action="lab-step" className={btn} onClick={() => driver.stepOnce()} disabled={view.running}>
            step
          </button>
        )}
        <span className="text-dim">
          same data, three models — run the same query and watch the document model pay the N+1 round-trip tax
        </span>
      </div>

      {/* scenario picker */}
      <div className="flex flex-wrap items-center gap-2 font-mono text-xs border border-line bg-panel rounded p-3">
        <span className="text-dim">scenario</span>
        <button className={scenario === 'fof' ? btnPrimary : btn} onClick={() => pickFof(root)}>
          friends-of-friends
        </button>
        {scenario === 'fof' && (
          <select className={inputBox} value={root} onChange={(e) => pickFof(e.target.value)} aria-label="start user">
            {USERS.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        )}
        <button data-action="scenario-m2m" className={scenario === 'm2m' ? btnPrimary : btn} onClick={pickM2m}>
          many-to-many (likes in category)
        </button>
        <button className={scenario === 'schema' ? btnPrimary : btn} onClick={pickSchema}>
          schema: add a field
        </button>
        {scenario === 'schema' && (
          <>
            <button data-action="add-field" className={btnPrimary} onClick={() => applyNow({ cmd: 'add-field' })}>
              add nickname
            </button>
            <button className={btn} onClick={() => applyNow({ cmd: 'reset-schema' })}>
              reset field
            </button>
          </>
        )}
      </div>

      {isQuery && (
        <TimelineScrubber
          processed={view.processed}
          pending={view.pending}
          running={view.running}
          onPlayPause={() => (view.running ? driver.pause() : driver.start())}
          onStep={() => driver.stepOnce()}
          onScrub={(i) => {
            if (i >= view.processed) driver.scrubTo(i);
          }}
        />
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {MODELS.map((m) => (
          <ModelPanel key={m} model={m} label={LABEL[m]} view={mv.models[m]} nicknameAdded={mv.nicknameAdded} />
        ))}
      </div>

      {isQuery && <MetricsPanel history={view.metricsHistory} />}

      <ChallengePanel
        title="Challenge: friends-of-friends — the join tax"
        storageKeyPrefix="ddia:ch02:fof"
        prompt="Run friends-of-friends and play all three models to the finish. Predict: they return the same people — but which model pays for it, and in what currency? Watch the round-trip counts."
        runningHint="scenario = friends-of-friends → play until all three finish. Same answer, but the document model's round trips dwarf the graph's one traversal."
        check={() => (mv.ch.c1 ? { rt: mv.models.document.roundTrips } : null)}
        onWin={() => driver.pause()}
        renderWin={(w, prediction) => (
          <>
            <p>
              All three returned the same friends-of-friends — but the graph answered in a single traversal (1
              round trip, following pointers in-engine), while the document model had to fetch each friend's
              document separately to read *their* friends: the N+1 problem, {w.rt} round trips, each a network
              call. The document store has no join, so the join moved into your application code. Same question,
              same answer, wildly different cost — because the data model, not the query, decided what was cheap.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />

      <ChallengePanel
        title="Challenge: many-to-many — documents can't join"
        storageKeyPrefix="ddia:ch02:m2m"
        prompt="Switch to the many-to-many query (users who like a tech post) and play to completion. Predict: the document model was bad at friends-of-friends — is it better or worse at a many-to-many join?"
        runningHint="scenario = many-to-many → play until done. The document model has to scan every user and fetch each liked post; the join table and the graph go straight there."
        check={() => (mv.ch.c2 ? { rt: mv.models.document.roundTrips } : null)}
        onWin={() => driver.pause()}
        renderWin={(w, prediction) => (
          <>
            <p>
              Many-to-many is where the document model hurts most. With no join, answering "who likes a tech
              post" meant scanning every user document and fetching each of their liked posts to check its
              category — {w.rt} round trips. Relational's join table and the graph's edges both answer in one
              query. This is the object-relational story in reverse: documents win for tree-shaped one-to-many
              data (locality — one fetch gets the whole subtree), and lose for many-to-many, which is exactly
              what relations and graphs are built for.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />

      <ChallengePanel
        title="Challenge: schema flexibility — read vs write"
        storageKeyPrefix="ddia:ch02:schema"
        prompt="Switch to 'add a field' and add a nickname to Alice. Predict: does the new field cost anything for the document store? For the relational tables with five other rows that don't have it?"
        runningHint="scenario = add a field → click 'add nickname'. Document/graph absorb it per-record (0 migration); relational needs an ALTER + a NULL for every existing row."
        check={() => (mv.ch.c3 ? { rel: mv.models.relational.migration } : null)}
        onWin={() => driver.pause()}
        renderWin={(w, prediction) => (
          <>
            <p>
              The document store took the new field for free: Alice's document simply grew a `nickname`, and
              the other five documents stayed exactly as they were — heterogeneous documents are the norm, so
              there is nothing to migrate. This is <strong>schema-on-read</strong>: the shape is enforced when
              you read, not when you write. The relational table paid {w.rel}: `ALTER TABLE` adds the column to
              every row, and the five users without a nickname get a NULL — <strong>schema-on-write</strong>
              guarantees every row has the column, at the cost of a migration. Flexibility vs guarantees: the
              document model bought agility, the relational model bought a promise.
            </p>
            <p className="text-dim">your prediction: “{prediction}”</p>
          </>
        )}
      />
    </div>
  );
}
