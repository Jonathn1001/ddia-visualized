import { expect, test } from 'vitest';
import { Simulation } from './sim';
import { pingPong, type PPPayload, type PPState } from '../modules/pingpong';

function makeSim(): Simulation<PPState, PPPayload> {
  return new Simulation({ module: pingPong, config: { nodeIds: ['a', 'b', 'c'] }, seed: 7 });
}

test('inFlight lists undelivered messages with send/deliver times', () => {
  const sim = makeSim();
  sim.runSteps(3); // three init events; starter 'a' sent token 1 to 'b'
  const inf = sim.inFlight();
  expect(inf).toHaveLength(1); // the retransmit timer is NOT in the list
  expect(inf[0]).toMatchObject({ from: 'a', target: 'b', sentAt: 0 });
  expect(inf[0].deliverAt).toBeGreaterThanOrEqual(1);
  expect(inf[0].payload).toEqual({ token: 1 });
});

test('inFlight advances as messages deliver', () => {
  const sim = makeSim();
  sim.runSteps(4); // inits + deliver token1 to b -> b sends token2 to c
  expect(sim.inFlight().some((m) => m.from === 'b' && m.target === 'c')).toBe(true);
});

test('inFlight returns deep copies — mutating a payload does not corrupt the sim', () => {
  const sim = makeSim();
  sim.runSteps(3);
  const inf = sim.inFlight();
  (inf[0].payload as { token: number }).token = 999;
  expect((sim.inFlight()[0].payload as { token: number }).token).toBe(1);
});

test('inFlight is sorted by deliverAt', () => {
  const sim = makeSim();
  sim.runSteps(6);
  const times = sim.inFlight().map((m) => m.deliverAt);
  expect(times).toEqual([...times].sort((x, y) => x - y));
});
