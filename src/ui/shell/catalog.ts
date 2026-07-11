/**
 * The reader's map: the DDIA roadmap, chapter by chapter (DESIGN_PLAN §4/§7).
 * Lab ids are book-chapter aligned (`<chapter>.<n>`).
 *
 * status:
 *   'active' — shipped, interactive
 *   'soon'   — on the committed roadmap (Phases 2-5)
 */

export type LabStatus = 'active' | 'soon';

export interface LabEntry {
  id: string;
  label: string;
  status: LabStatus;
}

export interface Chapter {
  id: string;
  title: string;
  labs: LabEntry[];
}

export const ACTIVE_LAB_ID = '5.1';

export const CATALOG: Chapter[] = [
  {
    id: 'ch0',
    title: 'Phase 0 — Engine Demo',
    labs: [{ id: '0.1', label: 'Ping-Pong Token Ring', status: 'active' }],
  },
  {
    id: 'ch5',
    title: 'Ch.5 — Replication',
    labs: [
      { id: '5.1', label: 'Replication Theater', status: 'active' },
      { id: '5.2', label: 'Multi-Leader Conflicts', status: 'active' },
      { id: '5.3', label: 'Leaderless Quorum', status: 'active' },
      { id: '5.d', label: 'Debrief & Journal', status: 'active' },
    ],
  },
  {
    id: 'ch3',
    title: 'Ch.3 — Storage Engines',
    labs: [{ id: '3.1', label: 'LSM-Tree vs B-Tree', status: 'soon' }],
  },
  {
    id: 'ch6',
    title: 'Ch.6 — Partitioning',
    labs: [{ id: '6.1', label: 'Consistent Hashing Ring', status: 'soon' }],
  },
  {
    id: 'ch8',
    title: 'Ch.8 — Distributed Trouble',
    labs: [{ id: '8.1', label: 'Unreliable Network Playground', status: 'soon' }],
  },
  {
    id: 'ch9',
    title: 'Ch.9 — Consistency & Consensus',
    labs: [{ id: '9.1', label: 'Raft + Linearizability Checker', status: 'soon' }],
  },
  {
    id: 'ch7',
    title: 'Ch.7 — Transactions',
    labs: [{ id: '7.1', label: 'Isolation Anomaly Lab', status: 'soon' }],
  },
  {
    id: 'ch1',
    title: 'Ch.1 — Reliable, Scalable, Maintainable',
    labs: [{ id: '1.1', label: 'Load Simulator', status: 'soon' }],
  },
  {
    id: 'ch2',
    title: 'Ch.2 — Data Models',
    labs: [{ id: '2.1', label: 'Model Shape-Shifter', status: 'soon' }],
  },
  {
    id: 'ch4',
    title: 'Ch.4 — Encoding & Evolution',
    labs: [{ id: '4.1', label: 'Schema Evolution Playground', status: 'soon' }],
  },
  {
    id: 'ch10',
    title: 'Ch.10 — Batch Processing',
    labs: [{ id: '10.1', label: 'MapReduce Flow', status: 'soon' }],
  },
  {
    id: 'ch11',
    title: 'Ch.11 — Stream Processing',
    labs: [{ id: '11.1', label: 'Kafka-Style Log', status: 'soon' }],
  },
  {
    id: 'ch12',
    title: 'Ch.12 — Future of Data Systems',
    labs: [{ id: '12.1', label: 'Unbundled Database', status: 'soon' }],
  },
];
