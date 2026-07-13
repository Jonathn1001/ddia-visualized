// @vitest-environment jsdom
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { BrokerInternals } from './BrokerInternals';

afterEach(cleanup);

describe('BrokerInternals', () => {
  test('kafka: partition lanes with the uncommitted crash-window offset marked', () => {
    const broker = {
      partitions: { p0: ['m0', 'm1', 'm2'], p1: ['m3'] },
      committed: { p0: 1, p1: 0 },
      delivered: { p0: 3, p1: 1 },
      assignment: { p0: 'C1', p1: 'C2' },
      stalled: { p0: false, p1: false },
    };
    const { container } = render(<BrokerInternals mode="kafka" broker={broker} consumers={[]} />);
    expect(container.querySelector('[data-partition="p0"]')).toBeTruthy();
    // offset 1 is in [committed=1, delivered=3) → a crash-window cell
    expect(container.querySelector('[data-offset="p0:1"]')).toBeTruthy();
    expect(container.querySelector('[data-offset="p0:2"]')).toBeTruthy();
  });

  test('rabbit: unacked cells, a redelivered mark, and a dead-letter entry', () => {
    const broker = {
      unacked: { m0: { consumer: 'C1', redelivered: false }, m1: { consumer: 'C2', redelivered: true } },
      deadLetter: ['m9'],
      redeliveries: 2,
    };
    const { container } = render(<BrokerInternals mode="rabbit" broker={broker} consumers={[]} />);
    expect(container.querySelector('[data-unacked="m0"]')).toBeTruthy();
    expect(container.querySelector('[data-redelivered="m1"]')).toBeTruthy();
    expect(container.querySelector('[data-deadletter="m9"]')).toBeTruthy();
  });

  test('redis: subscriber rows with per-subscriber miss counts', () => {
    const broker = { published: ['m0', 'm1', 'm2'] };
    const consumers = [
      { id: 'C1', dead: true, processed: ['m0'] },
      { id: 'C2', dead: false, processed: ['m0', 'm1', 'm2'] },
    ];
    const { container } = render(<BrokerInternals mode="redis" broker={broker} consumers={consumers} />);
    expect(container.querySelector('[data-sub="C1"]')).toBeTruthy();
    const c1lost = container.querySelector('[data-lost="C1"]');
    expect(c1lost?.textContent).toContain('missed 2'); // C1 got only m0 of 3
    expect(container.querySelector('[data-lost="C2"]')?.textContent).toContain('missed 0');
  });

  test('renders nothing when the broker inspect is missing', () => {
    const { container } = render(<BrokerInternals mode="kafka" broker={undefined} consumers={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
