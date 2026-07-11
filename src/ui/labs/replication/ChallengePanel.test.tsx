// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { Simulation, type NodeId } from '../../../engine';
import {
  detectStaleRead,
  replication,
  type RepPayload,
  type RepState,
} from '../../../modules/replication';
import { SimDriver } from '../../bridge/SimDriver';
import { useSimStore } from '../../bridge/simStore';
import { ChallengePanel } from '../../kit/ChallengePanel';

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

function statesOf(driver: ReturnType<typeof makeDriver>) {
  return new Map<NodeId, RepState>(
    driver.sim.config.nodeIds.map((id) => [id, driver.sim.getState(id)] as const),
  );
}

function renderPanel(driver: ReturnType<typeof makeDriver>) {
  return render(
    <ChallengePanel
      title="Chaos Challenge: produce a stale read"
      storageKeyPrefix="ddia:ch05:stale-read"
      prompt="Predict first: how will you cause a stale read? (skippable)"
      runningHint="make a read return older data than an acknowledged write."
      check={() => detectStaleRead(statesOf(driver))}
      onWin={() => driver.pause()}
      renderWin={(win, prediction) => (
        <>
          <p>
            read {win.read.key} @ {win.read.node} returned seq {win.read.returnedSeq}
          </p>
          <p>your prediction: “{prediction}”</p>
        </>
      )}
    />,
  );
}

beforeEach(() => {
  localStorage.clear();
  useSimStore.getState().reset();
});

test('prediction stored on attempt start; win detected and rendered with prediction', () => {
  const driver = makeDriver();
  renderPanel(driver);
  fireEvent.change(screen.getByPlaceholderText(/how will you cause/i), {
    target: { value: 'read follower before append arrives' },
  });
  fireEvent.click(screen.getByText('start attempt'));
  expect(localStorage.getItem('ddia:ch05:stale-read:prediction:1')).toBe(
    'read follower before append arrives',
  );

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

test('attempt counter increments in localStorage', () => {
  const driver = makeDriver();
  renderPanel(driver);
  fireEvent.click(screen.getByText('start attempt'));
  expect(localStorage.getItem('ddia:ch05:stale-read:attempt')).toBe('1');
});
