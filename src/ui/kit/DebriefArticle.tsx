import type { ReactNode } from 'react';

/** Shared debrief typography wrapper — MDX content + journal render inside it. */
export function DebriefArticle({ children }: { children: ReactNode }) {
  return (
    <article className="max-w-xl space-y-4 [&_h1]:hidden [&_h2]:text-base [&_h2]:font-bold [&_h2]:text-fg [&_h2]:mt-4 [&_p]:text-sm [&_p]:text-dim [&_p]:leading-relaxed [&_li]:text-sm [&_li]:text-dim [&_ul]:list-disc [&_ul]:pl-5 [&_code]:text-warn [&_strong]:text-fg [&_em]:text-fg">
      {children}
    </article>
  );
}
