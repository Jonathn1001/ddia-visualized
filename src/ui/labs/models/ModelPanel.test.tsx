// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { ModelPanel } from './ModelPanel';
import type { ModelPanelInspect } from '../../../modules/models';

afterEach(cleanup);

const base: ModelPanelInspect = {
  cursor: 3,
  total: 6,
  done: false,
  roundTrips: 6,
  result: [],
  touched: ['bob'],
  migration: 0,
};

describe('ModelPanel', () => {
  test('document panel shows label, round-trip count, op-count', () => {
    const { getByText, container } = render(<ModelPanel model="document" label="Document" view={base} />);
    expect(getByText('Document')).not.toBeNull();
    expect(getByText(/round trip/i)).not.toBeNull();
    expect(container.querySelector('[data-model="document"]')).not.toBeNull();
    expect(container.querySelector('[data-round-trips="6"]')).not.toBeNull();
  });

  test('done panel shows the result set', () => {
    const { getByText } = render(
      <ModelPanel
        model="graph"
        label="Graph"
        view={{ ...base, done: true, cursor: 6, result: ['dan', 'eve', 'frank'], roundTrips: 1 }}
      />,
    );
    expect(getByText(/result:/)).not.toBeNull();
    expect(getByText(/dan, eve, frank/)).not.toBeNull();
  });

  test('shows migration cost when a field was added', () => {
    const { getByText } = render(
      <ModelPanel model="relational" label="Relational" view={{ ...base, migration: 6, roundTrips: 1 }} />,
    );
    expect(getByText(/migration/i)).not.toBeNull();
  });
});
