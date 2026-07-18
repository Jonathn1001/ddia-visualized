// src/ui/labs/unbundled/Debrief.tsx
import DebriefContent from '../../../../content/ch12/debrief.mdx';
import { DebriefArticle } from '../../kit/DebriefArticle';
import { SurpriseJournal } from '../../kit/SurpriseJournal';

export function UnbundledDebrief() {
  return (
    <DebriefArticle>
      <DebriefContent />
      <SurpriseJournal storageKey="ddia:ch12:journal" />
    </DebriefArticle>
  );
}
