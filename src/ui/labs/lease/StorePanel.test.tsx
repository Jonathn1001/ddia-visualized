// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import type { StoreInspect } from '../../../modules/lease';
import { StorePanel } from './StorePanel';

afterEach(cleanup);

const store: StoreInspect = {
  role: 'store',
  value: 'W1#3',
  lastToken: 2,
  fencing: false,
  history: [
    { token: 2, writer: 'W2', outcome: 'ok', at: 90 },
    { token: 1, writer: 'W1', outcome: 'stale', at: 120 },
    { token: 1, writer: 'W1', outcome: 'rejected', at: 130 },
  ],
  writesOk: 1,
  staleAccepts: 1,
  rejects: 1,
};

test('renders value, last token and fencing state', () => {
  const { container } = render(<StorePanel store={store} />);
  expect(container.textContent).toContain('W1#3');
  expect(container.textContent).toContain('fencing off');
});

test('history rows carry outcome badges; stale is the alarm', () => {
  const { container } = render(<StorePanel store={store} />);
  const rows = container.querySelectorAll('[data-row]');
  expect(rows).toHaveLength(3);
  expect(rows[1].getAttribute('data-outcome')).toBe('stale');
  expect(rows[2].getAttribute('data-outcome')).toBe('rejected');
});
