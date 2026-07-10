import { CATALOG } from './catalog';

export function Sidebar({
  activeId,
  onSelect,
}: {
  activeId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <nav
      aria-label="Chapters"
      className="hidden w-64 shrink-0 overflow-y-auto border-r border-line md:block"
    >
      <div className="px-4 py-6">
        <p className="mb-5 px-2 font-mono text-[11px] tracking-widest text-dim uppercase">Chapters</p>
        <div className="flex flex-col gap-6">
          {CATALOG.map((chapter) => (
            <div key={chapter.id}>
              <p className="mb-2 px-2 font-mono text-[11px] text-dim">{chapter.title}</p>
              <ul className="flex flex-col gap-0.5">
                {chapter.labs.map((lab) => {
                  const active = lab.id === activeId;
                  const disabled = lab.status !== 'active';
                  return (
                    <li key={lab.id}>
                      <button
                        type="button"
                        disabled={disabled}
                        aria-current={active ? 'page' : undefined}
                        onClick={() => onSelect(lab.id)}
                        className={[
                          'flex w-full items-center justify-between gap-2 rounded border-l-2 px-2.5 py-1.5 text-left font-mono text-sm transition-colors',
                          active
                            ? 'border-set bg-set/10 text-set'
                            : disabled
                              ? 'cursor-not-allowed border-transparent text-dim/50'
                              : 'border-transparent text-fg hover:bg-line/40',
                        ].join(' ')}
                      >
                        <span className="truncate">
                          <span className="text-dim">{lab.id}</span> {lab.label}
                        </span>
                        {lab.status !== 'active' && (
                          <span className="shrink-0 rounded border border-line px-1 font-mono text-[9px] tracking-wider text-dim uppercase">
                            soon
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </nav>
  );
}
