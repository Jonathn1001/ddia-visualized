// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { SurpriseJournal } from './SurpriseJournal';

afterEach(cleanup);
beforeEach(() => localStorage.clear());

test('journal persists to localStorage and reloads', () => {
  const { container, unmount } = render(<SurpriseJournal />);
  fireEvent.change(container.querySelector('textarea')!, { target: { value: 'async ack lies to you' } });
  expect(localStorage.getItem('ddia:ch05:journal')).toBe('async ack lies to you');
  unmount();
  const second = render(<SurpriseJournal />);
  expect((second.container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('async ack lies to you');
});
