// @vitest-environment jsdom
import { expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from './App';

test('shell renders the app title', () => {
  render(<App />);
  expect(screen.getByText('DDIA Visualized')).toBeTruthy();
});
