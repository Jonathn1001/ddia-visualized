// src/modules/raft.property.test.ts
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { Simulation } from '../engine';
import { checkLinearizable } from './linearizable';
import { completedOps, mergedHistory, raft, type RaftState } from './raft';
import { RAFT_NODES, type RaftPayload } from './raft-shared';

type Cmd =
  | { at: number; kill: string }
  | { at: number; revive: string }
  | { at: number; split: number } // partition: first `split` nodes vs the rest
  | { at: number; heal: true }
  | { at: number; writeAt: string; value: number };

const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
  fc.record({ at: fc.integer({ min: 0, max: 2000 }), kill: fc.constantFrom(...RAFT_NODES) }),
  fc.record({ at: fc.integer({ min: 0, max: 2000 }), revive: fc.constantFrom(...RAFT_NODES) }),
  fc.record({ at: fc.integer({ min: 0, max: 2000 }), split: fc.integer({ min: 1, max: 4 }) }),
  fc.record({ at: fc.integer({ min: 0, max: 2000 }), heal: fc.constant(true as const) }),
  fc.record({
    at: fc.integer({ min: 0, max: 2000 }),
    writeAt: fc.constantFrom(...RAFT_NODES),
    value: fc.integer({ min: 1, max: 99 }),
  }),
);

const script = fc.array(cmdArb, { minLength: 1, maxLength: 8 });

function run(cmds: Cmd[], seed: number) {
  const sim = new Simulation<RaftState, RaftPayload>({ module: raft, config: { nodeIds: RAFT_NODES }, seed });
  sim.runSteps(RAFT_NODES.length);
  const leadersByTerm = new Map<number, Set<string>>();
  const dead = new Set<string>();
  const snap = () => {
    for (const n of RAFT_NODES) {
      const s = sim.getState(n);
      if (s.role === 'leader') {
        const set = leadersByTerm.get(s.term) ?? new Set<string>();
        set.add(n);
        leadersByTerm.set(s.term, set);
      }
    }
  };
  const ordered = [...cmds].sort((a, b) => a.at - b.at);
  for (const c of ordered) {
    while (sim.time < c.at && sim.pending > 0) {
      sim.runSteps(1);
      snap();
    }
    if ('kill' in c && !dead.has(c.kill)) {
      sim.control({ type: 'kill', node: c.kill });
      dead.add(c.kill);
    } else if ('revive' in c && dead.has(c.revive)) {
      sim.control({ type: 'revive', node: c.revive });
      dead.delete(c.revive);
    } else if ('split' in c) {
      sim.control({ type: 'partition', groups: [RAFT_NODES.slice(0, c.split), RAFT_NODES.slice(c.split)] });
    } else if ('heal' in c) {
      sim.control({ type: 'heal' });
    } else if ('writeAt' in c) {
      sim.external(c.writeAt, { cmd: 'write', value: c.value });
    }
  }
  sim.control({ type: 'heal' });
  for (const n of [...dead]) sim.control({ type: 'revive', node: n });
  for (let i = 0; i < 30000 && sim.pending > 0; i++) {
    sim.runSteps(1);
    snap();
  }
  const states = new Map(RAFT_NODES.map((n) => [n, sim.getState(n)] as const));
  return { states, leadersByTerm };
}

test('election safety: at most one leader per term, ever', () => {
  fc.assert(
    fc.property(script, fc.integer({ min: 1, max: 500 }), (cmds, s) => {
      const { leadersByTerm } = run(cmds, 9100 + s);
      for (const [, set] of leadersByTerm) expect(set.size).toBe(1);
    }),
    { numRuns: 15 },
  );
});

test('log matching: same index + same term → same entry', () => {
  fc.assert(
    fc.property(script, fc.integer({ min: 1, max: 500 }), (cmds, s) => {
      const { states } = run(cmds, 9200 + s);
      const all = [...states.values()];
      for (const a of all) {
        for (const b of all) {
          for (let i = 0; i < Math.min(a.log.length, b.log.length); i++) {
            if (a.log[i].term === b.log[i].term) expect(a.log[i].seq).toBe(b.log[i].seq);
          }
        }
      }
    }),
    { numRuns: 15 },
  );
});

test('state machine safety: applied prefixes never diverge', () => {
  fc.assert(
    fc.property(script, fc.integer({ min: 1, max: 500 }), (cmds, s) => {
      const { states } = run(cmds, 9300 + s);
      const all = [...states.values()];
      for (const a of all) {
        for (const b of all) {
          const shared = Math.min(a.commitIndex, b.commitIndex);
          for (let i = 0; i < shared; i++) expect(a.log[i].seq).toBe(b.log[i].seq);
        }
      }
    }),
    { numRuns: 15 },
  );
});

test('determinism: same script + seed → identical states', () => {
  fc.assert(
    fc.property(script, (cmds) => {
      const a = run(cmds, 9400);
      const b = run(cmds, 9400);
      for (const n of RAFT_NODES) {
        expect(JSON.stringify(a.states.get(n))).toBe(JSON.stringify(b.states.get(n)));
      }
    }),
    { numRuns: 8 },
  );
});

test('writes-only histories (no reads) are always linearizable', () => {
  fc.assert(
    fc.property(script, fc.integer({ min: 1, max: 500 }), (cmds, s) => {
      const { states } = run(cmds, 9500 + s);
      const ops = completedOps(mergedHistory(states));
      if (ops.length <= 12) expect(checkLinearizable(ops).verdict).not.toBe('violation');
    }),
    { numRuns: 15 },
  );
});

test('checker vs brute force on tiny random histories', () => {
  const opArb = fc.record({
    op: fc.constantFrom<'write' | 'read'>('write', 'read'),
    value: fc.integer({ min: 0, max: 3 }),
    start: fc.integer({ min: 0, max: 40 }),
    len: fc.integer({ min: 1, max: 20 }),
  });
  const bruteForce = (ops: { op: 'write' | 'read'; value: number; invokedAt: number; respondedAt: number }[]): boolean => {
    const n = ops.length;
    const idx = [...Array(n).keys()];
    const perms = (arr: number[]): number[][] => (arr.length <= 1 ? [arr] : arr.flatMap((x, i) => perms([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [x, ...p])));
    outer: for (const p of perms(idx)) {
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          if (ops[p[j]].respondedAt < ops[p[i]].invokedAt) continue outer; // real-time violated
        }
      }
      let reg = 0;
      let ok = true;
      for (const k of p) {
        if (ops[k].op === 'write') reg = ops[k].value;
        else if (ops[k].value !== reg) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  };
  fc.assert(
    fc.property(fc.array(opArb, { minLength: 1, maxLength: 5 }), (raw) => {
      const ops = raw.map((o) => ({ op: o.op, value: o.value, invokedAt: o.start, respondedAt: o.start + o.len }));
      const fast = checkLinearizable(ops).verdict === 'ok';
      expect(fast).toBe(bruteForce(ops));
    }),
    { numRuns: 200 },
  );
});
