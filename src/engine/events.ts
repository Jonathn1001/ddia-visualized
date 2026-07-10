export type NodeId = string;

export interface SimEvent<P = unknown> {
  /** Virtual milliseconds. */
  time: number;
  /** Global insertion counter — deterministic tie-break for equal times. */
  seq: number;
  target: NodeId;
  kind: 'init' | 'message' | 'timer' | 'external' | 'control';
  from?: NodeId;
  /** Virtual time the message was sent (kind 'message' only). */
  sentAt?: number;
  payload: P;
}

/** Binary min-heap ordered by (time, seq). */
export class EventQueue {
  private heap: SimEvent[] = [];

  get size(): number {
    return this.heap.length;
  }

  private before(a: SimEvent, b: SimEvent): boolean {
    return a.time !== b.time ? a.time < b.time : a.seq < b.seq;
  }

  push(e: SimEvent): void {
    const h = this.heap;
    h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.before(h[i], h[p])) {
        [h[i], h[p]] = [h[p], h[i]];
        i = p;
      } else break;
    }
  }

  peek(): SimEvent | undefined {
    return this.heap[0];
  }

  pop(): SimEvent | undefined {
    const h = this.heap;
    if (h.length === 0) return undefined;
    const top = h[0];
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && this.before(h[l], h[m])) m = l;
        if (r < h.length && this.before(h[r], h[m])) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m], h[i]];
        i = m;
      }
    }
    return top;
  }

  /** Raw heap array (heap order, not sorted) — for snapshots. */
  toArray(): SimEvent[] {
    return [...this.heap];
  }

  /** Restore from an array previously produced by toArray(). */
  loadFrom(events: SimEvent[]): void {
    this.heap = [...events];
  }
}
