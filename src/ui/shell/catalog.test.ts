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

test('ch11 ships the broker lab + debrief, both active', () => {
  const ch11 = CATALOG.find((c) => c.id === 'ch11')!;
  expect(ch11.labs.map((l) => l.id)).toEqual(['11.1', '11.d']);
  expect(ch11.labs.every((l) => l.status === 'active')).toBe(true);
});
