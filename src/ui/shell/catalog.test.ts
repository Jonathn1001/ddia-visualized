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
