// src/ui/labs/txn/TxnScoreboard.test.tsx
// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import type { TxnInspect } from '../../../modules/txn';
import { TxnScoreboard } from './TxnScoreboard';

afterEach(cleanup);

const mk = (level: TxnInspect['level'], anomalies: TxnInspect['anomalies']): TxnInspect => ({
  level,
  credo: '',
  txns: {
    T1: { status: 'committed', beganAt: 1, endedAt: 5, snapshotAt: null, reads: [], writes: [], abortReason: null },
    T2: { status: 'committed', beganAt: 2, endedAt: 8, snapshotAt: null, reads: [], writes: [], abortReason: null },
  },
  committed: { x: 1 },
  pending: {},
  queue: [],
  anomalies,
  counters: { commits: 2, aborts: 0, queuedOps: 0, skippedOps: 0 },
});

const panels = [
  mk('RU', [{ type: 'dirty-read', detail: '', at: 1 }]),
  mk('RC', []),
  mk('SI', []),
  mk('SER', []),
];

test('one column per level, rows for counters and each anomaly type', () => {
  const { container } = render(<TxnScoreboard panels={panels} />);
  const headers = [...container.querySelectorAll('th')].map((h) => h.textContent);
  expect(headers).toEqual(['', 'RU', 'RC', 'SI', 'SER']);
  expect(container.querySelector('[data-cell="RU:dirty reads"]')?.textContent).toBe('1');
  expect(container.querySelector('[data-cell="RC:dirty reads"]')?.textContent).toBe('0');
  expect(container.querySelector('[data-cell="RU:commits"]')?.textContent).toBe('2');
});

test('non-zero anomaly cells are marked bad; zero cells are not', () => {
  const { container } = render(<TxnScoreboard panels={panels} />);
  expect(container.querySelector('[data-cell="RU:dirty reads"]')?.getAttribute('data-bad')).toBe('true');
  expect(container.querySelector('[data-cell="RC:dirty reads"]')?.getAttribute('data-bad')).toBeNull();
});
