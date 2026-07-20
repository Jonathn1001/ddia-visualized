// src/ui/labs/load/Debrief.tsx
import DebriefContent from '../../../../content/ch01/debrief.mdx';
import { DebriefArticle } from '../../kit/DebriefArticle';
import { SurpriseJournal } from '../../kit/SurpriseJournal';

export function LoadDebrief() {
  return (
    <DebriefArticle>
      <DebriefContent />
      <SurpriseJournal storageKey="ddia:ch01:journal" />
    </DebriefArticle>
  );
}
