// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DerivedPanel } from './DerivedPanel';

afterEach(cleanup);

function setup(over: Partial<React.ComponentProps<typeof DerivedPanel>> = {}) {
  const props = {
    view: 'cache' as const,
    label: 'Cache',
    head: 5,
    offset: 3,
    paused: false,
    dedup: false,
    body: <div>contents</div>,
    onPause: vi.fn(),
    onWipe: vi.fn(),
    onRedeliver: vi.fn(),
    onToggleDedup: vi.fn(),
    ...over,
  };
  return { props, ...render(<DerivedPanel {...props} />) };
}

describe('DerivedPanel', () => {
  test('shows the view id, offset/head, and computed lag', () => {
    const { container } = setup({ head: 5, offset: 3 });
    const root = container.querySelector('[data-view="cache"]')!;
    expect(root).not.toBeNull();
    expect(root.getAttribute('data-offset')).toBe('3');
    expect(root.getAttribute('data-head')).toBe('5');
    expect(root.getAttribute('data-lag')).toBe('2');
  });
  test('marks a paused view', () => {
    const { container } = setup({ paused: true });
    expect(container.querySelector('[data-view="cache"]')!.getAttribute('data-paused')).toBe('true');
  });
  test('renders the body contents', () => {
    const { getByText } = setup();
    expect(getByText('contents')).not.toBeNull();
  });
  test('control buttons invoke their callbacks', () => {
    const { props, getByText } = setup();
    getByText('pause').click();
    getByText('wipe').click();
    getByText('redeliver').click();
    getByText(/dedup/i).click();
    expect(props.onPause).toHaveBeenCalled();
    expect(props.onWipe).toHaveBeenCalled();
    expect(props.onRedeliver).toHaveBeenCalled();
    expect(props.onToggleDedup).toHaveBeenCalled();
  });
  test('pause button reads "resume" when already paused', () => {
    const { getByText } = setup({ paused: true });
    expect(getByText('resume')).not.toBeNull();
  });
});
