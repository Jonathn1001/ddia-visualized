import type { Effect, InspectorTree, MetricSample, SimModule } from '../engine/module';
import type { NodeId } from '../engine/events';
import type { SeededRng } from '../engine/rng';
import {
  SVC,
  SERVICE_MEAN,
  WINDOW,
  CACHE_TICKS,
  FANOUT_MIN,
  interArrivalMean,
  expTick,
  percentile,
  evalChallenges,
  freshChallenges,
  type LoadState,
  type LoadInspect,
  type SubReq,
  type Parent,
} from './load-shared';

export type LoadExternal =
  | { cmd: 'set-load'; level: number }
  | { cmd: 'set-servers'; c: number }
  | { cmd: 'set-cache'; h: number }
  | { cmd: 'set-variance'; on: boolean }
  | { cmd: 'set-fanout'; n: number };
export type LoadTimer = { t: 'arrival' } | { t: 'complete'; parentId: number; cached: boolean };
export type LoadPayload = LoadExternal | LoadTimer;

export type { LoadState, LoadInspect } from './load-shared';

const cap = (xs: number[]): number[] => (xs.length > WINDOW ? xs.slice(xs.length - WINDOW) : xs);
const capC = <T>(xs: T[]): T[] => (xs.length > WINDOW ? xs.slice(xs.length - WINDOW) : xs);

function serviceTick(state: LoadState, rng: SeededRng): number {
  return state.varianceOn ? expTick(SERVICE_MEAN, 1 - rng.next()) : SERVICE_MEAN;
}

/** Advance the busy-time accountant to `now` at the pre-event inService level. */
function tick(s: LoadState, now: number): LoadState {
  return { ...s, busyTicks: s.busyTicks + s.inService * (now - s.lastEventT), lastEventT: now };
}

const arrivalTimer = (delay: number): Effect => ({ type: 'timer', delay, payload: { t: 'arrival' } });
/** Next inter-arrival: Exponential(interArrivalMean) — Poisson arrivals, rounded to >= 1 tick. */
const nextArrival = (state: LoadState, rng: SeededRng): Effect =>
  arrivalTimer(expTick(interArrivalMean(state.loadLevel), 1 - rng.next()));
const completeTimer = (delay: number, parentId: number, cached: boolean): Effect => ({
  type: 'timer',
  delay,
  payload: { t: 'complete', parentId, cached },
});

/** Start `sub` on a free slot or enqueue it; returns [state, effects to start it]. */
function admit(s: LoadState, sub: SubReq): [LoadState, Effect[]] {
  if (sub.cached) return [s, [completeTimer(sub.service, sub.parentId, true)]]; // bypasses the servers
  if (s.inService < s.servers)
    return [{ ...s, inService: s.inService + 1 }, [completeTimer(sub.service, sub.parentId, false)]];
  return [{ ...s, queue: [...s.queue, sub] }, []];
}

function onArrival(state: LoadState, now: number, rng: SeededRng): [LoadState, Effect[]] {
  let s = tick(state, now);
  const parentId = s.nextId;
  const parent: Parent = { remaining: s.fanout, arrivalT: now, maxLatency: 0 };
  s = { ...s, nextId: s.nextId + 1, pending: { ...s.pending, [parentId]: parent } };
  const effects: Effect[] = [nextArrival(s, rng)];
  for (let i = 0; i < s.fanout; i++) {
    const cached = rng.next() < s.cacheHitRate;
    const service = cached ? CACHE_TICKS : serviceTick(s, rng);
    const sub: SubReq = { id: parentId * 1000 + i, parentId, cached, service };
    const [s2, fx] = admit(s, sub);
    s = s2;
    effects.push(...fx);
  }
  return [s, effects];
}

