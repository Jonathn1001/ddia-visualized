// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { LeaseFaultBar } from './LeaseFaultBar';

afterEach(cleanup);

const noop = () => {};
const base = { onAcquire: noop, onPause: noop, onSkew: noop, onFencing: noop, fencing: false };

test('acquire buttons per worker', () => {
  const onAcquire = vi.fn();
  const { container } = render(<LeaseFaultBar {...base} onAcquire={onAcquire} />);
  fireEvent.click(container.querySelector('[data-action="acquire-W2"]') as HTMLButtonElement);
  expect(onAcquire).toHaveBeenCalledWith('W2');
});

test('gc-pause and clock-skew fire with the chosen worker', () => {
  const onPause = vi.fn();
  const onSkew = vi.fn();
  const { container } = render(<LeaseFaultBar {...base} onPause={onPause} onSkew={onSkew} />);
  fireEvent.click(container.querySelector('[data-action="pause-W1"]') as HTMLButtonElement);
  expect(onPause).toHaveBeenCalledWith('W1', expect.any(Number));
  fireEvent.click(container.querySelector('[data-action="skew-W1"]') as HTMLButtonElement);
  expect(onSkew).toHaveBeenCalledWith('W1', 0.5);
});

test('fencing toggle reflects and flips state', () => {
  const onFencing = vi.fn();
  const { container } = render(<LeaseFaultBar {...base} onFencing={onFencing} />);
  const t = container.querySelector('[data-action="fencing"]') as HTMLButtonElement;
  expect(t.textContent).toContain('off');
  fireEvent.click(t);
  expect(onFencing).toHaveBeenCalledWith(true);
});
