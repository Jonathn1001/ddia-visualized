// src/ui/labs/storage/Debrief.tsx
import DebriefContent from '../../../../content/ch03/debrief.mdx';
import { DebriefArticle } from '../../kit/DebriefArticle';
import { SurpriseJournal } from '../../kit/SurpriseJournal';

export function StorageDebrief() {
  return (
    <DebriefArticle>
      <DebriefContent />
      <SurpriseJournal storageKey="ddia:ch03:journal" />
    </DebriefArticle>
  );
}
