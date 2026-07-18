// src/ui/labs/batch/Debrief.tsx
import DebriefContent from '../../../../content/ch10/debrief.mdx';
import { DebriefArticle } from '../../kit/DebriefArticle';
import { SurpriseJournal } from '../../kit/SurpriseJournal';

export function BatchDebrief() {
  return (
    <DebriefArticle>
      <DebriefContent />
      <SurpriseJournal storageKey="ddia:ch10:journal" />
    </DebriefArticle>
  );
}
