// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import type { BatchSchedInspect, BatchWorkerInspect } from '../../../modules/batch';
import type { Side } from '../../../modules/batch-shared';
import { StagePanel, type ShuffleDot } from './StagePanel';

afterEach(cleanup);

/** MR mid-reduce: m1 still running (not done), r0 running, r1 not yet runnable. */
const mrSched: BatchSchedInspect = {
  role: 'sched',
  live: { W1: true, W2: true, W3: false },
  mr: {
    phase: 'reduce',
    tasks: {
      m0: { status: 'done', worker: 'W1', attempt: 1 },
      m1: { status: 'running', worker: 'W2', attempt: 1 },
      m2: { status: 'done', worker: 'W3', attempt: 1 },
      r0: { status: 'running', worker: 'W1', attempt: 1 },
      r1: { status: 'waiting', worker: null, attempt: 0 },
    },
    counters: { materialized: 16, shuffleInFlight: 0, reexecuted: 1, restarts: 0, lostAfterDone: 1, wasted: 12, completionTick: null },
    output: [
      ['/home', 10],
      ['/about', 6],
    ],
  },
  df: {
    attempt: 1,
    placement: {},
    mapsDone: [],
    reduceDone: [],
    awaitingRevive: false,
    counters: { materialized: 0, shuffleInFlight: 0, reexecuted: 0, restarts: 0, lostAfterDone: 0, wasted: 0, completionTick: null },
    output: [],
  },
};

/** DF side of the same tick, mid-restart and awaiting revive (all workers down). */
const dfSched: BatchSchedInspect = {
  ...mrSched,
  df: {
    attempt: 2,
    placement: { m0: 'W2', r0: 'W2' },
    mapsDone: ['m0'],
    reduceDone: [],
    awaitingRevive: true,
    counters: { materialized: 0, shuffleInFlight: 0, reexecuted: 0, restarts: 1, lostAfterDone: 0, wasted: 20, completionTick: null },
    output: [['/home', 4]],
  },
};

const workers: BatchWorkerInspect[] = [
  {
    role: 'worker',
    id: 'W1',
    mr: { task: 'r0', phase: 'fetch', recordsDone: 3, recordsTotal: 16, diskFiles: ['m0'] },
    df: { maps: [], reduces: [] },
  },
  {
    role: 'worker',
    id: 'W2',
    mr: { task: 'm1', phase: 'exec', recordsDone: 5, recordsTotal: 8, diskFiles: [] },
    df: { maps: [{ task: 'm0', cursor: 4, done: false }], reduces: [{ task: 'r0', folded: 2, closed: 0 }] },
  },
  {
    role: 'worker',
    id: 'W3',
    mr: { task: null, phase: null, recordsDone: 0, recordsTotal: 0, diskFiles: ['m2'] },
    df: { maps: [], reduces: [] },
  },
];

const dots: ShuffleDot[] = [
  { id: 'd1', from: 'W1', to: 'W2', frac: 0.3 },
  { id: 'd2', from: 'W2', to: 'W3', frac: 0.7 },
];

test('root section carries data-side', () => {
  const { container } = render(
    <StagePanel side="mr" title="MapReduce" sched={mrSched} workers={workers} deadNodes={[]} dots={[]} />,
  );
  expect(container.querySelector('section')?.getAttribute('data-side')).toBe('mr');
});

test('MR task chips reflect sched.mr.tasks status', () => {
  const { container } = render(
    <StagePanel side="mr" title="MapReduce" sched={mrSched} workers={workers} deadNodes={[]} dots={[]} />,
  );
  expect(container.querySelector('[data-task="m0"]')?.getAttribute('data-status')).toBe('done');
  expect(container.querySelector('[data-task="m1"]')?.getAttribute('data-status')).toBe('running');
  expect(container.querySelector('[data-task="r0"]')?.getAttribute('data-status')).toBe('running');
  expect(container.querySelector('[data-task="r1"]')?.getAttribute('data-status')).toBe('waiting');
});

