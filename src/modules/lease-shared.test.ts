import { expect, test } from 'vitest';
import { LEASE_TOPOLOGY, LEASE_TTL, LOCK, STORE, W1, W2, WORK_TICKS, WRITE_EVERY } from './lease-shared';

test('topology is Lock, W1, W2, Store in render order', () => {
  expect(LEASE_TOPOLOGY).toEqual([LOCK, W1, W2, STORE]);
});

test('the working window is wide relative to the check period', () => {
  // The GC-pause challenge asks the user to pause a worker mid-work; keep the
  // window ≥ half the period so the timing is a lesson, not a twitch test.
  expect(WORK_TICKS * 2).toBeGreaterThanOrEqual(WRITE_EVERY);
  expect(LEASE_TTL).toBeGreaterThan(WRITE_EVERY + WORK_TICKS);
});
