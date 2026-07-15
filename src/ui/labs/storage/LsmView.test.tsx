// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { LsmView } from './LsmView';
import type { LsmInspect } from '../../../modules/lsm';

afterEach(cleanup);

const base: LsmInspect = {
  engine: 'lsm', memtable: [{ key: 'a', val: '1' }], sstables: [{ level: 0, entries: [{ key: 'b', val: '2' }], bloom: [1, 2], min: 'b', max: 'b' }],
  walLen: 1, phase: 'idle', diskReads: 0, diskWrites: 1, bytesWritten: 16, userBytes: 16, lastReadCost: 0, bloomSkips: 0, spaceAmp: 1, diskFull: false,
};

test('shows memtable fill and an L0 run', () => {
  const { container } = render(<LsmView inspect={base} />);
  expect(container.textContent).toMatch(/memtable/i);
  expect(container.textContent).toContain('L0');
  expect(container.textContent).toContain('1 keys'); // the L0 run's entry count
});

test('shows the current phase when not idle', () => {
  const { container } = render(<LsmView inspect={{ ...base, phase: 'compacting' }} />);
  expect(container.textContent).toMatch(/compacting/i);
});

test('flags a disk-full engine', () => {
  const { container } = render(<LsmView inspect={{ ...base, diskFull: true }} />);
  expect(container.textContent).toMatch(/disk full/i);
});
