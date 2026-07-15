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

/**
 * Descend from root to the leaf that owns `key`. Returns the leaf id, the read cost
 * (pages visited = height), and the full `path` of page ids root→leaf so a split can
 * walk back up and push separators into each ancestor.
 */
function findLeaf(s: BtreeState, key: string): { leafId: string; reads: number; path: string[] } {
  let pid = s.rootId;
  const path = [pid];
  while (!s.pages[pid].leaf) {
    const idx = s.pages[pid];
    let child = idx.children[0];
    for (let i = 0; i < idx.keys.length; i++) if (key >= idx.keys[i]) child = idx.children[i + 1];
    pid = child;
    path.push(pid);
  }
  return { leafId: pid, reads: path.length, path };
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
  const { leafId, path } = findLeaf(base, key);
  const leaf = leafInsert(base.pages[leafId], key, val);
  const pages = { ...base.pages, [leafId]: leaf };
  const withLeaf: BtreeState = { ...base, pages, bytesWritten: base.bytesWritten + BYTES_PER_ENTRY };
  return leaf.keys.length > BTREE_ORDER ? splitUp(withLeaf, path) : withLeaf;
}

/**
 * Split the overflowing leaf at the end of `path`, then walk back up the ancestor chain:
 * each split lifts a separator into its parent, which may itself overflow and split. A root
 * overflow allocates a fresh index root and grows `height` by one — so the tree stays fixed-
 * fanout (no page ever exceeds `BTREE_ORDER`) and read-amp = height stays truthful at any size.
 * Leaf splits copy the separator up (it stays in the right sibling); index splits push the
 * median up (it leaves both halves), the standard B-tree distinction.
 */
function splitUp(s: BtreeState, path: string[]): BtreeState {
  if (s.diskFull) return s; // no space to allocate a new page → split rejected
  const pages = { ...s.pages };
  let nextPage = s.nextPage;
  let rootId = s.rootId;
  let height = s.height;
  let diskWrites = s.diskWrites;
  let bytesWritten = s.bytesWritten;

  for (let depth = path.length - 1; pages[path[depth]].keys.length > BTREE_ORDER; depth--) {
    const curId = path[depth];
    const node = pages[curId];
    const mid = Math.floor(node.keys.length / 2);
    const rightId = `p${nextPage++}`;
    let separator: string;
    let left: Page;
    let right: Page;
    if (node.leaf) {
      // leaf: copy-up — the separator (right's first key) also stays in the right sibling
      left = { ...node, keys: node.keys.slice(0, mid), vals: node.vals.slice(0, mid) };
      right = { id: rightId, leaf: true, keys: node.keys.slice(mid), vals: node.vals.slice(mid), children: [] };
      separator = right.keys[0];
    } else {
      // index: push-up — the median key moves to the parent, leaving neither half
      separator = node.keys[mid];
      left = { ...node, keys: node.keys.slice(0, mid), children: node.children.slice(0, mid + 1) };
      right = { id: rightId, leaf: false, keys: node.keys.slice(mid + 1), vals: [], children: node.children.slice(mid + 1) };
    }
    pages[curId] = left;
    pages[rightId] = right;
    diskWrites += 2;
    bytesWritten += 2 * BYTES_PER_ENTRY;

    if (curId === rootId) {
      // the root itself split → allocate a new index root and grow height
      const newRootId = `p${nextPage++}`;
      pages[newRootId] = { id: newRootId, leaf: false, keys: [separator], vals: [], children: [curId, rightId] };
      rootId = newRootId;
      height += 1;
      diskWrites += 1;
      bytesWritten += BYTES_PER_ENTRY;
      break;
    }
    // lift the separator into the parent (next up the path); loop re-checks it for overflow
    const parentId = path[depth - 1];
    const parent = pages[parentId];
    const childIdx = parent.children.indexOf(curId);
    const keys = [...parent.keys];
    const children = [...parent.children];
    keys.splice(childIdx, 0, separator);
    children.splice(childIdx + 1, 0, rightId);
    pages[parentId] = { ...parent, keys, children };
  }
  return { ...s, pages, nextPage, rootId, height, diskWrites, bytesWritten, phase: 'idle' };
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
