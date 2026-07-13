import { useEffect, useState } from 'react';
import { Simulation, type NodeId } from '../../../engine';
import type { SimModule } from '../../../engine';
import { API_TOPOLOGY, type ApiStats } from '../../../modules/api-shared';
import { detectRestPartial, rest, restStats, type RestState } from '../../../modules/rest';
import { detectGqlAllOrNothing, gqlStats, graphql, type GqlClient, type GqlState } from '../../../modules/graphql';
import { detectGrpcEvolution, grpc, grpcStats, serverSchema, type GrpcClient, type GrpcState } from '../../../modules/grpc';
import { SimDriver } from '../../bridge/SimDriver';
import { useSimStore } from '../../bridge/simStore';
import { ChallengePanel } from '../../kit/ChallengePanel';
import { ChaosToolbar } from '../../kit/ChaosToolbar';
import { ClusterView } from '../../kit/ClusterView';
import { MetricsPanel } from '../../kit/MetricsPanel';
import { TimelineScrubber } from '../../kit/TimelineScrubber';
import { btn, btnPrimary } from '../../kit/classes';
import { ApiStatsPanel, type ApiMode, type ExtraStat } from './ApiStatsPanel';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MODULES: Record<ApiMode, SimModule<any, any>> = { rest, graphql, grpc };

function statsFor(mode: ApiMode, states: Map<NodeId, unknown>): ApiStats {
  if (mode === 'rest') return restStats(states as Map<NodeId, RestState>);
  if (mode === 'graphql') return gqlStats(states as Map<NodeId, GqlState>);
  return grpcStats(states as Map<NodeId, GrpcState>);
}

function extrasFor(mode: ApiMode, states: Map<NodeId, unknown>): ExtraStat[] {
  if (mode === 'graphql') {
    const c = (states as Map<NodeId, GqlState>).get('Client');
    const resolverCalls = c && c.role === 'client' ? (c as GqlClient).resolverCalls : 0;
    return [{ key: 'resolver-calls', label: 'server resolver calls (hidden N+1)', value: resolverCalls, warn: resolverCalls > 1 }];
  }
  if (mode === 'grpc') {
    const c = (states as Map<NodeId, GrpcState>).get('Client');
    const skipped = c && c.role === 'client' ? (c as GrpcClient).unknownSkipped : 0;
    return [
      { key: 'unknown-fields', label: 'unknown fields skipped', value: skipped },
      { key: 'schema', label: 'server schema', value: serverSchema(states as Map<NodeId, GrpcState>) },
    ];
  }
  return [];
}

/**
 * A single API style's flow (Ch4 dataflow, three-separate-flows layout). One
 * client loads the same profile; REST / GraphQL / gRPC each mount this with a
 * fixed `mode`. The cost — round trips, bytes, failure granularity — falls out
 * of the shape of the request.
 */
