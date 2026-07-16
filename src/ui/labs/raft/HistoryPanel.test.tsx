// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import type { HistoryRow } from '../../../modules/raft-shared';
import { HistoryPanel } from './HistoryPanel';

afterEach(cleanup);

const rows: HistoryRow[] = [
  { id: 'N1:1', node: 'N1', op: 'write', value: 1, invokedAt: 0, respondedAt: 5, outcome: 'ok', index: 1, seq: 'N1:1' },
  { id: 'N2:1', node: 'N2', op: 'read', value: 1, invokedAt: 6, respondedAt: 6, outcome: 'ok' },
  { id: 'N3:1', node: 'N3', op: 'write', value: 2, invokedAt: 7, respondedAt: null, outcome: 'pending', index: 2, seq: 'N3:1' },
  { id: 'N1:2', node: 'N1', op: 'write', value: 3, invokedAt: 8, respondedAt: 8, outcome: 'lost', index: 3, seq: 'N1:2' },
  { id: 'N2:2', node: 'N2', op: 'read', value: null, invokedAt: 9, respondedAt: 9, outcome: 'redirect' },
];

test('renders one row per history entry with outcome data-attrs and classes', () => {
  const { container } = render(<HistoryPanel rows={rows} verdict={null} onCheck={() => undefined} capped={false} />);
  const hrows = container.querySelectorAll('[data-hrow]');
  expect(hrows).toHaveLength(5);
  const ok = container.querySelector('[data-outcome="ok"]');
  const pending = container.querySelector('[data-outcome="pending"]');
  const lost = container.querySelector('[data-outcome="lost"]');
  const redirect = container.querySelector('[data-outcome="redirect"]');
  expect(ok?.className).toContain('text-set');
  expect(pending?.className).toContain('text-warn');
  expect(lost?.className).toContain('text-sign');
  expect(redirect?.className).toContain('text-dim');
});

test('violation verdict highlights the culprit row among the ok-outcome rows', () => {
  // okRows = [rows[0] (N1:1 write), rows[1] (N2:1 read)] — culprit index 1 → rows[1]
  const { container } = render(
    <HistoryPanel rows={rows} verdict={{ verdict: 'violation', culprit: 1 }} onCheck={() => undefined} capped={false} />,
  );
  const culprit = container.querySelector('[data-culprit="true"]');
  expect(culprit?.getAttribute('data-outcome')).toBe('ok');
  expect(culprit?.textContent).toContain('N2');
  expect(container.querySelectorAll('[data-culprit="true"]')).toHaveLength(1);
  const verdictLine = container.querySelector('[data-verdict]');
  expect(verdictLine?.getAttribute('data-verdict')).toBe('violation');
});

test('ok and too-long verdicts render their own data-verdict line, no culprit', () => {
  const { container: c1 } = render(
    <HistoryPanel rows={rows} verdict={{ verdict: 'ok' }} onCheck={() => undefined} capped={false} />,
  );
  expect(c1.querySelector('[data-verdict]')?.getAttribute('data-verdict')).toBe('ok');
  expect(c1.querySelector('[data-culprit="true"]')).toBeNull();

  const { container: c2 } = render(
    <HistoryPanel rows={rows} verdict={{ verdict: 'too-long' }} onCheck={() => undefined} capped={false} />,
  );
  expect(c2.querySelector('[data-verdict]')?.getAttribute('data-verdict')).toBe('too-long');
});

test('check button disabled when capped, enabled otherwise, and shows explanatory copy', () => {
  const { container } = render(<HistoryPanel rows={rows} verdict={null} onCheck={() => undefined} capped={true} />);
  const btn = container.querySelector('[data-action="check"]') as HTMLButtonElement;
  expect(btn.disabled).toBe(true);
  expect(container.textContent).toMatch(/too long|cap/i);

  const { container: c2 } = render(<HistoryPanel rows={rows} verdict={null} onCheck={() => undefined} capped={false} />);
  const btn2 = c2.querySelector('[data-action="check"]') as HTMLButtonElement;
  expect(btn2.disabled).toBe(false);
});

test('onCheck fires when the check button is clicked', () => {
  let fired = 0;
  const { container } = render(<HistoryPanel rows={rows} verdict={null} onCheck={() => (fired += 1)} capped={false} />);
  fireEvent.click(container.querySelector('[data-action="check"]') as HTMLButtonElement);
  expect(fired).toBe(1);
});
