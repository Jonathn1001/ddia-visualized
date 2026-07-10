import { EventQueue, type NodeId, type SimEvent } from './events';
import { SeededRng } from './rng';
import { SimNetwork, type NetworkOptions, type NetworkSnapshot } from './network';
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
  /** False when the event was skipped at delivery (dead target or partition). */
  delivered: boolean;
  dropReason?: 'dead-node' | 'partition';
}

export interface SimSnapshot {
  time: number;
  seq: number;
  processed: number;
  rngState: number;
  heap: SimEvent[];
  states: [NodeId, unknown][];
  dead: NodeId[];
  network: NetworkSnapshot;
  logLength: number;
}

/** A scheduled-but-undelivered message — the renderer's "dots in flight". */
export interface InFlightMessage {
  from: NodeId;
  target: NodeId;
  sentAt: number;
  deliverAt: number;
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

  /** Currently-killed nodes — cheap accessor for the UI bridge. */
  deadNodes(): NodeId[] {
    return [...this.dead];
  }

  get pending(): number {
    return this.queue.size;
  }

  /** Read-only view of undelivered messages, sorted by delivery time. */
  inFlight(): InFlightMessage[] {
    return this.queue
      .toArray()
      .filter((e) => e.kind === 'message')
      .map((e) => ({
        from: e.from!,
        target: e.target,
        sentAt: e.sentAt ?? e.time,
        deliverAt: e.time,
        payload: structuredClone(e.payload),
      }))
      .sort((a, b) => a.deliverAt - b.deliverAt || a.sentAt - b.sentAt);
  }

  /** Process exactly one event. Returns its log entry, or undefined if idle. */
  step(): LoggedEvent | undefined {
    const e = this.queue.pop();
    if (!e) return undefined;
    this.time = e.time;
    const isControl = e.kind === 'control';
    const deadTarget = !isControl && this.dead.has(e.target);
    // Recheck reachability at delivery, not just at send: a partition may form
    // between send and delivery, and an in-flight message is then lost.
    // Deterministic because network state at the virtual delivery time is
    // itself deterministic. Dead-node takes precedence over partition.
    const blocked =
      !isControl &&
      !deadTarget &&
      e.kind === 'message' &&
      e.from !== undefined &&
      !this.network.canReach(e.from, e.target);
    const logged: LoggedEvent = {
      index: this.processed,
      time: e.time,
      target: e.target,
      kind: e.kind,
      from: e.from,
      payload: e.payload,
      delivered: !deadTarget && !blocked,
      ...(deadTarget ? { dropReason: 'dead-node' as const } : blocked ? { dropReason: 'partition' as const } : {}),
    };
    this.eventLog.push(logged);
    this.processed++;

    if (isControl) {
      this.applyControl(e.payload as ControlAction);
      return logged;
    }
    if (logged.delivered) {
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
        this.schedule({
          time: this.time + d.delay,
          target: ef.to,
          kind: 'message',
          from: self,
          sentAt: this.time,
          payload: ef.payload,
        });
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

  /** Full deep-copied state of the sim — everything replay needs. */
  snapshot(): SimSnapshot {
    return structuredClone({
      time: this.time,
      seq: this.seq,
      processed: this.processed,
      rngState: this.rng.getState(),
      heap: this.queue.toArray(),
      states: [...this.states.entries()],
      dead: [...this.dead],
      network: this.network.snapshot(),
      logLength: this.eventLog.length,
    }) as SimSnapshot;
  }

  restore(s: SimSnapshot): void {
    const c = structuredClone(s) as SimSnapshot;
    this.time = c.time;
    this.seq = c.seq;
    this.processed = c.processed;
    this.rng.setState(c.rngState);
    this.queue.loadFrom(c.heap);
    this.states = new Map(c.states as [NodeId, S][]);
    this.dead = new Set(c.dead);
    this.network.restore(c.network);
    if (c.logLength > this.eventLog.length) {
      throw new Error(
        `cannot restore to logLength ${c.logLength} > current eventLog length ${this.eventLog.length}: ` +
          `snapshots store the log length, not its entries, so a forward restore must be reached by replay`,
      );
    }
    this.eventLog.length = c.logLength; // truncate; future entries are re-derived on replay
  }
}
