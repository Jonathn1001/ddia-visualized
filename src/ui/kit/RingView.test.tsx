// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { RingView } from './RingView';

afterEach(cleanup);

const POOL = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

test('renders one tick per vnode, one dot per key, one load row per member', () => {
  const { container } = render(
    <RingView
      pool={POOL}
      members={['A', 'B', 'C']}
      vnodes={2}
      placements={[
        { key: 'k1', owner: 'A' },
        { key: 'k2', owner: 'A' },
        { key: 'k3', owner: 'B' },
      ]}
    />,
  );
  expect(container.querySelectorAll('[data-vnode]')).toHaveLength(6);
  expect(container.querySelectorAll('[data-key]')).toHaveLength(3);
  const rows = container.querySelectorAll('[data-load]');
  expect(rows).toHaveLength(3);
  expect(rows[0].textContent).toContain('A');
  expect(rows[0].textContent).toContain('2');
});

test('a key dot recolors when its owner changes (recolor-only migration)', () => {
  const { container, rerender } = render(
    <RingView pool={POOL} members={['A', 'B']} vnodes={1} placements={[{ key: 'k1', owner: 'A' }]} />,
  );
  const before = container.querySelector('[data-key="k1"]')!.getAttribute('fill');
  rerender(
    <RingView pool={POOL} members={['A', 'B']} vnodes={1} placements={[{ key: 'k1', owner: 'B' }]} />,
  );
  const after = container.querySelector('[data-key="k1"]')!.getAttribute('fill');
  expect(after).not.toBe(before);
});
