// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { StorageScoreboard } from './StorageScoreboard';
import type { LsmInspect } from '../../../modules/lsm';
import type { BtreeInspect } from '../../../modules/btree';

afterEach(cleanup);

const lsm: LsmInspect = {
  engine: 'lsm', memtable: [], sstables: [], walLen: 0, phase: 'idle',
  diskReads: 3, diskWrites: 10, bytesWritten: 64, userBytes: 16, lastReadCost: 2, bloomSkips: 1, spaceAmp: 3.5, diskFull: false,
};
const btree: BtreeInspect = {
  engine: 'btree', pages: [], rootId: 'p0', height: 2, walLen: 0, phase: 'idle',
  diskReads: 2, diskWrites: 4, bytesWritten: 18, userBytes: 16, lastReadCost: 2, diskFull: false,
};

test('renders both engines and the write-amp contrast', () => {
  const { container } = render(<StorageScoreboard lsm={lsm} btree={btree} />);
  expect(container.textContent).toContain('LSM-tree');
  expect(container.textContent).toContain('B-tree');
  const wa = container.querySelector('[data-metric="write-amp"]')!;
  expect(wa.textContent).toContain('4'); // lsm write-amp 64/16
  expect(wa.textContent).toContain('1.13'); // btree write-amp 18/16
  expect(wa.querySelector('.text-warn')).toBeTruthy(); // LSM's higher write-amp is warned
  expect(container.querySelector('[data-metric="space-amp"]')?.textContent).toContain('3.5'); // flows from LsmInspect.spaceAmp
});
