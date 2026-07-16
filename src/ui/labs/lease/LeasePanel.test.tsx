// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import type { LockInspect, WorkerInspect } from '../../../modules/lease';
import { LeasePanel } from './LeasePanel';

afterEach(cleanup);

const lock: LockInspect = { role: 'lock', holder: 'W2', token: 2, expiresAt: 150, queue: ['W1'] };
const workers: WorkerInspect[] = [
  { role: 'worker', id: 'W1', state: 'holding', token: 1, grantAt: 10, ttl: 60, rate: 0.5, pausedUntil: null, working: true, writesSent: 3 },
  { role: 'worker', id: 'W2', state: 'holding', token: 2, grantAt: 90, ttl: 60, rate: 1, pausedUntil: null, working: false, writesSent: 1 },
];

test('shows the lock truth: holder, token, countdown, queue', () => {
  const { container } = render(<LeasePanel lock={lock} workers={workers} time={100} />);
  const truth = container.querySelector('[data-lock]');
  expect(truth?.textContent).toContain('W2');
  expect(truth?.textContent).toContain('token 2');
  expect(truth?.textContent).toContain('50'); // 150 - 100
  expect(truth?.textContent).toContain('W1'); // queued
});

test('flags a worker whose belief contradicts the lock (stale belief in coral)', () => {
  const { container } = render(<LeasePanel lock={lock} workers={workers} time={100} />);
  const w1 = container.querySelector('[data-worker="W1"]');
  // W1 believes: (100-10)*0.5 = 45 < 60 → still valid on its clock, but Lock says W2 holds
  expect(w1?.getAttribute('data-belief')).toBe('stale');
  const w2 = container.querySelector('[data-worker="W2"]');
  expect(w2?.getAttribute('data-belief')).toBe('true'); // holder and believes it
});

test('shows working and paused badges', () => {
  const paused = [{ ...workers[0], pausedUntil: 500, working: false }];
  const { container } = render(<LeasePanel lock={lock} workers={paused} time={100} />);
  expect(container.querySelector('[data-worker="W1"]')?.textContent).toContain('paused');
  const { container: c2 } = render(<LeasePanel lock={lock} workers={workers} time={100} />);
  expect(c2.querySelector('[data-worker="W1"]')?.textContent).toContain('working');
});