export function ApiLab({ mode }: { mode: ApiMode }) {
  const [epoch, setEpoch] = useState(0);
  const [driver, setDriver] = useState<SimDriver<unknown, unknown> | null>(null);
  const [schema, setSchema] = useState<'v1' | 'v2'>('v1');

  useEffect(() => {
    useSimStore.getState().reset();
    const seed = 4000 + epoch;
    const sim = new Simulation<unknown, unknown>({
      module: MODULES[mode] as unknown as SimModule<unknown, unknown>,
      config: { nodeIds: API_TOPOLOGY },
      seed,
      network: { latency: [15, 90] },
    });
    const d = new SimDriver<unknown, unknown>({ sim, seed, publish: (v) => useSimStore.getState().publish(v) });
    d.setSpeed(4);
    setDriver(d);
    setSchema('v1');
    return () => d.pause();
  }, [mode, epoch]);

  const view = useSimStore();

  const statesOf = (d: SimDriver<unknown, unknown>) =>
    new Map<NodeId, unknown>(API_TOPOLOGY.map((id) => [id, d.sim.getState(id)] as const));

  if (!driver) return null;

  const stats = statsFor(mode, statesOf(driver));
  const extras = extrasFor(mode, statesOf(driver));

  const load = () => driver.external('Client', { cmd: 'load' });
  const setServerSchema = (v: 'v1' | 'v2') => {
    driver.external('Server', { cmd: 'setSchema', version: v });
    setSchema(v);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
        <button className={btn} onClick={() => setEpoch((e) => e + 1)}>
          reset (new seed)
        </button>
        {mode === 'grpc' && (
          <span className="flex items-center gap-1">
            <span className="text-dim">server schema:</span>
            <button className={schema === 'v1' ? btnPrimary : btn} onClick={() => setServerSchema('v1')}>
              v1
            </button>
            <button className={schema === 'v2' ? btnPrimary : btn} onClick={() => setServerSchema('v2')}>
              v2 (+field)
            </button>
          </span>
        )}
        <span className="text-dim">client → server</span>
      </div>

      <TimelineScrubber
        processed={view.processed}
        pending={view.pending}
        running={view.running}
        onPlayPause={() => (view.running ? driver.pause() : driver.start())}
        onStep={() => driver.stepOnce()}
        onScrub={(i) => driver.scrubTo(i)}
      />

      <div className="flex flex-wrap items-start gap-6">
        <ClusterView nodes={view.nodes} inFlight={view.inFlight} time={view.time} />
        <ApiStatsPanel mode={mode} stats={stats} extras={extras} />
        <MetricsPanel history={view.metricsHistory} />
      </div>

      <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
        <button className={btnPrimary} onClick={load}>
          load profile
        </button>
        <span className="text-dim">then press play (or step) to watch the request flow</span>
      </div>

      <ChaosToolbar
        caps={MODULES[mode].chaos}
        nodeIds={API_TOPOLOGY}
        deadNodes={view.nodes.filter((n) => n.dead).map((n) => n.id)}
        onAction={(a) => driver.control(a)}
      />

      {mode === 'rest' && (
        <ChallengePanel
          title="Chaos Challenge — Partial page"
          storageKeyPrefix="ddia:ch04:rest-partial"
          prompt="Predict first: if one post request is lost, what does the page show? (skippable)"
          runningHint="crank drop %, load, then press play — a lost post request times out and the page renders WITHOUT it (partial, not total, failure)."
          check={() => detectRestPartial(statesOf(driver) as Map<NodeId, RestState>)}
          onWin={() => driver.pause()}
          renderWin={(win, prediction) => (
            <>
              <p>
                the page rendered with <code className="text-warn">{win.delivered}</code> of {win.expected} posts. Because
                REST fetches each resource separately, one lost request costs one post — the rest of the page still loads.
                That resilience is the flip side of the N+1 round-trip tax.
              </p>
              <p className="text-dim">your prediction: “{prediction}”</p>
            </>
          )}
        />
      )}
      {mode === 'graphql' && (
        <ChallengePanel
          title="Chaos Challenge — All or nothing"
          storageKeyPrefix="ddia:ch04:graphql-allornothing"
          prompt="Predict first: if the single query is dropped, how much of the page loads? (skippable)"
          runningHint="crank drop % (or kill the server), then load and play — the one query fails and the WHOLE page is gone, not just a post."
          check={() => detectGqlAllOrNothing(statesOf(driver) as Map<NodeId, GqlState>)}
          onWin={() => driver.pause()}
          renderWin={(win, prediction) => (
            <>
              <p>
                the page loaded <code className="text-warn">{win.delivered}</code> posts — everything, or nothing. One
                query means one failure point: drop it and the whole document is lost. The single round trip is fast, but
                it is all-or-nothing where REST degraded gracefully.
              </p>
              <p className="text-dim">your prediction: “{prediction}”</p>
            </>
          )}
        />
      )}
      {mode === 'grpc' && (
        <ChallengePanel
          title="Chaos Challenge — Evolve the schema"
          storageKeyPrefix="ddia:ch04:grpc-evolution"
          prompt="Predict first: the server adds a field the old client never heard of. Does it break? (skippable)"
          runningHint="switch the server to schema v2 (adds a field), then load — the v1 client skips the unknown field number and still decodes everything."
          check={() => detectGrpcEvolution(statesOf(driver) as Map<NodeId, GrpcState>)}
          onWin={() => driver.pause()}
          renderWin={(win, prediction) => (
            <>
              <p>
                the v1 client skipped <code className="text-warn">{win.unknownSkipped}</code> unknown field(s) and still
                decoded the whole profile. Because protobuf identifies fields by NUMBER, adding a field is backward
                compatible — old readers ignore what they don't recognize. (Removing a required field would break them.)
              </p>
              <p className="text-dim">your prediction: “{prediction}”</p>
            </>
          )}
        />
      )}
    </div>
  );
}
