// src/ui/labs/txn/Debrief.tsx
import DebriefContent from '../../../../content/ch07/debrief.mdx';
import { DebriefArticle } from '../../kit/DebriefArticle';
import { SurpriseJournal } from '../../kit/SurpriseJournal';

export function TxnDebrief() {
  return (
    <DebriefArticle>
      <DebriefContent />
      <SurpriseJournal storageKey="ddia:ch07:journal" />
    </DebriefArticle>
  );
}
