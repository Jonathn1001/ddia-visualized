// Ch1 — load-simulator vocabulary: the SVC node, queueing params, the request/state
// shapes, and the pure helpers property + lesson tests assert against. Nothing here
// mutates or touches the engine RNG (helpers take a pre-drawn u).
import type { NodeId } from '../engine/events';

export const SVC: NodeId = 'SVC';
export const LOAD_NODES: NodeId[] = [SVC];

// --- queueing params (tuned so the three challenges win with margin at the lesson seed) ---
export const SERVICE_MEAN = 10; // mean service time, ticks
export const K = 120; // interArrivalMean = round(K / loadLevel)
export const LOAD_MAX = 20; // slider max; ρ(c=1) = level/12, so >12 overloads one server
export const WINDOW = 200; // rolling completions kept for percentiles/throughput
export const WINDOW_MIN = 40; // warmup: no win-flag latches before this many completions
export const CACHE_TICKS = 1; // a cache hit's service time
export const SLA = 150; // C1 p99 threshold, ticks (breach p99 ~1150 vs rescue p99 ~70 => fat gap)
export const VAR_TAIL_MULT = 3; // C2 hiTail: p99 >= MULT * p50
export const LO_TAIL_MULT = 1.5; // C2 loTail: p99 <  MULT * p50
export const FANOUT_MIN = 20; // C3 minimum fan-out
export const AMPLIFY = 1; // C3: user p50 >= AMPLIFY * backend p95 (1 = "median feels the tail")

export interface SubReq {
  id: number;
  parentId: number;
  cached: boolean;
  service: number;
}
export interface Parent {
  remaining: number;
  arrivalT: number;
  maxLatency: number;
}
export interface Completion {
  t: number;
  lat: number;
}

export interface Challenges {
  c1: { breached: boolean; rescued: boolean };
  c2: { hiTail: boolean; loTail: boolean };
  c3: { amplified: boolean };
}
export function freshChallenges(): Challenges {
  return {
    c1: { breached: false, rescued: false },
    c2: { hiTail: false, loTail: false },
    c3: { amplified: false },
  };
}

export interface LoadState {
  self: NodeId;
  // knobs
  loadLevel: number;
  servers: number;
  cacheHitRate: number;
  varianceOn: boolean;
  fanout: number;
  // runtime
  inService: number;
  queue: SubReq[];
  pending: Record<number, Parent>;
  nextId: number;
  // measurement windows (newest last, capped at WINDOW)
  user: Completion[];
  backend: number[];
  // accounting
  busyTicks: number;
  lastEventT: number;
  completed: number;
  // challenge flags
  ch: Challenges;
}

export interface LoadInspect {
  loadLevel: number;
  servers: number;
  cacheHitRate: number;
  varianceOn: boolean;
  fanout: number;
  inService: number;
  queueLen: number;
  p50: number;
  p95: number;
  p99: number;
  bp50: number;
  bp95: number;
  bp99: number;
  throughput: number;
  utilisation: number;
  completed: number;
  samples: number;
  sla: number;
  ch: Challenges;
}

/** Lower mean = higher arrival rate. Clamped to >= 1 tick. */
export function interArrivalMean(level: number): number {
  return Math.max(1, Math.round(K / Math.max(1, level)));
}

/** Rounded exponential, integer ticks >= 1. u MUST be in (0,1] — callers pass 1 - rng.next(). */
export function expTick(mean: number, u: number): number {
  const clamped = u <= 0 ? Number.MIN_VALUE : u;
  return Math.max(1, Math.round(-mean * Math.log(clamped)));
}

/** Nearest-rank percentile over an unsorted array; empty -> 0. p in 0..100. */
export function percentile(latencies: number[], p: number): number {
  if (latencies.length === 0) return 0;
  const sorted = [...latencies].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

/** Latch challenge flags from the current windows. Warmup-gated; only flips false->true. */
export function evalChallenges(
  prev: Challenges,
  s: { servers: number; varianceOn: boolean; fanout: number; user: number[]; backend: number[] },
): Challenges {
  if (s.user.length < WINDOW_MIN) return prev;
  const p50 = percentile(s.user, 50);
  const p99 = percentile(s.user, 99);
  const bp95 = percentile(s.backend, 95);
  const c1 = { ...prev.c1 };
  const c2 = { ...prev.c2 };
  const c3 = { ...prev.c3 };
  // C1 — the knee + rescue. Breach is the QUEUE-driven tail (p99 > SLA at one server);
  // the percentile-lesson (p99 >> p50) is C2's job, since p50 is not seed-stable in the
  // near-capacity regime where a replica can actually rescue.
  if (!c1.breached && s.servers === 1 && p99 > SLA) c1.breached = true;
  if (c1.breached && !c1.rescued && s.servers >= 2 && p99 < SLA) c1.rescued = true;
  // C2 — variance drives the tail
  if (!c2.hiTail && s.varianceOn && p99 >= VAR_TAIL_MULT * Math.max(1, p50)) c2.hiTail = true;
  if (c2.hiTail && !c2.loTail && !s.varianceOn && p99 < LO_TAIL_MULT * Math.max(1, p50)) c2.loTail = true;
  // C3 — tail-latency amplification
  if (!c3.amplified && s.fanout >= FANOUT_MIN && p50 >= AMPLIFY * bp95 && bp95 > 0) c3.amplified = true;
  return { c1, c2, c3 };
}
