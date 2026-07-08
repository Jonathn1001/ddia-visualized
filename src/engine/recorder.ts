import type { Simulation, SimSnapshot } from './sim';

/**
 * Hybrid scrubbing (DESIGN_PLAN §5): snapshot every `interval` processed
 * events; scrubbing restores the nearest snapshot <= target and replays
 * deterministically the rest of the way.
 */
export class TimelineRecorder<S, P = unknown> {
  private snapshots: { index: number; snap: SimSnapshot }[] = [];

  constructor(
    readonly sim: Simulation<S, P>,
    private interval = 500,
  ) {
    this.snapshots.push({ index: sim.processed, snap: sim.snapshot() });
  }

  get position(): number {
    return this.sim.processed;
  }

  /** Step once, snapshotting on interval boundaries. Returns false when idle. */
  step(): boolean {
    if (!this.sim.step()) return false;
    const at = this.sim.processed;
    if (at % this.interval === 0 && !this.snapshots.some((s) => s.index === at)) {
      this.snapshots.push({ index: at, snap: this.sim.snapshot() });
    }
    return true;
  }

  runSteps(n: number): void {
    for (let i = 0; i < n; i++) if (!this.step()) break;
  }

  /** Land so that exactly `index` events have been processed. */
  scrubTo(index: number): void {
    if (index >= this.sim.processed) {
      while (this.sim.processed < index && this.step()) {
        /* forward replay */
      }
      return;
    }
    let base = this.snapshots[0];
    for (const s of this.snapshots) {
      if (s.index <= index) base = s;
      else break;
    }
    this.sim.restore(base.snap);
    while (this.sim.processed < index && this.sim.step()) {
      /* replay from snapshot */
    }
  }

  /**
   * Call after injecting external()/control() following a backward scrub —
   * the previously recorded future is no longer this timeline's future.
   */
  invalidateFuture(): void {
    this.snapshots = this.snapshots.filter((s) => s.index <= this.sim.processed);
  }
}
