// Wing–Gong style linearizability check for a single integer register (initial 0).
// Search over linearization orders consistent with real-time precedence, memoized
// on (chosen-set bitmask, register value). Exponential in general — hence the cap.
import { CHECK_CAP } from './raft-shared';

export interface CompletedOp {
  op: 'write' | 'read';
  value: number;
  invokedAt: number;
  respondedAt: number;
}

export type Verdict = { verdict: 'ok' } | { verdict: 'violation'; culprit: number } | { verdict: 'too-long' };

export function checkLinearizable(ops: CompletedOp[]): Verdict {
  if (ops.length > CHECK_CAP) return { verdict: 'too-long' };
  const n = ops.length;
  if (n === 0) return { verdict: 'ok' };
  // precedes[j] = bitmask of ops that must be linearized before op j
  const precedes: number[] = ops.map((oj) => {
    let mask = 0;
    for (let i = 0; i < n; i++) if (ops[i].respondedAt < oj.invokedAt) mask |= 1 << i;
    return mask;
  });
  const full = (1 << n) - 1;
  const seen = new Set<string>();
  // track the deepest frontier for culprit reporting
  let bestMask = 0;
  const dfs = (mask: number, reg: number): boolean => {
    if (mask === full) return true;
    const key = `${mask}:${reg}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (popcount(mask) > popcount(bestMask)) bestMask = mask;
    for (let j = 0; j < n; j++) {
      if (mask & (1 << j)) continue;
      if ((precedes[j] & mask) !== precedes[j]) continue; // a predecessor not yet seated
      const o = ops[j];
      if (o.op === 'read') {
        if (o.value !== reg) continue; // cannot seat this read now
        if (dfs(mask | (1 << j), reg)) return true;
      } else {
        if (dfs(mask | (1 << j), o.value)) return true;
      }
    }
    return false;
  };
  if (dfs(0, 0)) return { verdict: 'ok' };
  // culprit: the smallest-indexed op not seated in the deepest reachable frontier
  for (let j = 0; j < n; j++) if (!(bestMask & (1 << j))) return { verdict: 'violation', culprit: j };
  return { verdict: 'violation', culprit: n - 1 };
}

function popcount(x: number): number {
  let c = 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
}
