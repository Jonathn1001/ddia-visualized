import { expect, test } from 'vitest';
import { lsmInit, lsmReduce, lsmGet, bloomMightContain, type LsmState } from './lsm';
import {
  STORAGE_TOPOLOGY, LSM, MEMTABLE_CAP, L0_TRIGGER, type StoragePayload, type StorageFault,
} from './storage-shared';

const cfg = { nodeIds: STORAGE_TOPOLOGY };
const ev = (payload: StoragePayload) => ({ kind: 'external' as const, self: LSM, time: 0, payload });
const fault = (f: StorageFault['fault']) => ({ kind: 'external' as const, self: LSM, time: 0, payload: { fault: f } });

function put(s: LsmState, key: string, val: string): LsmState {
  return lsmReduce(s, ev({ op: 'put', key, val }))[0];
}

test('put then get returns the value', () => {
  let s = lsmInit(cfg);
  s = put(s, 'a', '1');
  expect(lsmGet(s, 'a').value).toBe('1');
  expect(lsmGet(s, 'missing').value).toBeUndefined();
});

test('put appends a durable WAL record and counts a disk write', () => {
  let s = lsmInit(cfg);
  s = put(s, 'a', '1');
  expect(s.wal).toHaveLength(1);
  expect(s.wal[0]).toMatchObject({ key: 'a', val: '1' });
  expect(s.diskWrites).toBe(1);
  expect(s.userBytes).toBe(16);
});

test('delete writes a tombstone; get sees the key as absent', () => {
  let s = lsmInit(cfg);
  s = put(s, 'a', '1');
  s = lsmReduce(s, ev({ op: 'delete', key: 'a' }))[0];
  expect(lsmGet(s, 'a').value).toBeUndefined();
  expect(s.memtable.find((e) => e.key === 'a')?.val).toBeNull();
});

test('put emits no send effects (local-only module)', () => {
  const [, effects] = lsmReduce(lsmInit(cfg), ev({ op: 'put', key: 'a', val: '1' }));
  expect(effects.every((e) => e.type !== 'send')).toBe(true);
});

test('memtable past cap schedules a flush; the flush-phase2 timer writes an L0 SSTable', () => {
  let s = lsmInit(cfg);
  let effects;
  for (let i = 0; i <= MEMTABLE_CAP; i++) {
    [s, effects] = lsmReduce(s, ev({ op: 'put', key: `k${i}`, val: String(i) }));
  }
  // the write that tips it over cap requests a flush
  expect(s.phase).toBe('flushing');
  expect(effects!.some((e) => e.type === 'timer')).toBe(true);
  // run the flush timer
  [s] = lsmReduce(s, { kind: 'timer', self: LSM, time: 10, payload: { timer: 'flush-phase2' } });
  expect(s.phase).toBe('idle');
  expect(s.memtable).toHaveLength(0);
  expect(s.sstables).toHaveLength(1);
  expect(s.sstables[0].level).toBe(0);
  expect(s.sstables[0].entries.length).toBe(MEMTABLE_CAP + 1);
});

test('a flushed key is still readable from its SSTable', () => {
  let s = lsmInit(cfg);
  for (let i = 0; i <= MEMTABLE_CAP; i++) s = lsmReduce(s, ev({ op: 'put', key: `k${i}`, val: String(i) }))[0];
  [s] = lsmReduce(s, { kind: 'timer', self: LSM, time: 10, payload: { timer: 'flush-phase2' } });
  expect(lsmGet(s, 'k0').value).toBe('0');
});

test('bloom filter never rejects a key that is present', () => {
  let s = lsmInit(cfg);
  for (let i = 0; i <= MEMTABLE_CAP; i++) s = lsmReduce(s, ev({ op: 'put', key: `x${i}`, val: String(i) }))[0];
  [s] = lsmReduce(s, { kind: 'timer', self: LSM, time: 10, payload: { timer: 'flush-phase2' } });
  const bloom = s.sstables[0].bloom;
  for (let i = 0; i <= MEMTABLE_CAP; i++) expect(bloomMightContain(bloom, `x${i}`)).toBe(true);
});

test('a read skips a bloom-rejected SSTable: bloomSkips increments and read-amp excludes the skip', () => {
  let s = lsmInit(cfg);
  for (let i = 0; i <= MEMTABLE_CAP; i++) s = lsmReduce(s, ev({ op: 'put', key: `x${i}`, val: String(i) }))[0];
  [s] = lsmReduce(s, { kind: 'timer', self: LSM, time: 10, payload: { timer: 'flush-phase2' } });
  expect(s.sstables).toHaveLength(1);

  const missingKey = 'zz-not-present';
  // Premise: this key is absent and the flushed SSTable's bloom provably rejects it.
  expect(bloomMightContain(s.sstables[0].bloom, missingKey)).toBe(false);

  const before = s.bloomSkips;
  const rejected = lsmGet(s, missingKey);
  expect(rejected.value).toBeUndefined();
  expect(rejected.state.bloomSkips).toBe(before + 1);
  // The only SSTable was skipped via the bloom, not scanned, so it contributes no read-amp.
  expect(rejected.state.lastReadCost).toBe(0);

  // A present-key get scans (bloom passes) but must not spuriously inflate bloomSkips.
  const present = lsmGet(rejected.state, 'x0');
  expect(present.value).toBe('0');
  expect(present.state.bloomSkips).toBe(rejected.state.bloomSkips);
  expect(present.state.lastReadCost).toBe(1);
});