function onComplete(state: LoadState, now: number, p: { parentId: number; cached: boolean }): [LoadState, Effect[]] {
  let s = tick(state, now);
  const effects: Effect[] = [];
  if (!p.cached) {
    s = { ...s, inService: s.inService - 1 };
    if (s.queue.length > 0 && s.inService < s.servers) {
      const [head, ...rest] = s.queue;
      s = { ...s, queue: rest, inService: s.inService + 1 };
      effects.push(completeTimer(head.service, head.parentId, false));
    }
  }
  // join into the parent
  const parent = s.pending[p.parentId];
  if (parent) {
    const lat = now - parent.arrivalT;
    const backend = cap([...s.backend, lat]);
    const remaining = parent.remaining - 1;
    const maxLatency = Math.max(parent.maxLatency, lat);
    if (remaining === 0) {
      const rest = { ...s.pending };
      delete rest[p.parentId];
      const user = capC([...s.user, { t: now, lat: maxLatency }]);
      const ch = evalChallenges(s.ch, {
        servers: s.servers,
        varianceOn: s.varianceOn,
        fanout: s.fanout,
        user: user.map((c) => c.lat),
        backend,
      });
      s = { ...s, backend, user, pending: rest, completed: s.completed + 1, ch };
    } else {
      s = { ...s, backend, pending: { ...s.pending, [p.parentId]: { ...parent, remaining, maxLatency } } };
    }
  }
  return [s, effects];
}

function onExternal(state: LoadState, p: LoadExternal): [LoadState, Effect[]] {
  switch (p.cmd) {
    case 'set-load':
      return [{ ...state, loadLevel: p.level, ch: { ...state.ch, c1: { breached: false, rescued: false } } }, []];
    case 'set-servers':
      return [{ ...state, servers: Math.max(1, p.c) }, []];
    case 'set-cache':
      return [{ ...state, cacheHitRate: Math.min(1, Math.max(0, p.h)) }, []];
    case 'set-variance':
      return [
        { ...state, varianceOn: p.on, ch: p.on ? { ...state.ch, c2: { hiTail: false, loTail: false } } : state.ch },
        [],
      ];
    case 'set-fanout':
      return [
        { ...state, fanout: Math.max(1, p.n), ch: p.n >= FANOUT_MIN ? { ...state.ch, c3: { amplified: false } } : state.ch },
        [],
      ];
    default:
      return [state, []];
  }
}

export const load: SimModule<LoadState, LoadPayload> = {
  id: 'load',
  chaos: [],

  init(nodeId: NodeId): LoadState {
    return {
      self: nodeId,
      loadLevel: 8,
      servers: 1,
      cacheHitRate: 0,
      varianceOn: true,
      fanout: 1,
      inService: 0,
      queue: [],
      pending: {},
      nextId: 0,
      user: [],
      backend: [],
      busyTicks: 0,
      lastEventT: 0,
      completed: 0,
      ch: freshChallenges(),
    };
  },

  reduce(state, event, rng): [LoadState, Effect[]] {
    if (event.kind === 'init') return [state, [nextArrival(state, rng)]];

    if (event.kind === 'timer') {
      const p = event.payload as LoadTimer;
      if (p.t === 'arrival') return onArrival(state, event.time, rng);
      if (p.t === 'complete') return onComplete(state, event.time, p);
      return [state, []];
    }

    if (event.kind === 'external') return onExternal(state, event.payload as LoadExternal);
    return [state, []];
  },

  metrics(states): MetricSample[] {
    const s = states.get(SVC);
    if (!s) return [];
    const lat = s.user.map((c) => c.lat);
    return [
      { name: 'p99', value: percentile(lat, 99) },
      { name: 'p50', value: percentile(lat, 50) },
      { name: 'queueLen', value: s.queue.length },
      { name: 'inService', value: s.inService },
    ];
  },

  inspect(state): InspectorTree {
    const lat = state.user.map((c) => c.lat);
    const span = state.user.length >= 2 ? state.user[state.user.length - 1].t - state.user[0].t : 0;
    const elapsed = Math.max(1, state.lastEventT);
    const tree: LoadInspect = {
      loadLevel: state.loadLevel,
      servers: state.servers,
      cacheHitRate: state.cacheHitRate,
      varianceOn: state.varianceOn,
      fanout: state.fanout,
      inService: state.inService,
      queueLen: state.queue.length,
      p50: percentile(lat, 50),
      p95: percentile(lat, 95),
      p99: percentile(lat, 99),
      bp50: percentile(state.backend, 50),
      bp95: percentile(state.backend, 95),
      bp99: percentile(state.backend, 99),
      throughput: span > 0 ? state.user.length / span : 0,
      utilisation: Math.min(1, state.busyTicks / (state.servers * elapsed)),
      completed: state.completed,
      samples: state.user.length,
      sla: 0,
      ch: state.ch,
    };
    return tree as unknown as InspectorTree;
  },
};
