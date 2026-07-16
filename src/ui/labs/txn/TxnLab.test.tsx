// src/ui/labs/txn/TxnLab.test.tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { PRESETS } from '../../../modules/txn-shared';
import { TxnLab } from './TxnLab';

afterEach(cleanup);

test('renders four isolation panels and the schedule', () => {
  const { container } = render(<TxnLab />);
  expect(container.querySelectorAll('[data-txn="T1"]')).toHaveLength(4);
  expect(container.querySelectorAll('[data-preset]')).toHaveLength(3);
});

test('run-to-end on the dirty-read preset: RU flags it, RC does not', () => {
  const { container } = render(<TxnLab />);
  fireEvent.click(container.querySelector('[data-action="run-all"]') as HTMLButtonElement);
  const badges = [...container.querySelectorAll('[data-anomaly="dirty-read"]')];
  expect(badges).toHaveLength(1); // exactly one panel sinned
  expect(container.querySelector('[data-cell="RU:dirty reads"]')?.textContent).toBe('1');
  expect(container.querySelector('[data-cell="RC:dirty reads"]')?.textContent).toBe('0');
});

test('switching preset resets the cursor and the panels', () => {
  const { container } = render(<TxnLab />);
  fireEvent.click(container.querySelector('[data-action="run-all"]') as HTMLButtonElement);
  fireEvent.click(container.querySelector('[data-preset="write-skew"]') as HTMLButtonElement);
  const rows = container.querySelectorAll('[data-step]');
  expect(rows).toHaveLength(PRESETS[2].steps.length);
  expect(rows[0].getAttribute('data-state')).toBe('next');
  expect(container.querySelectorAll('[data-anomaly]')).toHaveLength(0);
});

test('stepping advances all four panels in lockstep', () => {
  const { container } = render(<TxnLab />);
  const step = container.querySelector('[data-action="step"]') as HTMLButtonElement;
  fireEvent.click(step); // T1 begin
  fireEvent.click(step); // T1 write x=99
  const active = [...container.querySelectorAll('[data-txn="T1"]')].map((el) =>
    el.getAttribute('data-status'),
  );
  expect(active).toEqual(['active', 'active', 'active', 'active']);
});
