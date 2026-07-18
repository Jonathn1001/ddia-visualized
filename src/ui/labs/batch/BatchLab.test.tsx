// src/ui/labs/batch/BatchLab.test.tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { BatchLab } from './BatchLab';

afterEach(cleanup);

test('renders both stage panels and three challenges', () => {
  const { container, getAllByText } = render(<BatchLab />);
  expect(container.querySelector('[data-side="mr"]')).not.toBeNull();
  expect(container.querySelector('[data-side="df"]')).not.toBeNull();
  expect(getAllByText(/Challenge:/)).toHaveLength(3);
});

test('run job button exists and disables after click', () => {
  const { container } = render(<BatchLab />);
  const runJob = container.querySelector('[data-action="run-job"]') as HTMLButtonElement;
  expect(runJob).not.toBeNull();
  expect(runJob.disabled).toBe(false);
  fireEvent.click(runJob);
  expect(runJob.disabled).toBe(true);
});

test('after run-job, stepping the sim does not crash and run-job stays disabled', () => {
  const { container } = render(<BatchLab />);
  fireEvent.click(container.querySelector('[data-action="run-job"]') as HTMLButtonElement);
  const step = container.querySelector('[data-action="lab-step"]') as HTMLButtonElement;
  for (let i = 0; i < 20; i++) fireEvent.click(step);
  const runJob = container.querySelector('[data-action="run-job"]') as HTMLButtonElement;
  expect(runJob.disabled).toBe(true);
  // both panels still present and rendering after the sim has advanced
  expect(container.querySelector('[data-side="mr"]')).not.toBeNull();
  expect(container.querySelector('[data-side="df"]')).not.toBeNull();
});

test('reset (new seed) remounts the sim and re-enables run job', () => {
  const { container, getAllByText } = render(<BatchLab />);
  fireEvent.click(container.querySelector('[data-action="run-job"]') as HTMLButtonElement);
  expect((container.querySelector('[data-action="run-job"]') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(getAllByText(/reset \(new seed\)/)[0]);
  expect(container.querySelector('[data-side="mr"]')).not.toBeNull();
  expect(container.querySelector('[data-side="df"]')).not.toBeNull();
  expect((container.querySelector('[data-action="run-job"]') as HTMLButtonElement).disabled).toBe(false);
});

test('kill button reaches the driver: a killed worker is marked dead within a few steps', () => {
  const { container } = render(<BatchLab />);
  const killW1 = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent === 'kill W1',
  ) as HTMLButtonElement;
  expect(killW1).toBeTruthy();
  fireEvent.click(killW1);
  const step = container.querySelector('[data-action="lab-step"]') as HTMLButtonElement;
  let dead = false;
  for (let i = 0; i < 10 && !dead; i++) {
    fireEvent.click(step);
    dead = container.querySelector('[data-worker="W1"][data-dead="true"]') !== null;
  }
  expect(dead).toBe(true);
});
