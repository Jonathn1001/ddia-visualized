// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ApiStatsPanel } from './ApiStatsPanel';

afterEach(cleanup);

test('renders the core stats and highlights a partial page', () => {
  const { container } = render(
    <ApiStatsPanel mode="rest" stats={{ roundTrips: 4, bytes: 700, delivered: 2, expected: 3, failed: 1, settled: true }} />,
  );
  expect(container.querySelector('[data-stat="round-trips"]')?.textContent).toContain('4');
  expect(container.querySelector('[data-stat="bytes"]')?.textContent).toContain('700');
  const delivered = container.querySelector('[data-stat="delivered"]')!;
  expect(delivered.textContent).toContain('2/3');
  expect(delivered.querySelector('.text-warn')).toBeTruthy(); // partial → warned
});

test('renders mode-specific extra rows', () => {
  const { container } = render(
    <ApiStatsPanel
      mode="grpc"
      stats={{ roundTrips: 1, bytes: 170, delivered: 3, expected: 3, failed: 0, settled: true }}
      extras={[{ key: 'schema', label: 'server schema', value: 'v2' }]}
    />,
  );
  expect(container.querySelector('[data-stat="schema"]')?.textContent).toContain('v2');
});
