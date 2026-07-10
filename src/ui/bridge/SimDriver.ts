import { Simulation, TimelineRecorder, type ControlAction, type NodeId } from '../../engine';
import type { MetricsPoint, PublishedView } from './simStore';

export type { PublishedView } from './simStore';

export type SessionAction =
  | { at: number; type: 'external'; target: NodeId; payload: unknown }
  | { at: number; type: 'control'; action: ControlAction };

type Raf = (cb: () => void) => number;
type Caf = (id: number) => void;

/**
 * One-directional bridge (DESIGN_PLAN §5): steps the sim on an rAF loop and
 * publishes batched snapshots. All user input flows through external()/control()
 * so every session is recorded and replayable.
 */
export class SimDriver<S, P = unknown> {
  readonly sim: Simulation<S, P>;
  readonly recorder: TimelineRecorder<S, P>;
  readonly seed: number;
  speed = 25; // events per frame

  private readonly actions: SessionAction[] = [];
  private rafId: number | null = null;
  private readonly raf: Raf;
  private readonly caf: Caf;
  private readonly publish: (v: PublishedView) => void;

  constructor(opts: {
    sim: Simulation<S, P>;
    seed: number;
    publish: (v: PublishedView) => void;
    raf?: Raf;
    caf?: Caf;
  }) {
    this.sim = opts.sim;
    this.seed = opts.seed;
    this.publish = opts.publish;
    this.recorder = new TimelineRecorder(this.sim);
    this.raf = opts.raf ?? ((cb) => requestAnimationFrame(cb));
    this.caf = opts.caf ?? ((id) => cancelAnimationFrame(id));
    this.publishNow();
  }

  get running(): boolean {
    return this.rafId !== null;
  }

  start(): void {
    if (this.rafId !== null) return;
    this.rafId = this.raf(this.tick);
    this.publishNow();
  }

  pause(): void {
    if (this.rafId === null) return;
    this.caf(this.rafId);
    this.rafId = null;
    this.publishNow();
  }

  private tick = (): void => {
    this.rafId = this.raf(this.tick);
    this.recorder.runSteps(this.speed);
    this.publishNow();
  };

  setSpeed(n: number): void {
    this.speed = n;
  }

  stepOnce(): void {
    this.recorder.runSteps(1);
    this.publishNow();
  }

  scrubTo(index: number): void {
    this.recorder.scrubTo(index);
    this.publishNow();
  }

  external(target: NodeId, payload: unknown): void {
    this.recorder.invalidateFuture();
    this.actions.push({ at: this.sim.time, type: 'external', target, payload });
    this.sim.external(target, payload);
    this.publishNow();
  }

  control(action: ControlAction): void {
    this.recorder.invalidateFuture();
    this.actions.push({ at: this.sim.time, type: 'control', action });
    this.sim.control(action);
    this.publishNow();
  }

  exportSession(journal?: string): string {
    return JSON.stringify({ seed: this.seed, actions: this.actions, journal: journal ?? null }, null, 2);
  }

  publishNow(): void {
    const ids = this.sim.config.nodeIds;
    const dead = new Set(this.sim.deadNodes());
    const states = new Map(ids.map((id) => [id, this.sim.getState(id)] as const));
    const point: MetricsPoint = { time: this.sim.time };
    for (const m of this.sim.module.metrics(states, this.sim.time)) point[m.name] = m.value;
    this.publish({
      time: this.sim.time,
      processed: this.sim.processed,
      pending: this.sim.pending,
      running: this.running,
      speed: this.speed,
      nodes: ids.map((id) => ({ id, dead: dead.has(id), inspect: this.sim.module.inspect(states.get(id)!) })),
      inFlight: this.sim.inFlight(),
      metricsHistory: [point],
      logTail: this.sim.eventLog.slice(-50),
    });
  }
}
