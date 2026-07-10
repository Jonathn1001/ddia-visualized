// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import App from './App';

afterEach(cleanup);

test('shell renders navbar brand and the default lab page', () => {
  render(<App />);
  expect(screen.getByText('DDIA')).toBeTruthy();
  expect(screen.getByText('Visualized')).toBeTruthy();
  expect(screen.getByText('Replication Theater', { selector: 'h1' })).toBeTruthy();
});

test('sidebar navigates between labs; unbuilt labs disabled', () => {
  render(<App />);
  fireEvent.click(screen.getByText('Ping-Pong Token Ring'));
  expect(screen.getByText('Ping-Pong Token Ring', { selector: 'h1' })).toBeTruthy();
  const soonBtn = screen.getByText('LSM-Tree vs B-Tree').closest('button')!;
  expect(soonBtn.disabled).toBe(true);
});
