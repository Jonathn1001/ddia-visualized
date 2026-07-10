// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { ClusterView } from './ClusterView';

afterEach(cleanup);

const nodes = [
  { id: 'a', dead: false, inspect: {} },
  { id: 'b', dead: true, inspect: {} },
  { id: 'c', dead: false, inspect: {} },
];

test('renders one circle per node plus one dot per in-flight message', () => {
  const inFlight = [{ from: 'a', target: 'b', sentAt: 0, deliverAt: 10, payload: null }];
  const { container } = render(<ClusterView nodes={nodes} inFlight={inFlight} time={5} />);
  expect(container.querySelectorAll('circle')).toHaveLength(4); // 3 nodes + 1 dot
});

test('node click reports the node id', () => {
  const onNodeClick = vi.fn();
  const { getByText } = render(<ClusterView nodes={nodes} inFlight={[]} time={0} onNodeClick={onNodeClick} />);
  fireEvent.click(getByText('a'));
  expect(onNodeClick).toHaveBeenCalledWith('a');
});
