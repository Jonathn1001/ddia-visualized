// src/ui/labs/models/Debrief.tsx
import DebriefContent from '../../../../content/ch02/debrief.mdx';
import { DebriefArticle } from '../../kit/DebriefArticle';
import { SurpriseJournal } from '../../kit/SurpriseJournal';

export function ModelsDebrief() {
  return (
    <DebriefArticle>
      <DebriefContent />
      <SurpriseJournal storageKey="ddia:ch02:journal" />
    </DebriefArticle>
  );
}
