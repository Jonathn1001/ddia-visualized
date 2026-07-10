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
