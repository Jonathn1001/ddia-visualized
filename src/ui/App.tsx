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
import { HashRingDebrief } from './labs/hashring/Debrief';
import { BrokersLab } from './labs/brokers/BrokersLab';
import { BrokersDebrief } from './labs/brokers/Debrief';
import { ApiLab } from './labs/api/ApiLab';
import { ApiDebrief } from './labs/api/Debrief';
import { StorageLab } from './labs/storage/StorageLab';
import { StorageDebrief } from './labs/storage/Debrief';
import { TxnLab } from './labs/txn/TxnLab';
import { TxnDebrief } from './labs/txn/Debrief';
import { LeaseLab } from './labs/lease/LeaseLab';
import { LeaseDebrief } from './labs/lease/Debrief';
import { RaftLab } from './labs/raft/RaftLab';
import { RaftDebrief } from './labs/raft/Debrief';
import { BatchLab } from './labs/batch/BatchLab';
import { BatchDebrief } from './labs/batch/Debrief';
import { UnbundledLab } from './labs/unbundled/UnbundledLab';
import { UnbundledDebrief } from './labs/unbundled/Debrief';
import { LoadLab } from './labs/load/LoadLab';
import { LoadDebrief } from './labs/load/Debrief';
import { ModelShifterLab } from './labs/models/ModelShifterLab';
import { ModelsDebrief } from './labs/models/Debrief';

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
  '3.1': {
    eyebrow: 'Chapter 3 — Storage Engines',
    title: 'LSM-Tree vs B-Tree',
    thesis:
      'The same keys drive two engines at once. The LSM-tree buffers writes in memory and flushes sorted runs, paying later in compaction; the B-tree updates pages in place, paying up front in random writes. Watch write-amp, read-amp, and space-amp diverge — then crash them mid-write and see what the WAL saves.',
    Component: StorageLab,
  },
  '3.d': {
    eyebrow: 'Chapter 3 — Debrief',
    title: 'Why the numbers diverged',
    thesis:
      'Write-optimised vs read-optimised is not a slogan — it is the compaction bytes and the page traversals you just counted. Plus what durability actually cost.',
    Component: StorageDebrief,
  },
  '6.1': {
    eyebrow: 'Chapter 6 — Partitioning',
    title: 'Consistent Hashing Ring',
    thesis:
      'Keys and nodes hash onto the same circle; a key belongs to the first node clockwise. Add a node and only its arcs move — remove one and its keys slide to the successors. Naive hash-mod-N would reshuffle almost everything. Skew the ring until one node does double work.',
    Component: HashRingLab,
  },
  '6.d': {
    eyebrow: 'Chapter 6 — Debrief',
    title: 'Why so few keys moved',
    thesis:
      'The minimal-migration property you just used, the vnode dial real systems ship, and the hot key no partitioner can fix.',
    Component: HashRingDebrief,
  },
  '7.1': {
    eyebrow: 'Chapter 7 — Transactions',
    title: 'Isolation Anomaly Lab',
    thesis:
      'The same two-transaction schedule replays under four isolation levels at once. Watch a dirty read die at Read Committed, a lost update die at Snapshot Isolation, and write skew — the doctors-on-call problem — survive everything but serial execution.',
    Component: TxnLab,
  },
  '7.d': {
    eyebrow: 'Chapter 7 — Debrief',
    title: 'The isolation ladder',
    thesis:
      'Each level buys off exactly one class of race, and each rung costs more — aborts, queueing, throughput. Why "use transactions" is the start of the conversation, not the end.',
    Component: TxnDebrief,
  },
  '8.1': {
    eyebrow: 'Chapter 8 — The Trouble with Distributed Systems',
    title: 'Unreliable Network Playground',
    thesis:
      'A lease-based lock, two workers, a shared store — over a network that delays, drops and duplicates. GC-pause the lease holder and watch it corrupt the store from the past; turn on fencing tokens and watch the same write bounce; then do it again with nothing but a slow clock.',
    Component: LeaseLab,
  },
  '8.d': {
    eyebrow: 'Chapter 8 — Debrief',
    title: 'Timeouts, pauses, and the number that saves you',
    thesis:
      'Partial failure, process pauses, and untrustworthy clocks — why the check must travel with the act, and what a fencing token actually buys.',
    Component: LeaseDebrief,
  },
  '9.1': {
    eyebrow: 'Chapter 9 — Consistency & Consensus',
    title: 'Raft + Linearizability Checker',
    thesis:
      'Five nodes, one log. Elect, replicate, partition — the minority goes mute instead of wrong. Then catch a deposed leader lying to a client and prove it with a linearizability checker.',
    Component: RaftLab,
  },
  '9.d': {
    eyebrow: 'Chapter 9 — Debrief',
    title: 'The art of the majority',
    thesis:
      'Consensus is the art of the majority; linearizability is the promise your reads keep. What the checker saw, and the tricks real systems use to read fast without lying.',
    Component: RaftDebrief,
  },
  '10.1': {
    eyebrow: 'Chapter 10 — Batch Processing',
    title: 'MapReduce vs Dataflow',
    thesis:
      'The same URL-count job runs twice: a MapReduce engine that materializes every map output behind a hard stage barrier, and a dataflow engine that streams records straight to reducers. Healthy, the pipeline wins. Kill a worker mid-job and watch one side re-run a single task while the other starts over from the input.',
    Component: BatchLab,
  },
  '10.d': {
    eyebrow: 'Chapter 10 — Debrief',
    title: 'What you just broke',
    thesis:
      'Materialization buys cheap recovery; pipelining buys speed — and couples stages. What the barrier paid for, what the pipeline lost, and how Spark and Flink split the difference.',
    Component: BatchDebrief,
  },
  '11.1': {
    eyebrow: 'Chapter 11 — Stream Processing',
    title: 'Kafka: Replayable Log',
    thesis:
      'A partitioned append-only log. Consumers commit offsets periodically, so there is always a window of processed-but-uncommitted work. Kill a consumer inside it and the partition is reassigned and replayed from the last commit — the survivor reprocesses what the dead one already handled. Nothing is lost; some things happen twice. Make it twice.',
    Component: () => <BrokersLab mode="kafka" />,
  },
  '11.2': {
    eyebrow: 'Chapter 11 — Stream Processing',
    title: 'RabbitMQ: Destructive Queue',
    thesis:
      'A queue that deletes a message the instant it is acked — the anti-log. If the ack never comes, the ack timeout requeues the message and redelivers it to another consumer, flagged as a redelivery. Kill the holder of an unacked message and resurrect it on the survivor. Nothing is lost; a duplicate appears only if the ack was.',
    Component: () => <BrokersLab mode="rabbit" />,
  },
  '11.3': {
    eyebrow: 'Chapter 11 — Stream Processing',
    title: 'Redis: Pub/Sub Fan-Out',
    thesis:
      'The broker stores nothing. It fans each message out to every live subscriber and forgets it. A subscriber that is down misses the message forever; reviving it catches only future publishes. Kill a subscriber across a burst and lose those messages for good — at-most-once is a storage decision, not a delivery bug.',
    Component: () => <BrokersLab mode="redis" />,
  },
  '11.d': {
    eyebrow: 'Chapter 11 — Debrief',
    title: 'Storage decides delivery',
    thesis:
      'Why the same workload duplicated, redelivered, and vanished across three brokers — and why exactly-once is something you build on top, never something the broker hands you.',
    Component: BrokersDebrief,
  },
  '12.1': {
    eyebrow: 'Chapter 12 — The Future of Data Systems',
    title: 'Unbundled Database',
    thesis:
      'One write lands in an append-only log, then fans out to a search index, a cache, and an analytics counter — each consuming the log at its own pace. Pause a view and write, and its query lies by omission; wipe a view and the log rebuilds it byte-for-byte; redeliver a record and watch the counter double unless you dedup on the offset. Derived data is a disposable projection of the log.',
    Component: UnbundledLab,
  },
  '12.d': {
    eyebrow: 'Chapter 12 — Debrief',
    title: 'The log is the source of truth',
    thesis:
      'Why every derived view lags, why you can throw any of them away, and where exactly-once actually lives — at the endpoint, keyed on the offset.',
    Component: UnbundledDebrief,
  },
  '1.1': {
    eyebrow: 'Chapter 1 — Scalability',
    title: 'Load Simulator',
    thesis:
      'Requests pour into a service tier modelled as an M/M/c queue. Drag the load up and the median barely moves while p99 detonates near capacity — the knee. Add a replica or a cache to drain the queue and rescue the tail; turn service-time variance on to watch p99 pull away from p50 with no queue at all; fan one request out to twenty backend calls and watch the median user inherit the backend tail. Averages lie; percentiles tell the truth.',
    Component: LoadLab,
  },
  '1.d': {
    eyebrow: 'Chapter 1 — Debrief',
    title: 'Averages lie; the tail is the number',
    thesis:
      'Why p99 breaks suddenly near capacity, why variance and fan-out make the tail worse, and where Reliability and Maintainability fit — the two pillars this lab left as prose.',
    Component: LoadDebrief,
  },
  '2.1': {
    eyebrow: 'Chapter 2 — Data Models',
    title: 'Model Shape-Shifter',
    thesis:
      'One social graph stored three ways — relational tables, denormalized documents, a graph — runs the same query in all three, animated step-by-step with a live round-trip count. Friends-of-friends returns the same people everywhere, but the document model pays the N+1 join tax (a fetch per friend) while the graph traverses in one query. Switch to a many-to-many query and the document model hurts more; add a field and watch schema-on-read take it free while the relational table migrates every row.',
    Component: ModelShifterLab,
  },
  '2.d': {
    eyebrow: 'Chapter 2 — Debrief',
    title: 'The model decides which questions are cheap',
    thesis:
      'Relational vs document vs graph: locality vs joins, many-to-many as a first-class edge, schema-on-read vs schema-on-write, and why most real stacks end up polyglot.',
    Component: ModelsDebrief,
  },
  '4.1': {
    eyebrow: 'Chapter 4 — Encoding & Evolution',
    title: 'REST: Resources, One at a Time',
    thesis:
      'To render a profile the client fetches the user, learns its post ids, then fetches each post separately — the N+1 problem: 1 + N round trips and a verbose JSON envelope per resource. The upside is graceful degradation: drop one request and the page still renders without that post. Crank the drop rate and make a partial page.',
    Component: () => <ApiLab mode="rest" />,
  },
  '4.2': {
    eyebrow: 'Chapter 4 — Encoding & Evolution',
    title: 'GraphQL: One Query, Exact Shape',
    thesis:
      'One query describes the whole graph; the server returns one exact-shape document in a single round trip — no over-fetch, no under-fetch. But the N+1 only moved server-side into the resolvers, and one request is one failure point: drop it and the whole page is gone. Make it fail all-or-nothing.',
    Component: () => <ApiLab mode="graphql" />,
  },
  '4.3': {
    eyebrow: 'Chapter 4 — Encoding & Evolution',
    title: 'gRPC: Binary, Built to Evolve',
    thesis:
      'One RPC returns a compact binary protobuf message — far fewer bytes than JSON. Fields are identified by number, not name, so a v2 server that adds a field is decoded fine by a v1 client, which skips the tag it does not recognize. Bump the schema and watch the old client keep working.',
    Component: () => <ApiLab mode="grpc" />,
  },
  '4.d': {
    eyebrow: 'Chapter 4 — Debrief',
    title: 'No free lunch in API styles',
    thesis:
      'Round trips, payload size, failure granularity, evolvability — the four dials REST, GraphQL, and gRPC each set differently, and why the right choice is the trade that fits your clients and your network.',
    Component: ApiDebrief,
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