test('DF task chips derive status from mapsDone/placement/reduceDone', () => {
  const side: Side = 'df';
  const { container } = render(
    <StagePanel side={side} title="Dataflow" sched={dfSched} workers={workers} deadNodes={[]} dots={[]} />,
  );
  expect(container.querySelector('[data-task="m0"]')?.getAttribute('data-status')).toBe('done'); // in mapsDone
  expect(container.querySelector('[data-task="r0"]')?.getAttribute('data-status')).toBe('running'); // placed, not done
  expect(container.querySelector('[data-task="m1"]')?.getAttribute('data-status')).toBe('waiting'); // not placed
});

test('MR disk row is present with per-worker disk files', () => {
  const { container } = render(
    <StagePanel side="mr" title="MapReduce" sched={mrSched} workers={workers} deadNodes={[]} dots={[]} />,
  );
  const diskRow = container.querySelector('[data-disk-row]');
  expect(diskRow).not.toBeNull();
  expect(diskRow?.querySelector('[data-disk-file="m0"]')).not.toBeNull();
  expect(diskRow?.querySelector('[data-disk-file="m2"]')).not.toBeNull();
});

test('DF side renders no disk row at all', () => {
  const { container } = render(
    <StagePanel side="df" title="Dataflow" sched={dfSched} workers={workers} deadNodes={[]} dots={[]} />,
  );
  expect(container.querySelector('[data-disk-row]')).toBeNull();
});

test('dead worker is flagged and dimmed', () => {
  const { container } = render(
    <StagePanel side="mr" title="MapReduce" sched={mrSched} workers={workers} deadNodes={['W3']} dots={[]} />,
  );
  const w1 = container.querySelector('[data-worker="W1"]');
  const w3 = container.querySelector('[data-worker="W3"]');
  expect(w1?.getAttribute('data-dead')).toBeNull();
  expect(w3?.getAttribute('data-dead')).toBe('true');
  expect(w3?.className).toContain('opacity-40');
});

test('shuffle svg renders one circle per dot', () => {
  const { container } = render(
    <StagePanel side="mr" title="MapReduce" sched={mrSched} workers={workers} deadNodes={[]} dots={dots} />,
  );
  const svg = container.querySelector('[data-shuffle-svg]');
  expect(svg).not.toBeNull();
  expect(svg?.querySelectorAll('[data-dot]')).toHaveLength(dots.length);
});

test('zero dots renders zero circles', () => {
  const { container } = render(
    <StagePanel side="mr" title="MapReduce" sched={mrSched} workers={workers} deadNodes={[]} dots={[]} />,
  );
  expect(container.querySelectorAll('[data-dot]')).toHaveLength(0);
});

test('output table renders one row per [url, count] entry', () => {
  const { container } = render(
    <StagePanel side="mr" title="MapReduce" sched={mrSched} workers={workers} deadNodes={[]} dots={[]} />,
  );
  const rows = container.querySelectorAll('[data-output] [data-output-row]');
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain('/home');
  expect(rows[0].textContent).toContain('10');
});

test('output shows placeholder when empty', () => {
  const emptySched: BatchSchedInspect = { ...mrSched, mr: { ...mrSched.mr, output: [] } };
  const { container } = render(
    <StagePanel side="mr" title="MapReduce" sched={emptySched} workers={workers} deadNodes={[]} dots={[]} />,
  );
  expect(container.querySelectorAll('[data-output-row]')).toHaveLength(0);
  expect(container.querySelector('[data-output]')?.textContent).toContain('no output yet');
});

test('df awaitingRevive shows the waiting badge', () => {
  const { container } = render(
    <StagePanel side="df" title="Dataflow" sched={dfSched} workers={workers} deadNodes={[]} dots={[]} />,
  );
  expect(container.querySelector('[data-waiting="true"]')).not.toBeNull();
});

test('df not awaitingRevive shows no waiting badge', () => {
  const notWaiting: BatchSchedInspect = { ...dfSched, df: { ...dfSched.df, awaitingRevive: false } };
  const { container } = render(
    <StagePanel side="df" title="Dataflow" sched={notWaiting} workers={workers} deadNodes={[]} dots={[]} />,
  );
  expect(container.querySelector('[data-waiting]')).toBeNull();
});

test('DF progress strip shows attempt number and restarts', () => {
  const { container } = render(
    <StagePanel side="df" title="Dataflow" sched={dfSched} workers={workers} deadNodes={[]} dots={[]} />,
  );
  expect(container.textContent).toContain('#2');
  expect(container.textContent).toContain('1'); // restarts count
});
