import { useState } from 'react';

/** Active-recall journal: what surprised you? Persists locally; exported with the session. */
export function SurpriseJournal({ storageKey = 'ddia:ch05:journal' }: { storageKey?: string } = {}) {
  const [text, setText] = useState(() => localStorage.getItem(storageKey) ?? '');
  return (
    <label className="block space-y-1">
      <span className="text-xs font-bold text-fg">What surprised you?</span>
      <textarea
        className="w-full bg-ink border border-line rounded p-2 text-xs font-mono text-fg"
        rows={4}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          localStorage.setItem(storageKey, e.target.value);
        }}
      />
    </label>
  );
}
