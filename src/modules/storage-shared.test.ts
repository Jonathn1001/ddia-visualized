import { expect, test } from 'vitest';
import {
  STORAGE_TOPOLOGY, LSM, BTREE, writeAmp, round2, bloomHashes, BLOOM_BITS,
} from './storage-shared';

test('topology is exactly the two engines', () => {
  expect(STORAGE_TOPOLOGY).toEqual([LSM, BTREE]);
});

test('writeAmp = bytesWritten / userBytes, rounded to 2dp; 0 when no user bytes', () => {
  expect(writeAmp({ diskReads: 0, diskWrites: 0, bytesWritten: 64, userBytes: 16 })).toBe(4);
  expect(writeAmp({ diskReads: 0, diskWrites: 0, bytesWritten: 20, userBytes: 16 })).toBe(1.25);
  expect(writeAmp({ diskReads: 0, diskWrites: 0, bytesWritten: 0, userBytes: 0 })).toBe(0);
});

test('round2 rounds half up to two decimals', () => {
  expect(round2(1.2349)).toBe(1.23);
  expect(round2(1.005)).toBe(1.01);
});

test('bloomHashes returns two in-range bit indices, deterministic', () => {
  const a = bloomHashes('k7');
  expect(a).toHaveLength(2);
  for (const i of a) {
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(BLOOM_BITS);
  }
  expect(bloomHashes('k7')).toEqual(a);
});
