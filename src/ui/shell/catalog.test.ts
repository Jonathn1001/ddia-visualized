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
