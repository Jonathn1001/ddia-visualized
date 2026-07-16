// src/ui/labs/raft/RaftLab.test.tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { RaftLab } from './RaftLab';

afterEach(cleanup);

test('renders five node columns, client controls, and three challenges', () => {
  const { container, getAllByText } = render(<RaftLab />);
  expect(container.querySelectorAll('[data-node]')).toHaveLength(5);
  expect(container.querySelector('[data-control="node"]')).not.toBeNull();
  expect(container.querySelector('[data-action="client-write"]')).not.toBeNull();
  expect(container.querySelector('[data-action="client-read"]')).not.toBeNull();
  expect(getAllByText(/Challenge:/)).toHaveLength(3);
});

test('a client write at the selected node lands in the client history after stepping', () => {
  const { container } = render(<RaftLab />);
  const write = container.querySelector('[data-action="client-write"]') as HTMLButtonElement;
  fireEvent.click(write);
  const step = container.querySelector('[data-action="lab-step"]') as HTMLButtonElement;
  // Client ops enter via a 1-tick timer hop (module-side) — the row appears
  // only after that timer fires, never on the injecting click itself.
  let rows = 0;
  for (let i = 0; i < 30 && rows === 0; i++) {
    fireEvent.click(step);
    rows = container.querySelectorAll('[data-hrow]').length;
  }
  expect(rows).toBeGreaterThan(0);
});

test('the read control also lands a row once stepped', () => {
  const { container } = render(<RaftLab />);
  fireEvent.click(container.querySelector('[data-action="client-read"]') as HTMLButtonElement);
  const step = container.querySelector('[data-action="lab-step"]') as HTMLButtonElement;
  let rows = 0;
  for (let i = 0; i < 30 && rows === 0; i++) {
    fireEvent.click(step);
    rows = container.querySelectorAll('[data-hrow]').length;
  }
  expect(rows).toBeGreaterThan(0);
});

test('check button produces a verdict line', () => {
  const { container } = render(<RaftLab />);
  const check = container.querySelector('[data-action="check"]') as HTMLButtonElement;
  expect(check.disabled).toBe(false);
  fireEvent.click(check);
  expect(container.querySelector('[data-verdict]')).not.toBeNull();
});

test('selecting a different node updates the select value', () => {
  const { container } = render(<RaftLab />);
  const select = container.querySelector('[data-control="node"]') as HTMLSelectElement;
  fireEvent.change(select, { target: { value: 'N3' } });
  expect(select.value).toBe('N3');
});

test('reset (new seed) remounts the sim without crashing', () => {
  const { container, getAllByText } = render(<RaftLab />);
  fireEvent.click(container.querySelector('[data-action="lab-step"]') as HTMLButtonElement);
  fireEvent.click(getAllByText(/reset \(new seed\)/)[0]);
  expect(container.querySelectorAll('[data-node]')).toHaveLength(5);
});
