// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { Simulation } from '../../../engine';
import { replication, type RepPayload, type RepState } from '../../../modules/replication';
import { SimDriver } from '../../bridge/SimDriver';
import { useSimStore } from '../../bridge/simStore';
import { ChallengePanel } from './ChallengePanel';

afterEach(cleanup);

function makeDriver() {
  const sim = new Simulation<RepState, RepPayload>({
    module: replication,
    config: { nodeIds: ['L', 'F1', 'F2'], params: { mode: 'async' } },
    seed: 5,
    network: { latency: [10, 80] },
  });
  return new SimDriver<RepState, RepPayload>({
    sim,
    seed: 5,
    publish: (v) => useSimStore.getState().publish(v),
    raf: () => 0,
    caf: () => undefined,
  });
}

beforeEach(() => {
  localStorage.clear();
  useSimStore.getState().reset();
});

test('prediction is stored on attempt start and win detected on stale read', () => {
  const driver = makeDriver();
  render(<ChallengePanel driver={driver} />);
  fireEvent.change(screen.getByPlaceholderText(/how will you cause/i), {
    target: { value: 'read follower before append arrives' },
  });
  fireEvent.click(screen.getByText('start attempt'));
  expect(localStorage.getItem('ddia:ch05:stale-read:prediction:1')).toBe('read follower before append arrives');

  act(() => {
    driver.stepOnce(); // init L
    driver.stepOnce(); // init F1
    driver.stepOnce(); // init F2
    driver.external('L', { cmd: 'write', key: 'x', value: '1' });
    driver.stepOnce(); // leader applies + acks (async)
    driver.external('F1', { cmd: 'read', key: 'x' }); // stale
    driver.stepOnce();
  });
  expect(screen.getByText(/challenge complete/i)).toBeTruthy();
  expect(screen.getByText(/read follower before append arrives/)).toBeTruthy();
});

test('attempt counter increments across attempts', () => {
  const driver = makeDriver();
  render(<ChallengePanel driver={driver} />);
  fireEvent.click(screen.getByText('start attempt'));
  expect(localStorage.getItem('ddia:ch05:stale-read:attempt')).toBe('1');
});
