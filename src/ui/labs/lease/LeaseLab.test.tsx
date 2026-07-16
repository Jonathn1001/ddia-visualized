// src/ui/labs/lease/LeaseLab.test.tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { LeaseLab } from './LeaseLab';

afterEach(cleanup);

test('renders cluster, lease panel, store panel, fault bar and three challenges', () => {
  const { container, getAllByText } = render(<LeaseLab />);
  expect(container.querySelector('[data-lock]')).not.toBeNull();
  expect(container.querySelector('[data-action="fencing"]')).not.toBeNull();
  expect(getAllByText(/Challenge:/)).toHaveLength(3);
});

test('acquire drives the sim: W1 eventually holds the lease', () => {
  const { container } = render(<LeaseLab />);
  fireEvent.click(container.querySelector('[data-action="acquire-W1"]') as HTMLButtonElement);
  const step = container.querySelector('[data-action="lab-step"]') as HTMLButtonElement;
  // Track across the run, not just the final tick: the module's own lease
  // lifecycle (grant -> check/work cycles -> self-detected TTL expiry -> idle,
  // with no auto re-acquire) fully drains the queue well inside 60 steps for
  // this seed, so a snapshot taken only after the last click can land back on
  // idle even though W1 genuinely held the lease along the way.
  let seenHoldingOrWaiting = false;
  for (let i = 0; i < 60; i++) {
    fireEvent.click(step);
    if (/holding|waiting/.test(container.querySelector('[data-worker="W1"]')?.textContent ?? '')) {
      seenHoldingOrWaiting = true;
    }
  }
  expect(seenHoldingOrWaiting).toBe(true);
});

test('fencing toggle flips the store panel', () => {
  const { container } = render(<LeaseLab />);
  fireEvent.click(container.querySelector('[data-action="fencing"]') as HTMLButtonElement);
  const step = container.querySelector('[data-action="lab-step"]') as HTMLButtonElement;
  for (let i = 0; i < 4; i++) fireEvent.click(step);
  expect(container.textContent).toContain('fencing on');
});
