import { describe, expect, test } from 'vitest';
import { Simulation, type NodeId } from '../engine';
import { fnv1a } from '../engine/hash';
import {
  buildRing,
  hashring,
  keyPos,
  latestView,
  modNMovedCount,
  modNOwner,
  movedInLatestChange,
  ownerOf,
  ringOwner,
  type HRPayload,
  type HRState,
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

const POOL = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

function makeSim(seed: number, params: { vnodes?: number; initialMembers?: number } = {}) {
  return new Simulation<HRState, HRPayload>({
    module: hashring,
    config: { nodeIds: POOL, params },
    seed,
    network: { latency: [1, 40] },
  });
}

export function statesOf(sim: Simulation<HRState, HRPayload>): Map<NodeId, HRState> {
  return new Map(POOL.map((id) => [id, sim.getState(id)] as const));
}

describe('put routing', () => {
  test('init: members = first 3 of sorted pool, empty keys', () => {
    const sim = makeSim(1);
    sim.runSteps(POOL.length);
    const s = sim.getState('A');
    expect(s.members).toEqual(['A', 'B', 'C']);
    expect(s.keys).toEqual([]);
    expect(s.vnodes).toBe(2);
  });

  test('put stores the key at its ring owner, nowhere else', () => {
    const sim = makeSim(2);
    sim.runSteps(POOL.length);
    sim.external('A', { cmd: 'put', key: 'k1' });
    sim.runUntil(1000);
    const owner = ringOwner('k1', ['A', 'B', 'C'], 2);
    for (const id of POOL) {
      expect(sim.getState(id).keys.includes('k1')).toBe(id === owner);
    }
  });

  test('coordinating from an out-of-ring pool node still routes to a member', () => {
    const sim = makeSim(3);
    sim.runSteps(POOL.length);
    sim.external('H', { cmd: 'put', key: 'k2' }); // H is not a member
    sim.runUntil(1000);
    const owner = ringOwner('k2', ['A', 'B', 'C'], 2);
    expect(sim.getState(owner).keys).toContain('k2');
  });

  test('duplicate put of the same key stores it once', () => {
    const sim = makeSim(4);
    sim.runSteps(POOL.length);
    sim.external('A', { cmd: 'put', key: 'k3' });
    sim.external('B', { cmd: 'put', key: 'k3' });
    sim.runUntil(1000);
    const total = POOL.reduce((n, id) => n + sim.getState(id).keys.filter((k) => k === 'k3').length, 0);
    expect(total).toBe(1);
  });
});

/** Every key stored anywhere in the pool, with its holder. */
function placement(sim: Simulation<HRState, HRPayload>): Map<string, NodeId> {
  const map = new Map<string, NodeId>();
  for (const id of POOL) for (const k of sim.getState(id).keys) map.set(k, id);
  return map;
}

function putKeys(sim: Simulation<HRState, HRPayload>, n: number, until: number) {
  for (let i = 0; i < n; i++) sim.external('A', { cmd: 'put', key: `k${i}` });
  sim.runUntil(until);
}

describe('membership', () => {
  test('addNode migrates only keys owned by the new node; counters track the move', () => {
    const sim = makeSim(10);
    sim.runSteps(POOL.length);
    putKeys(sim, 24, 2000);
    const before = placement(sim);
    sim.external('A', { cmd: 'addNode', node: 'D' });
    sim.runUntil(4000);
    const after = placement(sim);
    expect(after.size).toBe(24); // conservation
    let migrated = 0;
    for (const [k, holder] of after) {
      if (before.get(k) !== holder) {
        expect(holder).toBe('D'); // minimal migration
        migrated++;
      }
    }
    const states = statesOf(sim);
    expect(latestView(states).members).toEqual(['A', 'B', 'C', 'D']);
    expect(movedInLatestChange(states)).toBe(migrated);
    expect(migrated).toBeGreaterThan(0);
  });

  test('removeNode drains the removed node; its keys land on ring successors', () => {
    const sim = makeSim(11);
    sim.runSteps(POOL.length);
    putKeys(sim, 24, 2000);
    sim.external('A', { cmd: 'removeNode', node: 'B' });
    sim.runUntil(4000);
    expect(sim.getState('B').keys).toEqual([]);
    const after = placement(sim);
    expect(after.size).toBe(24);
    for (const [k, holder] of after) {
      expect(holder).toBe(ringOwner(k, ['A', 'C'], 2));
    }
  });

  test('guards: add existing / add non-pool / remove non-member / remove last are no-ops', () => {
    const sim = makeSim(12);
    sim.runSteps(POOL.length);
    sim.external('A', { cmd: 'addNode', node: 'A' });
    sim.external('A', { cmd: 'addNode', node: 'Z' });
    sim.external('A', { cmd: 'removeNode', node: 'H' });
    sim.runUntil(1000);
    expect(latestView(statesOf(sim)).members).toEqual(['A', 'B', 'C']);
    sim.external('A', { cmd: 'removeNode', node: 'B' });
    sim.external('A', { cmd: 'removeNode', node: 'C' });
    sim.runUntil(2000);
    expect(latestView(statesOf(sim)).members).toEqual(['A']);
    sim.external('A', { cmd: 'removeNode', node: 'A' }); // last member — refused
    sim.runUntil(3000);
    expect(latestView(statesOf(sim)).members).toEqual(['A']);
  });

  test('stale membership broadcast (duplicate chaos) is ignored', () => {
    const sim = makeSim(13);
    sim.runSteps(POOL.length);
    sim.external('A', { cmd: 'addNode', node: 'D' });
    sim.runUntil(2000);
    const s = sim.getState('B');
    const [next] = hashring.reduce(
      s,
      { kind: 'message', self: 'B', from: 'A', time: 2001, payload: { msg: 'membership', members: ['A', 'B', 'C'], seq: s.changeSeq } },
      // rng unused by this module
      undefined as never,
    );
    expect(next.members).toEqual(s.members);
  });
});
