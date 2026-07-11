import { useState } from 'react';
import type { ReactNode } from 'react';
import { Navbar } from './shell/Navbar';
import { Sidebar } from './shell/Sidebar';
import { ACTIVE_LAB_ID } from './shell/catalog';
import { PingPongLab } from './labs/pingpong/PingPongLab';
import { Debrief } from './labs/replication/Debrief';
import { ReplicationLab } from './labs/replication/ReplicationLab';
import { MultiLeaderLab } from './labs/multileader/MultiLeaderLab';
import { LeaderlessLab } from './labs/leaderless/LeaderlessLab';
import { HashRingLab } from './labs/hashring/HashRingLab';

interface Page {
  eyebrow: string;
  title: string;
  thesis: ReactNode;
  body: ReactNode;
}

const PAGES: Record<string, Omit<Page, 'body'> & { Component: () => ReactNode }> = {
  '5.1': {
    eyebrow: 'Chapter 5 — Replication',
    title: 'Replication Theater',
    thesis:
      'A leader and two followers. In async mode the leader acknowledges writes it has not replicated yet — the ack is a promise it may not keep. Slow the network down, read from a follower, and catch the lie yourself.',
    Component: ReplicationLab,
  },
  '5.2': {
    eyebrow: 'Chapter 5 — Replication',
    title: 'Multi-Leader: Write Conflicts',
    thesis:
      'Two datacenters, both accepting writes, replicating to each other asynchronously. Concurrent writes to the same key conflict; last-write-wins resolves them by silently throwing one away — even one that was already acknowledged. Make it happen.',
    Component: MultiLeaderLab,
  },
  '5.3': {
    eyebrow: 'Chapter 5 — Replication',
    title: 'Leaderless: Quorum Reads & Writes',
    thesis:
      'No leader — any node coordinates. Writes succeed at w of 3 home replicas, reads consult r; w+r>n guarantees overlap. Sloppy quorum trades that guarantee for availability: hints on fallback nodes count toward w, and a hint that dies before handoff takes an acknowledged write with it.',
    Component: LeaderlessLab,
  },
  '5.d': {
    eyebrow: 'Chapter 5 — Debrief',
    title: 'What you just broke',
    thesis:
      'The trade-off behind the stale read you produced, what real systems do about it, and a journal for what surprised you.',
    Component: Debrief,
  },
  '0.1': {
    eyebrow: 'Phase 0 — Engine Demo',
    title: 'Ping-Pong Token Ring',
    thesis:
      'Three nodes pass an incrementing token with retransmission. The module that validated the SimModule contract — kill a node and watch the ring heal when you revive it.',
    Component: PingPongLab,
  },
  '6.1': {
    eyebrow: 'Chapter 6 — Partitioning',
    title: 'Consistent Hashing Ring',
    thesis:
      'Keys and nodes hash onto the same circle; a key belongs to the first node clockwise. Add a node and only its arcs move — remove one and its keys slide to the successors. Naive hash-mod-N would reshuffle almost everything. Skew the ring until one node does double work.',
    Component: HashRingLab,
  },
};

function resolvePage(id: string): Page {
  const view = PAGES[id] ?? PAGES[ACTIVE_LAB_ID]!;
  return { eyebrow: view.eyebrow, title: view.title, thesis: view.thesis, body: <view.Component /> };
}

export default function App() {
  const [activeId, setActiveId] = useState(ACTIVE_LAB_ID);
  const page = resolvePage(activeId);

  return (
    <div className="flex h-screen flex-col bg-ink">
      <Navbar />
      <div className="flex min-h-0 flex-1">
        <Sidebar activeId={activeId} onSelect={setActiveId} />
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="px-6 py-8 sm:px-10">
            <header className="mb-8">
              <p className="mb-3 font-mono text-[11px] tracking-[0.25em] text-dim uppercase">
                {page.eyebrow}
              </p>
              <h1 className="font-display text-2xl font-bold text-fg sm:text-3xl">{page.title}</h1>
              <p className="mt-4 max-w-2xl font-mono text-sm leading-relaxed text-dim">{page.thesis}</p>
            </header>
            {page.body}
          </div>
        </main>
      </div>
    </div>
  );
}
