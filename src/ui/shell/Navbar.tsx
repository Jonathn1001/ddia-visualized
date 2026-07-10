import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

function readTheme(): Theme {
  if (typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light') {
    return 'light';
  }
  return 'dark';
}

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('theme', theme);
    } catch {
      // storage may be unavailable (private mode); the in-page state still holds.
    }
  }, [theme]);

  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      className="flex h-7 w-7 items-center justify-center rounded border border-line text-dim transition-colors hover:bg-line/40 hover:text-fg"
    >
      {theme === 'dark' ? (
        // sun — click to go light
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
        </svg>
      ) : (
        // moon — click to go dark
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
    </button>
  );
}

export function Navbar() {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-line px-5">
      <div className="flex items-baseline gap-2.5">
        <span className="font-display text-sm font-bold text-fg">DDIA</span>
        <span className="font-mono text-xs tracking-widest text-dim uppercase">Visualized</span>
      </div>
      <div className="flex items-center gap-3 font-mono text-[11px] tracking-widest text-dim uppercase">
        <span className="hidden rounded border border-line px-2 py-0.5 text-set sm:inline">
          deterministic ✓
        </span>
        <ThemeToggle />
      </div>
    </header>
  );
}
