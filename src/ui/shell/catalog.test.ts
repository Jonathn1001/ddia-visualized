import { expect, test } from 'vitest';
import { CATALOG } from './catalog';

test('catalog follows book-chapter order, engine demo pinned first', () => {
  expect(CATALOG.map((c) => c.id)).toEqual([
    'ch0',
    'ch1',
    'ch2',
    'ch3',
    'ch4',
    'ch5',
    'ch6',
    'ch7',
    'ch8',
    'ch9',
    'ch10',
    'ch11',
    'ch12',
  ]);
});

test('ch1 ships the load simulator + debrief, all active', () => {
  const ch1 = CATALOG.find((c) => c.id === 'ch1')!;
  expect(ch1.labs.map((l) => l.id)).toEqual(['1.1', '1.d']);
  expect(ch1.labs.every((l) => l.status === 'active')).toBe(true);
});

test('ch2 ships the model shape-shifter + debrief, all active', () => {
  const ch2 = CATALOG.find((c) => c.id === 'ch2')!;
  expect(ch2.labs.map((l) => l.id)).toEqual(['2.1', '2.d']);
  expect(ch2.labs.every((l) => l.status === 'active')).toBe(true);
});

test('ch4 ships three API-style flows + debrief, all active', () => {
  const ch4 = CATALOG.find((c) => c.id === 'ch4')!;
  expect(ch4.labs.map((l) => l.id)).toEqual(['4.1', '4.2', '4.3', '4.d']);
  expect(ch4.labs.every((l) => l.status === 'active')).toBe(true);
});

test('ch11 ships three broker flows + debrief, all active', () => {
  const ch11 = CATALOG.find((c) => c.id === 'ch11')!;
  expect(ch11.labs.map((l) => l.id)).toEqual(['11.1', '11.2', '11.3', '11.d']);
  expect(ch11.labs.every((l) => l.status === 'active')).toBe(true);
});

test('ch10 ships the twin batch lab + debrief, all active', () => {
  const ch10 = CATALOG.find((c) => c.id === 'ch10')!;
  expect(ch10.labs.map((l) => l.id)).toEqual(['10.1', '10.d']);
  expect(ch10.labs.every((l) => l.status === 'active')).toBe(true);
});

test('ch12 ships the unbundled-database lab + debrief, all active', () => {
  const ch12 = CATALOG.find((c) => c.id === 'ch12')!;
  expect(ch12.labs.map((l) => l.id)).toEqual(['12.1', '12.d']);
  expect(ch12.labs.every((l) => l.status === 'active')).toBe(true);
});
