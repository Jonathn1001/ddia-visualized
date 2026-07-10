import { useState } from 'react';

const KEY = 'ddia:ch05:journal';

/** Active-recall journal: what surprised you? Persists locally; exported with the session. */
export function SurpriseJournal() {
  const [text, setText] = useState(() => localStorage.getItem(KEY) ?? '');
  return (
    <label className="block space-y-1">
      <span className="text-xs font-bold text-fg">What surprised you?</span>
      <textarea
        className="w-full bg-ink border border-line rounded p-2 text-xs font-mono text-fg"
        rows={4}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          localStorage.setItem(KEY, e.target.value);
        }}
      />
    </label>
  );
}
