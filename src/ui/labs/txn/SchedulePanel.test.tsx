// src/ui/labs/txn/SchedulePanel.test.tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { PRESETS } from '../../../modules/txn-shared';
import { SchedulePanel } from './SchedulePanel';

afterEach(cleanup);

const noop = () => {};
const base = {
  presets: PRESETS,
  activeId: 'dirty-read' as const,
  cursor: 1,
  onPick: noop,
  onStep: noop,
  onRunAll: noop,
  onReset: noop,
};

test('renders one row per step with the cursor on the next op', () => {
  const { container } = render(<SchedulePanel {...base} />);
  const rows = container.querySelectorAll('[data-step]');
  expect(rows).toHaveLength(PRESETS[0].steps.length);
  expect(rows[0].getAttribute('data-state')).toBe('done');
  expect(rows[1].getAttribute('data-state')).toBe('next');
  expect(rows[2].getAttribute('data-state')).toBe('todo');
  expect(rows[0].textContent).toContain('T1 begin');
});

test('one picker button per preset; picking calls onPick', () => {
  const onPick = vi.fn();
  const { container } = render(<SchedulePanel {...base} onPick={onPick} />);
  const pickers = container.querySelectorAll('[data-preset]');
  expect(pickers).toHaveLength(3);
  fireEvent.click(pickers[2]);
  expect(onPick).toHaveBeenCalledWith('write-skew');
});

test('step and run-all disabled once the schedule is consumed; reset always live', () => {
  const onStep = vi.fn();
  const { container } = render(
    <SchedulePanel {...base} cursor={PRESETS[0].steps.length} onStep={onStep} />,
  );
  const step = container.querySelector('[data-action="step"]') as HTMLButtonElement;
  const runAll = container.querySelector('[data-action="run-all"]') as HTMLButtonElement;
  const reset = container.querySelector('[data-action="reset"]') as HTMLButtonElement;
  expect(step.disabled).toBe(true);
  expect(runAll.disabled).toBe(true);
  expect(reset.disabled).toBe(false);
  fireEvent.click(step);
  expect(onStep).not.toHaveBeenCalled();
});
