// src/ui/labs/storage/StorageScoreboard.tsx
import type { ReactNode } from 'react';
import type { LsmInspect } from '../../../modules/lsm';
import type { BtreeInspect } from '../../../modules/btree';
import { writeAmp } from '../../../modules/storage-shared';

function Cell({ children, warn }: { children: ReactNode; warn?: boolean }) {
  return <td className={`px-3 py-1 text-right font-mono ${warn ? 'text-warn font-bold' : 'text-fg'}`}>{children}</td>;
}

export function StorageScoreboard({ lsm, btree }: { lsm: LsmInspect; btree: BtreeInspect }) {
  const lsmWA = writeAmp(lsm);
  const btWA = writeAmp(btree);
  const rows: [string, string, ReactNode, ReactNode][] = [
    ['disk-reads', 'disk reads (cum.)', lsm.diskReads, btree.diskReads],
    ['disk-writes', 'disk writes (cum.)', lsm.diskWrites, btree.diskWrites],
    ['write-amp', 'write-amp', <Cell key="l" warn={lsmWA > btWA}>{lsmWA}</Cell>, <Cell key="b">{btWA}</Cell>],
    ['read-amp', 'read-amp (last get)', lsm.lastReadCost, btree.lastReadCost],
    ['space-amp', 'space-amp / height', lsm.spaceAmp || '—', btree.height],
  ];
  return (
    <table className="rounded border border-line bg-panel text-xs">
      <thead>
        <tr className="text-dim">
          <th className="px-3 py-1 text-left">metric</th>
          <th className="px-3 py-1 text-right">LSM-tree</th>
          <th className="px-3 py-1 text-right">B-tree</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([id, label, l, b]) => (
          <tr key={id} data-metric={id} className="border-t border-line">
            <td className="px-3 py-1 text-left text-dim">{label}</td>
            {typeof l === 'object' ? l : <Cell>{l}</Cell>}
            {typeof b === 'object' ? b : <Cell>{b}</Cell>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
