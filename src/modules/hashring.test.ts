import { describe, expect, test } from 'vitest';
import { Simulation, type NodeId } from '../engine';
import {
  buildRing,
  detectHotspot,
  hashring,
  HOTSPOT_MIN_KEYS,
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

  test('vnode positions derive from keyPos of `${node}#${i}`', () => {
    const ring = buildRing(['A'], 2);
    expect(ring.map((v) => v.pos).sort((a, b) => a - b)).toEqual(
      [keyPos('A#0'), keyPos('A#1')].sort((a, b) => a - b),
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

  test('modNOwner: sorted-members index by keyPos(key) % N', () => {
    const members = ['A', 'B', 'C'];
    expect(modNOwner('k1', members)).toBe(members[keyPos('k1') % 3]);
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

  test('default lab scenario: ring moves far fewer keys than mod-N (pins the avalanche finalizer)', () => {
    // The lab's opening move: 24 sequential keys, ABC -> ABCD at V=2. With raw
    // fnv1a (no mix32) this inverts to ring 20 vs mod-N 18 — the finalizer is
    // what makes the lesson true for the keys a learner actually creates.
    const keys = Array.from({ length: 24 }, (_, i) => `k${i}`);
    const from = ['A', 'B', 'C'];
    const to = ['A', 'B', 'C', 'D'];
    const ringMoved = keys.filter((k) => ringOwner(k, from, 2) !== ringOwner(k, to, 2)).length;
    const modMoved = modNMovedCount(keys, from, to);
    expect(ringMoved).toBeLessThan(modMoved / 2);
  });

  test('sequential key positions disperse across the ring (pins mix32 diffusion)', () => {
    // Raw fnv1a puts k0..k19 in a ~7%-wide band; mixed positions span most of
    // the circle. Guard the spread so weak diffusion cannot silently return.
    const positions = Array.from({ length: 20 }, (_, i) => keyPos(`k${i}`));
    const span = (Math.max(...positions) - Math.min(...positions)) / 0x100000000;
    expect(span).toBeGreaterThan(0.5);
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

describe('hotspot + metrics', () => {
  test('no hotspot below the minimum key volume', () => {
    const sim = makeSim(20);
    sim.runSteps(POOL.length);
    putKeys(sim, HOTSPOT_MIN_KEYS - 1, 2000);
    expect(detectHotspot(statesOf(sim))).toBeNull();
  });

  test('hotspot fires when one member holds ≥ 2× fair share', () => {
    const sim = makeSim(21);
    sim.runSteps(POOL.length);
    // Hand-build the skew: reduce() is pure, so feed a member state directly.
    const s = sim.getState('A');
    const skewed: HRState = { ...s, keys: Array.from({ length: 20 }, (_, i) => `s${i}`) };
    const states = statesOf(sim);
    states.set('A', skewed);
    const hit = detectHotspot(states);
    expect(hit).not.toBeNull();
    expect(hit!.node).toBe('A');
    expect(hit!.load).toBe(20);
    expect(hit!.load).toBeGreaterThanOrEqual(2 * hit!.fairShare);
  });

  test('metrics report ratio, cumulative moved, member count, V', () => {
    const sim = makeSim(22);
    sim.runSteps(POOL.length);
    putKeys(sim, 24, 2000);
    sim.external('A', { cmd: 'addNode', node: 'D' });
    sim.runUntil(4000);
    const m = Object.fromEntries(hashring.metrics(statesOf(sim), 4000).map((x) => [x.name, x.value]));
    expect(m['ring-nodes']).toBe(4);
    expect(m['vnodes']).toBe(2);
    expect(m['keys-moved']).toBeGreaterThan(0);
    expect(m['max-load-ratio']).toBeGreaterThanOrEqual(1);
  });

  test('the documented challenge recipe reaches a hotspot', () => {
    // Recipe: V=1, grow to the full pool, put 48 keys, then repeatedly remove
    // the ring-predecessor of the max-load member so it inherits that arc.
    const sim = makeSim(23, { vnodes: 1 });
    sim.runSteps(POOL.length);
    let t = 0;
    for (const n of ['D', 'E', 'F', 'G', 'H']) {
      sim.external('A', { cmd: 'addNode', node: n });
      t += 500;
      sim.runUntil(t);
    }
    for (let i = 0; i < 48; i++) sim.external('A', { cmd: 'put', key: `k${i}` });
    t += 1500;
    sim.runUntil(t);
    for (let round = 0; round < 5 && !detectHotspot(statesOf(sim)); round++) {
      const view = latestView(statesOf(sim));
      const ring = buildRing(view.members, 1);
      const loads = view.members.map((m) => ({ m, load: sim.getState(m).keys.length }));
      const max = loads.reduce((a, b) => (b.load > a.load ? b : a)).m;
      const i = ring.findIndex((v) => v.node === max);
      const victim = ring[(i - 1 + ring.length) % ring.length].node;
      sim.external('A', { cmd: 'removeNode', node: victim });
      t += 1000;
      sim.runUntil(t);
    }
    expect(detectHotspot(statesOf(sim))).not.toBeNull();
  });
});
