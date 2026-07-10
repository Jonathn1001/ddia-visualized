import { useEffect, useRef } from 'react';
import { Simulation } from '../../../engine';
import { pingPong, type PPPayload, type PPState } from '../../../modules/pingpong';
import { SimDriver } from '../../bridge/SimDriver';
import { useSimStore } from '../../bridge/simStore';
import { ChaosToolbar } from '../../kit/ChaosToolbar';
import { ClusterView } from '../../kit/ClusterView';
import { MetricsPanel } from '../../kit/MetricsPanel';
import { TimelineScrubber } from '../../kit/TimelineScrubber';

const NODE_IDS = ['n0', 'n1', 'n2'];

export function PingPongLab() {
  const ref = useRef<SimDriver<PPState, PPPayload> | null>(null);
  if (!ref.current) {
    useSimStore.getState().reset();
    const sim = new Simulation<PPState, PPPayload>({
      module: pingPong,
      config: { nodeIds: NODE_IDS },
      seed: 42,
      network: { latency: [5, 40] },
    });
    ref.current = new SimDriver({ sim, seed: 42, publish: (v) => useSimStore.getState().publish(v) });
  }
  const driver = ref.current;
  useEffect(() => () => driver.pause(), [driver]);
  const view = useSimStore();

  return (
    <div className="space-y-4">
      <TimelineScrubber
        processed={view.processed}
        pending={view.pending}
        running={view.running}
        onPlayPause={() => (view.running ? driver.pause() : driver.start())}
        onStep={() => driver.stepOnce()}
        onScrub={(i) => driver.scrubTo(i)}
      />
      <div className="flex gap-6 items-start">
        <ClusterView
          nodes={view.nodes}
          inFlight={view.inFlight}
          time={view.time}
          onNodeClick={(id) =>
            driver.control(
              view.nodes.find((n) => n.id === id)?.dead ? { type: 'revive', node: id } : { type: 'kill', node: id },
            )
          }
        />
        <MetricsPanel history={view.metricsHistory} />
      </div>
      <ChaosToolbar
        caps={pingPong.chaos}
        nodeIds={NODE_IDS}
        deadNodes={view.nodes.filter((n) => n.dead).map((n) => n.id)}
        onAction={(a) => driver.control(a)}
      />
    </div>
  );
}
