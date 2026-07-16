// src/ui/labs/lease/Debrief.tsx
import DebriefContent from '../../../../content/ch08/debrief.mdx';
import { DebriefArticle } from '../../kit/DebriefArticle';
import { SurpriseJournal } from '../../kit/SurpriseJournal';

export function LeaseDebrief() {
  return (
    <DebriefArticle>
      <DebriefContent />
      <SurpriseJournal storageKey="ddia:ch08:journal" />
    </DebriefArticle>
  );
}