function flushNow(s: LsmState): LsmState {
  // fill+flush one full memtable
  for (let i = 0; i < MEMTABLE_CAP + 1; i++) s = lsmReduce(s, ev({ op: 'put', key: `f${s.userBytes}_${i}`, val: 'v' }))[0];
  return lsmReduce(s, { kind: 'timer', self: LSM, time: 1, payload: { timer: 'flush-phase2' } })[0];
}

test('reaching L0_TRIGGER runs schedules a compaction that produces one L1 run', () => {
  let s = lsmInit(cfg);
  let lastEffects;
  for (let r = 0; r < L0_TRIGGER; r++) {
    for (let i = 0; i < MEMTABLE_CAP + 1; i++) s = lsmReduce(s, ev({ op: 'put', key: `r${r}k${i}`, val: 'v' }))[0];
    [s, lastEffects] = lsmReduce(s, { kind: 'timer', self: LSM, time: 1, payload: { timer: 'flush-phase2' } });
  }
  expect(lastEffects!.some((e) => e.type === 'timer' && (e.payload as { timer: string }).timer === 'compact')).toBe(true);
  [s] = lsmReduce(s, { kind: 'timer', self: LSM, time: 5, payload: { timer: 'compact' } });
  expect(s.sstables.filter((t) => t.level === 0)).toHaveLength(0);
  expect(s.sstables.filter((t) => t.level === 1)).toHaveLength(1);
});

test('compaction keeps the newest value for a re-written key', () => {
  let s = lsmInit(cfg);
  // write k=old, flush, then k=new in a later run, then compact
  s = lsmReduce(s, ev({ op: 'put', key: 'dup', val: 'old' }))[0];
  s = flushNow(s); // pushes an L0 run containing dup=old (+ fillers)
  s = lsmReduce(s, ev({ op: 'put', key: 'dup', val: 'new' }))[0];
  s = flushNow(s);
  s = flushNow(s); // third run tips L0_TRIGGER
  [s] = lsmReduce(s, { kind: 'timer', self: LSM, time: 9, payload: { timer: 'compact' } });
  expect(lsmGet(s, 'dup').value).toBe('new');
});

test('bytesWritten grows on compaction — this is LSM write amplification', () => {
  let s = lsmInit(cfg);
  const before = () => s.bytesWritten;
  for (let r = 0; r < L0_TRIGGER; r++) s = flushNow(s);
  const preCompact = before();
  [s] = lsmReduce(s, { kind: 'timer', self: LSM, time: 9, payload: { timer: 'compact' } });
  expect(s.bytesWritten).toBeGreaterThan(preCompact);
});

test('compaction drops a tombstone once it reaches the bottom level (L1)', () => {
  let s = lsmInit(cfg);
  s = lsmReduce(s, ev({ op: 'put', key: 'del', val: 'x' }))[0];
  s = flushNow(s); // L0 run containing del=x (+ fillers)
  s = lsmReduce(s, ev({ op: 'delete', key: 'del' }))[0];
  s = flushNow(s); // L0 run containing del=null tombstone (+ fillers)
  s = flushNow(s); // third run tips L0_TRIGGER
  [s] = lsmReduce(s, { kind: 'timer', self: LSM, time: 9, payload: { timer: 'compact' } });
  expect(lsmGet(s, 'del').value).toBeUndefined();
  expect(s.sstables[0].entries.some((e) => e.key === 'del')).toBe(false);
});

test('crash-mid-write keeps WAL-acked keys and recovers them; volatile-only work survives via WAL', () => {
  let s = lsmInit(cfg);
  s = lsmReduce(s, ev({ op: 'put', key: 'durable', val: '1' }))[0]; // acked in WAL, not yet flushed
  s = lsmReduce(s, fault('crash-mid-write'))[0];
  expect(s.phase).toBe('idle');
  expect(lsmGet(s, 'durable').value).toBe('1'); // replayed from WAL
});

test('disk-full stops compaction from running (L0 stays), still readable', () => {
  let s = lsmInit(cfg);
  s = lsmReduce(s, fault('disk-full'))[0];
  for (let r = 0; r < L0_TRIGGER; r++) {
    for (let i = 0; i < MEMTABLE_CAP + 1; i++) s = lsmReduce(s, ev({ op: 'put', key: `r${r}k${i}`, val: 'v' }))[0];
    s = lsmReduce(s, { kind: 'timer', self: LSM, time: 1, payload: { timer: 'flush-phase2' } })[0];
  }
  s = lsmReduce(s, { kind: 'timer', self: LSM, time: 9, payload: { timer: 'compact' } })[0];
  expect(s.diskFull).toBe(true);
  expect(s.sstables.filter((t) => t.level === 0).length).toBeGreaterThanOrEqual(L0_TRIGGER);
  expect(lsmGet(s, 'r0k0').value).toBe('v');
});

test('torn-write corrupts the last run but recover rebuilds it from WAL', () => {
  let s = lsmInit(cfg);
  s = lsmReduce(s, ev({ op: 'put', key: 'p', val: '9' }))[0];
  s = lsmReduce(s, fault('torn-write'))[0];
  expect(s.sstables.some((t) => t.torn)).toBe(true);
  s = lsmReduce(s, fault('recover'))[0];
  expect(s.sstables.some((t) => t.torn)).toBe(false);
  expect(lsmGet(s, 'p').value).toBe('9');
});
