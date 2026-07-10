import { useState } from 'react';
import { PingPongLab } from './labs/pingpong/PingPongLab';
import { Debrief } from './labs/replication/Debrief';
import { ReplicationLab } from './labs/replication/ReplicationLab';

const TABS = ['replication', 'debrief', 'pingpong'] as const;
type Tab = (typeof TABS)[number];

export default function App() {
  const [tab, setTab] = useState<Tab>('replication');
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-6 space-y-6">
      <header className="flex items-baseline gap-6">
        <h1 className="text-2xl font-bold">DDIA Visualized</h1>
        <nav className="flex gap-2 text-sm">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-2 py-1 rounded ${tab === t ? 'bg-sky-700' : 'bg-slate-800 hover:bg-slate-700'}`}
            >
              {t}
            </button>
          ))}
        </nav>
      </header>
      {tab === 'replication' && <ReplicationLab />}
      {tab === 'debrief' && <Debrief />}
      {tab === 'pingpong' && <PingPongLab />}
    </main>
  );
}
