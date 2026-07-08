import type { NodeId } from './events';
import type { SeededRng } from './rng';

export interface NetworkOptions {
  /** [min, max] uniform latency in virtual ms (inclusive). */
  latency: [min: number, max: number];
  /** Probability 0..1 that a message is silently dropped. */
  dropRate: number;
  /** Probability 0..1 that a message is delivered twice. */
  duplicateRate: number;
}

export interface Delivery {
  delay: number;
}

export interface NetworkSnapshot {
  opts: NetworkOptions;
  groups: NodeId[][] | null;
}

/**
 * Decides the fate of each send: latency, drop, duplication, partitions.
 * Reordering emerges naturally from random per-message latency.
 */
export class SimNetwork {
  opts: NetworkOptions;
  private groups: NodeId[][] | null = null;

  constructor(opts?: Partial<NetworkOptions>) {
    this.opts = structuredClone({ latency: [1, 10], dropRate: 0, duplicateRate: 0, ...opts });
  }

  partition(groups: NodeId[][]): void {
    this.groups = structuredClone(groups);
  }

  heal(): void {
    this.groups = null;
  }

  canReach(from: NodeId, to: NodeId): boolean {
    if (!this.groups) return true;
    const gf = this.groups.find((grp) => grp.includes(from));
    const gt = this.groups.find((grp) => grp.includes(to));
    // Unlisted nodes are not subject to the partition — reachable by all.
    if (gf === undefined || gt === undefined) return true;
    return gf.includes(to);
  }

  /** [] = dropped/partitioned; 1 entry = normal; 2 entries = duplicated. */
  plan(from: NodeId, to: NodeId, rng: SeededRng): Delivery[] {
    if (!this.canReach(from, to)) return [];
    if (rng.next() < this.opts.dropRate) return [];
    const [min, max] = this.opts.latency;
    const out: Delivery[] = [{ delay: rng.int(min, max + 1) }];
    if (rng.next() < this.opts.duplicateRate) out.push({ delay: rng.int(min, max + 1) });
    return out;
  }

  snapshot(): NetworkSnapshot {
    return structuredClone({ opts: this.opts, groups: this.groups });
  }

  restore(s: NetworkSnapshot): void {
    const c = structuredClone(s);
    this.opts = c.opts;
    this.groups = c.groups;
  }
}
