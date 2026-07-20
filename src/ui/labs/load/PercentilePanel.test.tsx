// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { PercentilePanel } from './PercentilePanel';
import type { LoadInspect } from '../../../modules/load-shared';

afterEach(cleanup);

const base: LoadInspect = {
  loadLevel: 12,
  servers: 1,
  cacheHitRate: 0,
  varianceOn: true,
  fanout: 1,
  inService: 1,
  queueLen: 3,
  p50: 30,
  p95: 120,
  p99: 400,
  bp50: 30,
  bp95: 60,
  bp99: 90,
  throughput: 0.1,
  utilisation: 0.95,
  completed: 240,
  samples: 200,
  sla: 150,
  ch: { c1: { breached: false, rescued: false }, c2: { hiTail: false, loTail: false }, c3: { amplified: false } },
};

describe('PercentilePanel', () => {
  test('renders the three user percentiles and the p99 value', () => {
    const { getByText } = render(<PercentilePanel view={base} />);
    expect(getByText('p50')).not.toBeNull();
    expect(getByText('p99')).not.toBeNull();
    expect(getByText('400')).not.toBeNull();
  });

  test('shows a warming-up state before WINDOW_MIN samples', () => {
    const { getByText, queryByText } = render(<PercentilePanel view={{ ...base, samples: 5 }} />);
    expect(getByText(/warming up/i)).not.toBeNull();
    expect(queryByText('400')).toBeNull(); // no bars while warming
  });

  test('shows the backend row only when fanout > 1', () => {
    const { queryByText } = render(<PercentilePanel view={base} />);
    expect(queryByText(/backend/i)).toBeNull();
    cleanup();
    const { getByText } = render(<PercentilePanel view={{ ...base, fanout: 20 }} />);
    expect(getByText(/backend/i)).not.toBeNull();
  });

  test('flags a breaching p99 with a data attribute for the ship-gate walk', () => {
    const { container } = render(<PercentilePanel view={base} />);
    const panel = container.querySelector('[data-panel="percentiles"]')!;
    expect(panel.getAttribute('data-p99')).toBe('400');
    expect(panel.getAttribute('data-sla')).toBe('150');
  });
});
