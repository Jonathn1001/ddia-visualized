// src/ui/labs/txn/IsolationPanel.test.tsx
// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import type { TxnInspect } from '../../../modules/txn';
import { IsolationPanel } from './IsolationPanel';

afterEach(cleanup);

const baseTxn = {
  status: 'idle' as const,
  beganAt: null,
  endedAt: null,
  snapshotAt: null,
  reads: [],
  writes: [],
  abortReason: null,
};

const fixture: TxnInspect = {
  level: 'RU',
  credo: 'reads may see uncommitted data',
  txns: {
    T1: { ...baseTxn, status: 'active', beganAt: 1 },
    T2: { ...baseTxn, status: 'aborted', abortReason: 'ensure failed: alice+bob=1 < 2' },
  },
  committed: { alice: 1, bob: 1 },
  pending: { alice: [{ txn: 'T1', value: 0 }] },
  queue: [],
  anomalies: [{ type: 'dirty-read', detail: 'T2 read x=99 — uncommitted data from T1', at: 4 }],
  counters: { commits: 0, aborts: 1, queuedOps: 0, skippedOps: 0 },
};

test('renders level, credo, txn statuses and abort reason', () => {
  const { container } = render(<IsolationPanel inspect={fixture} />);
  expect(container.textContent).toContain('RU');
  expect(container.textContent).toContain('reads may see uncommitted data');
  expect(container.querySelector('[data-txn="T1"]')?.getAttribute('data-status')).toBe('active');
  expect(container.querySelector('[data-txn="T2"]')?.getAttribute('data-status')).toBe('aborted');
  expect(container.textContent).toContain('ensure failed');
});

test('renders committed values with an uncommitted overlay', () => {
  const { container } = render(<IsolationPanel inspect={fixture} />);
  const alice = container.querySelector('[data-key="alice"]');
  expect(alice?.textContent).toContain('1');
  expect(alice?.textContent).toContain('T1: 0'); // pending overlay
});

test('renders anomaly badges', () => {
  const { container } = render(<IsolationPanel inspect={fixture} />);
  const badges = container.querySelectorAll('[data-anomaly]');
  expect(badges).toHaveLength(1);
  expect(badges[0].getAttribute('data-anomaly')).toBe('dirty-read');
});

test('renders the SER queue when present', () => {
  const { container } = render(
    <IsolationPanel inspect={{ ...fixture, level: 'SER', queue: ['T2 begin', 'T2 read x'] }} />,
  );
  const q = container.querySelectorAll('[data-queued]');
  expect(q).toHaveLength(2);
  expect(q[1].textContent).toContain('T2 read x');
});
