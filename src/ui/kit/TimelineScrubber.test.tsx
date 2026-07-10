// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TimelineScrubber } from './TimelineScrubber';

afterEach(cleanup);

test('scrub emits the target index; play/pause and step wired', () => {
  const onScrub = vi.fn();
  const onPlayPause = vi.fn();
  const onStep = vi.fn();
  const { container } = render(
    <TimelineScrubber
      processed={40}
      pending={10}
      running={false}
      onPlayPause={onPlayPause}
      onStep={onStep}
      onScrub={onScrub}
    />,
  );
  fireEvent.change(container.querySelector('input[type=range]')!, { target: { value: '12' } });
  expect(onScrub).toHaveBeenCalledWith(12);
  fireEvent.click(screen.getByText('play'));
  expect(onPlayPause).toHaveBeenCalled();
  fireEvent.click(screen.getByText('step'));
  expect(onStep).toHaveBeenCalled();
});

test('scrubbing disabled while running', () => {
  const { container } = render(
    <TimelineScrubber
      processed={5}
      pending={0}
      running={true}
      onPlayPause={() => undefined}
      onStep={() => undefined}
      onScrub={() => undefined}
    />,
  );
  expect((container.querySelector('input[type=range]') as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByText('pause')).toBeTruthy();
});
