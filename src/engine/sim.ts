import { EventQueue, type NodeId, type SimEvent } from './events';
import { SeededRng } from './rng';
import { SimNetwork, type NetworkOptions } from './network';
import type { Effect, ModuleConfig, ModuleEvent, SimModule } from './module';

/** Chaos & config actions. Enter the event queue like any user input. */
export type ControlAction =
  | { type: 'kill'; node: NodeId }
  | { type: 'revive'; node: NodeId }
  | { type: 'partition'; groups: NodeId[][] }
  | { type: 'heal' }
  | { type: 'net'; opts: Partial<NetworkOptions> };

export interface LoggedEvent {
  index: number;
  time: number;
  target: NodeId;
  kind: SimEvent['kind'];
  from?: NodeId;
  payload: unknown;
}

/** Reserved pseudo-target for engine-level control events. */
const CONTROL_TARGET = '#control';

export class Simulation<S, P = unknown> {
  readonly module: SimModule<S, P>;
  readonly config: ModuleConfig;
  readonly network: SimNetwork;
  readonly eventLog: LoggedEvent[] = [];
  time = 0;
  /** Number of events processed so far — the timeline position. */
  processed = 0;

  protected seq = 0;
  protected rng: SeededRng;
  protected queue = new EventQueue();
  protected states = new Map<NodeId, S>();
  protected dead = new Set<NodeId>();

  constructor(opts: {
    module: SimModule<S, P>;
    config: ModuleConfig;
    seed: number;
    network?: Partial<NetworkOptions>;
  }) {
    this.module = opts.module;
    this.config = opts.config;
    this.rng = new SeededRng(opts.seed);
    this.network = new SimNetwork(opts.network);
    for (const id of opts.config.nodeIds) {
      this.states.set(id, this.module.init(id, this.config, this.rng));
      this.schedule({ time: 0, target: id, kind: 'init', payload: null });
    }
  }

  protected schedule(e: Omit<SimEvent, 'seq'>): void {
    this.queue.push({ ...e, seq: this.seq++ });
  }

  /** User input path — enters the queue at current virtual time (DESIGN_PLAN §5). */
  external(target: NodeId, payload: unknown): void {
    this.schedule({ time: this.time, target, kind: 'external', payload });
  }

  /** Chaos path — same rule: recorded, replayable. */
  control(action: ControlAction): void {
    this.schedule({ time: this.time, target: CONTROL_TARGET, kind: 'control', payload: action });
  }

  getState(id: NodeId): S {
    const s = this.states.get(id);
    if (s === undefined) throw new Error(`unknown node: ${id}`);
    return s;
  }

  get pending(): number {
    return this.queue.size;
  }

  /** Process exactly one event. Returns its log entry, or undefined if idle. */
  step(): LoggedEvent | undefined {
    const e = this.queue.pop();
    if (!e) return undefined;
    this.time = e.time;
    const logged: LoggedEvent = {
      index: this.processed,
      time: e.time,
      target: e.target,
      kind: e.kind,
      from: e.from,
      payload: e.payload,
    };
    this.eventLog.push(logged);
    this.processed++;

    if (e.kind === 'control') {
      this.applyControl(e.payload as ControlAction);
      return logged;
    }
    const blocked = e.kind === 'message' && e.from !== undefined && !this.network.canReach(e.from, e.target);
    if (!this.dead.has(e.target) && !blocked) {
      const mev: ModuleEvent<P> = {
        kind: e.kind as ModuleEvent<P>['kind'],
        self: e.target,
        from: e.from,
        payload: e.payload as P,
      };
      const [next, effects] = this.module.reduce(this.states.get(e.target)!, mev, this.rng);
      this.states.set(e.target, next);
      for (const ef of effects) this.applyEffect(e.target, ef);
    }
    return logged;
  }

  protected applyControl(a: ControlAction): void {
    switch (a.type) {
      case 'kill':
        this.dead.add(a.node);
        break;
      case 'revive':
        this.dead.delete(a.node);
        break;
      case 'partition':
        this.network.partition(a.groups);
        break;
      case 'heal':
        this.network.heal();
        break;
      case 'net':
        Object.assign(this.network.opts, a.opts);
        break;
    }
  }

  protected applyEffect(self: NodeId, ef: Effect): void {
    if (ef.type === 'timer') {
      this.schedule({ time: this.time + ef.delay, target: self, kind: 'timer', payload: ef.payload });
    } else {
      for (const d of this.network.plan(self, ef.to, this.rng)) {
        this.schedule({ time: this.time + d.delay, target: ef.to, kind: 'message', from: self, payload: ef.payload });
      }
    }
  }

  runSteps(n: number): void {
    for (let i = 0; i < n && this.queue.size > 0; i++) this.step();
  }

  /** Process all events with time <= t, then advance the clock to t. */
  runUntil(t: number): void {
    for (let next = this.queue.peek(); next && next.time <= t; next = this.queue.peek()) this.step();
    this.time = Math.max(this.time, t);
  }
}
