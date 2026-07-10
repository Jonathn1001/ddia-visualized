import DebriefContent from '../../../../content/ch05/debrief.mdx';
import { SurpriseJournal } from '../../kit/SurpriseJournal';

export function Debrief() {
  return (
    <article className="max-w-xl space-y-4 [&_h1]:text-xl [&_h1]:font-bold [&_h2]:text-base [&_h2]:font-bold [&_h2]:mt-4 [&_p]:text-sm [&_p]:text-slate-300 [&_li]:text-sm [&_li]:text-slate-300 [&_ul]:list-disc [&_ul]:pl-5 [&_code]:text-amber-300">
      <DebriefContent />
      <SurpriseJournal />
    </article>
  );
}
