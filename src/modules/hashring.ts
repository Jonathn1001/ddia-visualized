import type { NodeId } from '../engine/events';
import { fnv1a } from '../engine/hash';

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
