import { expect, test } from 'vitest';
import { CATALOG } from './catalog';

test('catalog follows the DESIGN_PLAN §9 phase order', () => {
  // Phase 0 → Ch5 (P1) → Ch3 (P2) → Ch6,8,9 (P3) → Ch7 (P4) → Ch1,2,4,10,11,12 (P5)
  expect(CATALOG.map((c) => c.id)).toEqual([
    'ch0',
    'ch5',
    'ch3',
    'ch6',
    'ch8',
    'ch9',
    'ch7',
    'ch1',
    'ch2',
    'ch4',
    'ch10',
    'ch11',
    'ch12',
  ]);
});
