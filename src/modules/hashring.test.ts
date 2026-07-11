import { describe, expect, test } from 'vitest';
import { fnv1a } from '../engine/hash';
import {
  buildRing,
  keyPos,
  modNMovedCount,
  modNOwner,
  ownerOf,
  ringOwner,
} from './hashring';

describe('ring math', () => {
  test('buildRing: members × vnodes entries, sorted by position', () => {
    const ring = buildRing(['A', 'B', 'C'], 4);
    expect(ring).toHaveLength(12);
    for (let i = 1; i < ring.length; i++) expect(ring[i].pos).toBeGreaterThanOrEqual(ring[i - 1].pos);
    expect(ring.filter((v) => v.node === 'A')).toHaveLength(4);
  });

  test('vnode positions derive from fnv1a of `${node}#${i}`', () => {
    const ring = buildRing(['A'], 2);
    expect(ring.map((v) => v.pos).sort((a, b) => a - b)).toEqual(
      [fnv1a('A#0'), fnv1a('A#1')].sort((a, b) => a - b),
    );
  });

  test('ownerOf: first vnode clockwise from the key, wrapping at 2^32', () => {
    const ring = buildRing(['A', 'B', 'C'], 1);
    const key = 'wrap-probe';
    const pos = keyPos(key);
    const successor = ring.find((v) => v.pos >= pos) ?? ring[0];
    expect(ownerOf(ring, key)).toBe(successor.node);
    // wrap case: a key positioned past the last vnode maps to ring[0]
    const last = ring[ring.length - 1];
    for (let i = 0; i < 5000; i++) {
      const k = `w${i}`;
      if (keyPos(k) > last.pos) {
        expect(ownerOf(ring, k)).toBe(ring[0].node);
        return;
      }
    }
    throw new Error('no wrap-around key found in 5000 candidates — widen the search');
  });

  test('ringOwner is deterministic and always a member', () => {
    for (const k of ['x', 'y', 'k42']) {
      const owner = ringOwner(k, ['A', 'B', 'C', 'D'], 3);
      expect(ringOwner(k, ['A', 'B', 'C', 'D'], 3)).toBe(owner);
      expect(['A', 'B', 'C', 'D']).toContain(owner);
    }
  });

  test('modNOwner: sorted-members index by fnv1a(key) % N', () => {
    const members = ['A', 'B', 'C'];
    expect(modNOwner('k1', members)).toBe(members[fnv1a('k1') % 3]);
  });

  test('consistent hashing moves fewer keys than mod-N on a membership change', () => {
    const keys = Array.from({ length: 100 }, (_, i) => `k${i}`);
    const from = ['A', 'B', 'C', 'D'];
    const to = ['A', 'B', 'C', 'D', 'E'];
    const ringMoved = keys.filter((k) => ringOwner(k, from, 4) !== ringOwner(k, to, 4)).length;
    const modMoved = modNMovedCount(keys, from, to);
    expect(ringMoved).toBeGreaterThan(0);
    expect(ringMoved).toBeLessThan(modMoved);
    // every ring-moved key lands on the added node
    for (const k of keys) {
      const now = ringOwner(k, to, 4);
      if (now !== ringOwner(k, from, 4)) expect(now).toBe('E');
    }
  });
});
