import { expect, test } from 'vitest';
import { EventQueue, type SimEvent } from './events';

const ev = (time: number, seq: number, payload: unknown): SimEvent => ({
  time,
  seq,
  target: 'a',
  kind: 'message',
  payload,
});

test('pops events in virtual-time order', () => {
  const q = new EventQueue();
  q.push(ev(30, 0, 'c'));
  q.push(ev(10, 1, 'a'));
  q.push(ev(20, 2, 'b'));
  expect(q.pop()!.payload).toBe('a');
  expect(q.pop()!.payload).toBe('b');
  expect(q.pop()!.payload).toBe('c');
  expect(q.pop()).toBeUndefined();
});

test('equal timestamps break ties by seq (FIFO)', () => {
  const q = new EventQueue();
  q.push(ev(5, 0, 'first'));
  q.push(ev(5, 1, 'second'));
  q.push(ev(1, 2, 'early'));
  expect(q.pop()!.payload).toBe('early');
  expect(q.pop()!.payload).toBe('first');
  expect(q.pop()!.payload).toBe('second');
});

test('peek returns the minimum without removing it', () => {
  const q = new EventQueue();
  expect(q.peek()).toBeUndefined();
  q.push(ev(9, 0, 'x'));
  q.push(ev(3, 1, 'y'));
  expect(q.peek()!.payload).toBe('y');
  expect(q.size).toBe(2);
});

test('interleaved push/pop keeps ordering', () => {
  const q = new EventQueue();
  q.push(ev(4, 0, 4));
  q.push(ev(1, 1, 1));
  expect(q.pop()!.payload).toBe(1);
  q.push(ev(2, 2, 2));
  q.push(ev(3, 3, 3));
  expect(q.pop()!.payload).toBe(2);
  expect(q.pop()!.payload).toBe(3);
  expect(q.pop()!.payload).toBe(4);
});

test('toArray/loadFrom round-trips the queue', () => {
  const q = new EventQueue();
  for (const [t, s] of [[5, 0], [1, 1], [3, 2], [1, 3]] as const) q.push(ev(t, s, `${t}:${s}`));
  const copy = new EventQueue();
  copy.loadFrom(q.toArray());
  const drain = (queue: EventQueue) => {
    const out: unknown[] = [];
    for (let e = queue.pop(); e; e = queue.pop()) out.push(e.payload);
    return out;
  };
  expect(drain(copy)).toEqual(['1:1', '1:3', '3:2', '5:0']);
});
