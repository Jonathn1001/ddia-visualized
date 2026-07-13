// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Scoreboard } from './Scoreboard';

afterEach(cleanup);

test('scoreboard fills captured rows and dims stale/empty ones', () => {
  const scores = {
    kafka: { produced: 12, delivered: 12, duplicates: 3, lost: 0 },
    rabbit: { produced: 12, delivered: 12, duplicates: 0, lost: 0 },
    redis: null,
  };
  const stale = { kafka: false, rabbit: true, redis: true };
  const { container } = render(<Scoreboard scores={scores} stale={stale} />);

  const kafka = container.querySelector('[data-score="kafka"]')!;
  expect(kafka.querySelector('[data-duplicates]')?.textContent).toBe('3');
  expect(kafka.className).not.toContain('text-dim'); // captured + fresh

  const rabbit = container.querySelector('[data-score="rabbit"]')!;
  expect(rabbit.className).toContain('text-dim'); // stale → dimmed

  const redis = container.querySelector('[data-score="redis"]')!;
  expect(redis.querySelector('[data-lost]')?.textContent).toBe('—'); // no run yet
  expect(redis.className).toContain('text-dim');
});
