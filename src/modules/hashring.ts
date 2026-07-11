import type { NodeId } from '../engine/events';
import { fnv1a } from '../engine/hash';
import type { Effect, InspectorTree, ModuleEvent, SimModule } from '../engine/module';

/**
 * Consistent-hash ring with virtual nodes (DDIA Ch6). Positions come from the
 * engine's fnv1a — pure and deterministic; no RNG, no wall clock.
 */
export interface RingVnode {
  pos: number;
  node: NodeId;
}

/** All vnode positions for a membership, sorted clockwise. Ties break by node id. */
export function buildRing(members: NodeId[], vnodes: number): RingVnode[] {
  const ring: RingVnode[] = [];
  for (const node of members)
    for (let i = 0; i < vnodes; i++) ring.push({ pos: fnv1a(`${node}#${i}`), node });
  ring.sort((a, b) => a.pos - b.pos || (a.node < b.node ? -1 : 1));
  return ring;
}

export function keyPos(key: string): number {
  return fnv1a(key);
}

/** Owner = first vnode clockwise from the key's position, wrapping at 2^32. Ring must be non-empty. */
export function ownerOf(ring: RingVnode[], key: string): NodeId {
  const pos = keyPos(key);
  for (const v of ring) if (v.pos >= pos) return v.node;
  return ring[0].node;
}

export function ringOwner(key: string, members: NodeId[], vnodes: number): NodeId {
  return ownerOf(buildRing(members, vnodes), key);
}

/** The naive `hash mod N` scheme the headline readout compares against. Members must be sorted. */
export function modNOwner(key: string, members: NodeId[]): NodeId {
  return members[keyPos(key) % members.length];
}

/** How many of `keys` a mod-N scheme would re-home going from one membership to another. */
export function modNMovedCount(keys: string[], from: NodeId[], to: NodeId[]): number {
  let n = 0;
  for (const k of keys) if (modNOwner(k, from) !== modNOwner(k, to)) n++;
  return n;
}

export interface HRState {
  self: NodeId;
  pool: NodeId[];
  /** Current ring membership — sorted; a shared view updated by membership broadcasts. */
  members: NodeId[];
  changeSeq: number;
  vnodes: number;
  /** Keys this node stores. */
  keys: string[];
  /** Cumulative keys this node has handed off over the session. */
  moved: number;
  /** Keys this node handed off during changeSeq (resets each change). */
  movedInChange: number;
}

export type HRPayload =
  | { cmd: 'put'; key: string }
  | { cmd: 'addNode'; node: NodeId }
  | { cmd: 'removeNode'; node: NodeId }
  | { msg: 'store'; key: string }
  | { msg: 'handoff'; keys: string[] }
  | { msg: 'membership'; members: NodeId[]; seq: number }
  | null;

/** The exact shape inspect() publishes — the lab casts NodeView.inspect to this. */
export interface HRInspect {
  inRing: boolean;
  keys: string[];
  members: NodeId[];
  changeSeq: number;
  moved: number;
}

function storeKey(s: HRState, key: string): HRState {
  return s.keys.includes(key) ? s : { ...s, keys: [...s.keys, key] };
}

function handleClient(s: HRState, ev: ModuleEvent<HRPayload>): [HRState, Effect[]] {
  const p = ev.payload as Extract<HRPayload, { cmd: string }>;
  if (p.cmd === 'put') {
    const owner = ringOwner(p.key, s.members, s.vnodes);
    if (owner === s.self) return [storeKey(s, p.key), []];
    return [s, [{ type: 'send', to: owner, payload: { msg: 'store', key: p.key } }]];
  }
  return [s, []]; // addNode/removeNode arrive in Task 3
}

function handleMessage(s: HRState, ev: ModuleEvent<HRPayload>): [HRState, Effect[]] {
  const p = ev.payload as Extract<HRPayload, { msg: string }>;
  switch (p.msg) {
    case 'store':
      return [storeKey(s, p.key), []];
    case 'handoff':
      return [p.keys.reduce(storeKey, s), []];
    case 'membership':
      return [s, []]; // Task 3
  }
}

export const hashring: SimModule<HRState, HRPayload> = {
  id: 'hash-ring',
  chaos: ['kill-node', 'partition', 'delay', 'drop', 'duplicate'],

  init(nodeId, config) {
    const pool = [...config.nodeIds].sort();
    const params = (config.params ?? {}) as { vnodes?: number; initialMembers?: number };
    return {
      self: nodeId,
      pool,
      members: pool.slice(0, params.initialMembers ?? 3),
      changeSeq: 0,
      vnodes: params.vnodes ?? 2,
      keys: [],
      moved: 0,
      movedInChange: 0,
    };
  },

  reduce(state, event): [HRState, Effect[]] {
    const p = event.payload;
    if (event.kind === 'external' && p && 'cmd' in p) return handleClient(state, event);
    if (event.kind === 'message' && p && 'msg' in p) return handleMessage(state, event);
    return [state, []];
  },

  metrics() {
    return []; // Task 4
  },

  inspect(state) {
    return {
      inRing: state.members.includes(state.self),
      keys: state.keys,
      members: state.members,
      changeSeq: state.changeSeq,
      moved: state.moved,
    } satisfies HRInspect as unknown as InspectorTree;
  },
};
