// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { LoadLab } from './LoadLab';

afterEach(cleanup);

describe('LoadLab', () => {
  test('renders the load control and the percentile panel', () => {
    const { getByLabelText, getByText } = render(<LoadLab />);
    expect(getByLabelText('load')).not.toBeNull();
    expect(getByText(/response time/i)).not.toBeNull();
  });

  test('renders the three challenge titles', () => {
    const { getByText } = render(<LoadLab />);
    expect(getByText(/the knee/i)).not.toBeNull();
    expect(getByText(/drives the tail/i)).not.toBeNull();
    expect(getByText(/amplification/i)).not.toBeNull();
  });

  test('exposes the add-replica control for the ship-gate rescue walk', () => {
    const { container } = render(<LoadLab />);
    expect(container.querySelector('[data-action="add-replica"]')).not.toBeNull();
    expect(container.querySelector('[data-action="lab-step"]')).not.toBeNull();
  });
});
