// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { StorageLab } from './StorageLab';

afterEach(cleanup);

test('mounts with both engines and the scoreboard', async () => {
  render(<StorageLab />);
  expect((await screen.findAllByText('LSM-tree')).length).toBeGreaterThan(0); // LsmView header + scoreboard column
  expect(screen.getAllByText(/B-tree/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/write-amp/i).length).toBeGreaterThan(0); // scoreboard row + namespaced metrics
});

test('a write button issues ops without crashing', () => {
  render(<StorageLab />);
  const write = screen.getByRole('button', { name: 'write' });
  fireEvent.click(write);
  expect(write).toBeTruthy();
});
