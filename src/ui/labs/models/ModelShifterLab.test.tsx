// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { ModelShifterLab } from './ModelShifterLab';

afterEach(cleanup);

describe('ModelShifterLab', () => {
  test('renders the three model panels', () => {
    const { container } = render(<ModelShifterLab />);
    expect(container.querySelector('[data-model="relational"]')).not.toBeNull();
    expect(container.querySelector('[data-model="document"]')).not.toBeNull();
    expect(container.querySelector('[data-model="graph"]')).not.toBeNull();
  });
  test('renders the three challenge titles', () => {
    const { getByText } = render(<ModelShifterLab />);
    expect(getByText(/friends-of-friends — the join tax/i)).not.toBeNull();
    expect(getByText(/many-to-many — documents can't join/i)).not.toBeNull();
    expect(getByText(/schema flexibility/i)).not.toBeNull();
  });
  test('exposes the scenario controls for the ship-gate walk', () => {
    const { container } = render(<ModelShifterLab />);
    expect(container.querySelector('[data-action="scenario-m2m"]')).not.toBeNull();
    expect(container.querySelector('[data-action="lab-step"]')).not.toBeNull();
  });
});
