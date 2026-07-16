// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import type { RaftInspect } from '../../../modules/raft';
import { RaftView } from './RaftView';

afterEach(cleanup);

const leader: RaftInspect = {
  id: 'N1',
  role: 'leader',
  term: 3,
  votedFor: 'N1',
  log: [
    { term: 1, value: 10, seq: 'N1:1' },
    { term: 2, value: 20, seq: 'N1:2' },
    { term: 3, value: 30, seq: 'N1:3' },
  ],
  commitIndex: 2,
  kv: 20,
  history: [],
};

const follower: RaftInspect = {
  id: 'N2',
  role: 'follower',
  term: 3,
  votedFor: 'N1',
  log: [
    { term: 1, value: 10, seq: 'N1:1' },
    { term: 2, value: 20, seq: 'N1:2' },
  ],
  commitIndex: 2,
  kv: 20,
  history: [],
};

test('renders one column per node with role and node data-attrs', () => {
  const { container } = render(<RaftView nodes={[leader, follower]} deadNodes={[]} />);
  const n1 = container.querySelector('[data-node="N1"]');
  const n2 = container.querySelector('[data-node="N2"]');
  expect(n1?.getAttribute('data-role')).toBe('leader');
  expect(n2?.getAttribute('data-role')).toBe('follower');
});

test('shows term, votedFor, and kv readout', () => {
  const { container } = render(<RaftView nodes={[leader]} deadNodes={[]} />);
  const n1 = container.querySelector('[data-node="N1"]');
  expect(n1?.textContent).toContain('3'); // term
  expect(n1?.textContent).toContain('N1'); // votedFor
  expect(n1?.textContent).toContain('20'); // kv
});

test('log entries render as boxes, committed vs not', () => {
  const { container } = render(<RaftView nodes={[leader]} deadNodes={[]} />);
  const entries = container.querySelectorAll('[data-node="N1"] [data-entry]');
  expect(entries).toHaveLength(3);
  expect(entries[0].textContent).toBe('t1:10');
  expect(entries[0].getAttribute('data-committed')).toBe('true');
  expect(entries[0].className).toContain('text-set');
  expect(entries[1].getAttribute('data-committed')).toBe('true');
  // third entry (index 2) is beyond commitIndex 2 → not committed
  expect(entries[2].getAttribute('data-committed')).toBeNull();
  expect(entries[2].className).toContain('text-dim');
  expect(entries[2].textContent).toBe('t3:30');
});

test('dead nodes are dimmed and flagged', () => {
  const { container } = render(<RaftView nodes={[leader, follower]} deadNodes={['N2']} />);
  const n1 = container.querySelector('[data-node="N1"]');
  const n2 = container.querySelector('[data-node="N2"]');
  expect(n1?.getAttribute('data-dead')).toBeNull();
  expect(n2?.getAttribute('data-dead')).toBe('true');
  expect(n2?.className).toContain('opacity-40');
});
