// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { BtreeView } from './BtreeView';
import type { BtreeInspect } from '../../../modules/btree';

afterEach(cleanup);

const base: BtreeInspect = {
  engine: 'btree',
  pages: [
    { id: 'p2', leaf: false, keys: ['k2'], vals: [], children: ['p0', 'p1'] },
    { id: 'p0', leaf: true, keys: ['k0', 'k1'], vals: ['0', '1'], children: [] },
    { id: 'p1', leaf: true, keys: ['k2', 'k3'], vals: ['2', '3'], children: [] },
  ],
  rootId: 'p2', height: 2, walLen: 4, phase: 'idle', diskReads: 0, diskWrites: 6, bytesWritten: 40, userBytes: 32, lastReadCost: 2, diskFull: false,
};

test('renders height, the root index, and leaf keys', () => {
  const { container } = render(<BtreeView inspect={base} />);
  expect(container.textContent).toMatch(/height 2/i);
  expect(container.textContent).toContain('root [k2]'); // index separator
  expect(container.textContent).toContain('k0');
  expect(container.textContent).toContain('k3');
});

test('strikes through a tombstoned key in a leaf', () => {
  const withTomb: BtreeInspect = {
    ...base,
    pages: base.pages.map((p) => (p.id === 'p0' ? { ...p, vals: ['0', null] } : p)),
  };
  const { container } = render(<BtreeView inspect={withTomb} />);
  expect(container.querySelector('s')?.textContent).toBe('k1'); // deleted key rendered struck-through
});
