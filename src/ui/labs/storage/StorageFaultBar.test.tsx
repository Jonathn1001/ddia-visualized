// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { StorageFaultBar } from './StorageFaultBar';

afterEach(cleanup);

test('each fault button fires its fault name', () => {
  const onFault = vi.fn();
  render(<StorageFaultBar onFault={onFault} />);
  fireEvent.click(screen.getByRole('button', { name: /crash mid-write/i }));
  expect(onFault).toHaveBeenCalledWith('crash-mid-write');
  fireEvent.click(screen.getByRole('button', { name: /disk full/i }));
  expect(onFault).toHaveBeenCalledWith('disk-full');
  fireEvent.click(screen.getByRole('button', { name: /recover/i }));
  expect(onFault).toHaveBeenCalledWith('recover');
});
