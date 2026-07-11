// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ControlAction } from '../../engine';
import { ChaosToolbar } from './ChaosToolbar';

afterEach(cleanup);

test('renders only declared capabilities', () => {
  render(<ChaosToolbar caps={['kill-node']} nodeIds={['a', 'b']} deadNodes={[]} onAction={() => undefined} />);
  expect(screen.getByText('kill a')).toBeTruthy();
  expect(screen.queryByText('heal')).toBeNull();
  expect(screen.queryByText(/drop/)).toBeNull();
});

test('kill/revive toggle by dead state; actions dispatched', () => {
  const actions: ControlAction[] = [];
  render(
    <ChaosToolbar
      caps={['kill-node', 'partition']}
      nodeIds={['a', 'b']}
      deadNodes={['b']}
      onAction={(a) => actions.push(a)}
    />,
  );
  fireEvent.click(screen.getByText('kill a'));
  fireEvent.click(screen.getByText('revive b'));
  fireEvent.click(screen.getByText('heal'));
  expect(actions).toEqual([
    { type: 'kill', node: 'a' },
    { type: 'revive', node: 'b' },
    { type: 'heal' },
  ]);
});

test('partition split isolates the checked nodes from the rest', () => {
  const actions: ControlAction[] = [];
  render(
    <ChaosToolbar
      caps={['partition']}
      nodeIds={['A', 'B', 'C', 'D', 'E']}
      deadNodes={[]}
      onAction={(a) => actions.push(a)}
    />,
  );
  // Reproduces the 5.3 sloppy-loss script's partition: D,E | A,B,C.
  fireEvent.click(screen.getByLabelText('isolate D'));
  fireEvent.click(screen.getByLabelText('isolate E'));
  fireEvent.click(screen.getByText('split'));
  expect(actions).toEqual([
    { type: 'partition', groups: [['D', 'E'], ['A', 'B', 'C']] },
  ]);
});

test('split is disabled until a proper subset is selected', () => {
  render(
    <ChaosToolbar caps={['partition']} nodeIds={['A', 'B']} deadNodes={[]} onAction={() => undefined} />,
  );
  const split = screen.getByText('split') as HTMLButtonElement;
  expect(split.disabled).toBe(true); // nothing selected
  fireEvent.click(screen.getByLabelText('isolate A'));
  expect(split.disabled).toBe(false); // proper subset {A}
  fireEvent.click(screen.getByLabelText('isolate B'));
  expect(split.disabled).toBe(true); // all nodes selected = no split
});
