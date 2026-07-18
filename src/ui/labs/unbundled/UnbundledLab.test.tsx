// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { UnbundledLab } from './UnbundledLab';

afterEach(cleanup);

describe('UnbundledLab smoke', () => {
  test('mounts and renders the three derived panels + a run/step control', () => {
    const { container, getAllByText } = render(<UnbundledLab />);
    expect(container.querySelector('[data-view="search"]')).not.toBeNull();
    expect(container.querySelector('[data-view="cache"]')).not.toBeNull();
    expect(container.querySelector('[data-view="analytics"]')).not.toBeNull();
    // seed content is caught up on mount → cache panel shows a seeded key
    expect(container.textContent).toContain('p1');
    // a step control exists
    expect(getAllByText(/step|write/i).length).toBeGreaterThan(0);
  });
  test('three challenge panels render (predict-before-run)', () => {
    const { getAllByText } = render(<UnbundledLab />);
    expect(getAllByText(/start attempt/i).length).toBe(3);
  });
});
