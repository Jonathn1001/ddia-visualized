import type { NodeId } from '../engine/events';
import type { Effect, ModuleConfig, ModuleEvent } from '../engine/module';
import {
  BTREE, BTREE_ORDER, BYTES_PER_ENTRY, DEFAULT_DISK_CAP,
  isFault, isOp, type Counters, type StoragePayload,
} from './storage-shared';

export interface Page {
  id: string;
  leaf: boolean;
  keys: string[];
  vals: (string | null)[]; // leaf values (null = deleted); empty on index pages
  children: string[]; // index child ids; empty on leaves
}
export interface RedoRec {
  seq: number;
  key: string;
  val: string | null;
}

export interface BtreeState extends Counters {
  engine: 'btree';
  self: NodeId;
  pages: Record<string, Page>;
  rootId: string;
  height: number;
  nextPage: number;
  wal: RedoRec[];
  walAckSeq: number;
  phase: 'idle' | 'splitting' | 'recovering';
  lastReadCost: number;
  diskCap: number;
  diskFull: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- config is unused until a later task adds config-driven params
export function btreeInit(_config: ModuleConfig): BtreeState {
  const root: Page = { id: 'p0', leaf: true, keys: [], vals: [], children: [] };
  return {
    engine: 'btree',
    self: BTREE,
    pages: { p0: root },
    rootId: 'p0',
    height: 1,
    nextPage: 1,
    wal: [],
    walAckSeq: 0,
    phase: 'idle',
    diskReads: 0,
    diskWrites: 0,
    bytesWritten: 0,
    userBytes: 0,
    lastReadCost: 0,
    diskCap: DEFAULT_DISK_CAP,
    diskFull: false,
  };
}

/** Descend from root to the leaf that owns `key`, returning the leaf id. Counts reads. */
function findLeaf(s: BtreeState, key: string): { leafId: string; reads: number } {
  let pid = s.rootId;
  let reads = 1;
  while (!s.pages[pid].leaf) {
    const idx = s.pages[pid];
    let child = idx.children[0];
    for (let i = 0; i < idx.keys.length; i++) if (key >= idx.keys[i]) child = idx.children[i + 1];
    pid = child;
    reads++;
  }
  return { leafId: pid, reads };
}

export function btreeGet(s: BtreeState, key: string): { state: BtreeState; value: string | undefined } {
  const { leafId, reads } = findLeaf(s, key);
  const leaf = s.pages[leafId];
  const i = leaf.keys.indexOf(key);
  const val = i >= 0 ? leaf.vals[i] : null;
  return { state: { ...s, lastReadCost: reads, diskReads: s.diskReads + reads }, value: val ?? undefined };
}

/** Insert key/val into a sorted leaf, returning a new page. */
function leafInsert(leaf: Page, key: string, val: string | null): Page {
  const keys = [...leaf.keys];
  const vals = [...leaf.vals];
  const at = keys.indexOf(key);
  if (at >= 0) {
    vals[at] = val;
  } else {
    let i = 0;
    while (i < keys.length && keys[i] < key) i++;
    keys.splice(i, 0, key);
    vals.splice(i, 0, val);
  }
  return { ...leaf, keys, vals };
}

function applyWrite(s: BtreeState, key: string, val: string | null): BtreeState {
  const seq = s.walAckSeq + 1;
  const base: BtreeState = {
    ...s,
    wal: [...s.wal, { seq, key, val }],
    walAckSeq: seq,
    diskWrites: s.diskWrites + 1,
    bytesWritten: s.bytesWritten + BYTES_PER_ENTRY,
    userBytes: s.userBytes + BYTES_PER_ENTRY,
  };
  const { leafId } = findLeaf(base, key);
  const leaf = leafInsert(base.pages[leafId], key, val);
  const pages = { ...base.pages, [leafId]: leaf };
  const withLeaf: BtreeState = { ...base, pages, bytesWritten: base.bytesWritten + BYTES_PER_ENTRY };
  return leaf.keys.length > BTREE_ORDER ? splitLeaf(withLeaf, leafId) : withLeaf;
}

/** Split an overflowing leaf; lift the separator into (or create) the root index. */
function splitLeaf(s: BtreeState, leafId: string): BtreeState {
  if (s.diskFull) return s; // no space to allocate a new page → split rejected
  const leaf = s.pages[leafId];
  const mid = Math.floor(leaf.keys.length / 2);
  const rightId = `p${s.nextPage}`;
  const left: Page = { ...leaf, keys: leaf.keys.slice(0, mid), vals: leaf.vals.slice(0, mid) };
  const right: Page = { id: rightId, leaf: true, keys: leaf.keys.slice(mid), vals: leaf.vals.slice(mid), children: [] };
  const separator = right.keys[0];
  const pages = { ...s.pages, [leafId]: left, [rightId]: right };

  if (s.rootId === leafId) {
    // leaf was the root → make a new index root
    const newRootId = `p${s.nextPage + 1}`;
    pages[newRootId] = { id: newRootId, leaf: false, keys: [separator], vals: [], children: [leafId, rightId] };
    return {
      ...s,
      pages,
      rootId: newRootId,
      height: 2,
      nextPage: s.nextPage + 2,
      diskWrites: s.diskWrites + 2,
      bytesWritten: s.bytesWritten + 2 * BYTES_PER_ENTRY,
      phase: 'idle',
    };
  }
  // insert separator into existing root index (bounded: assume single index level)
  const root = pages[s.rootId];
  const childIdx = root.children.indexOf(leafId);
  const keys = [...root.keys];
  const children = [...root.children];
  keys.splice(childIdx, 0, separator);
  children.splice(childIdx + 1, 0, rightId);
  pages[s.rootId] = { ...root, keys, children };
  return {
    ...s,
    pages,
    nextPage: s.nextPage + 1,
    diskWrites: s.diskWrites + 2,
    bytesWritten: s.bytesWritten + 2 * BYTES_PER_ENTRY,
    phase: 'idle',
  };
}

export function btreeReduce(state: BtreeState, event: ModuleEvent<StoragePayload>): [BtreeState, Effect[]] {
  const p = event.payload;
  if (isFault(p)) return [applyFault(state, p.fault), []];
  if (isOp(p)) {
    if (p.op === 'get') return [btreeGet(state, p.key).state, []];
    if (p.op === 'put') return [applyWrite(state, p.key, p.val), []];
    if (p.op === 'delete') return [applyWrite(state, p.key, null), []];
  }
  return [state, []];
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- fault handling is implemented in Task 8; this is an intentional stub
function applyFault(s: BtreeState, f: string): BtreeState {
  return s; // implemented in Task 8
}

export interface BtreeInspect {
  engine: 'btree';
  pages: Page[];
  rootId: string;
  height: number;
  walLen: number;
  phase: BtreeState['phase'];
  diskReads: number;
  diskWrites: number;
  bytesWritten: number;
  userBytes: number;
  lastReadCost: number;
  diskFull: boolean;
}

export function btreeInspect(s: BtreeState): BtreeInspect {
  return {
    engine: 'btree',
    pages: Object.values(s.pages),
    rootId: s.rootId,
    height: s.height,
    walLen: s.wal.length,
    phase: s.phase,
    diskReads: s.diskReads,
    diskWrites: s.diskWrites,
    bytesWritten: s.bytesWritten,
    userBytes: s.userBytes,
    lastReadCost: s.lastReadCost,
    diskFull: s.diskFull,
  };
}
