// src/ui/labs/raft/Debrief.tsx
import DebriefContent from '../../../../content/ch09/debrief.mdx';
import { DebriefArticle } from '../../kit/DebriefArticle';
import { SurpriseJournal } from '../../kit/SurpriseJournal';

export function RaftDebrief() {
  return (
    <DebriefArticle>
      <DebriefContent />
      <SurpriseJournal storageKey="ddia:ch09:journal" />
    </DebriefArticle>
  );
}
