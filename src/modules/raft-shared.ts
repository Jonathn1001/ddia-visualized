// Ch9 — Raft vocabulary: five nodes, paper-faithful message shapes, client history.
import type { NodeId } from '../engine/events';

export const RAFT_NODES: NodeId[] = ['N1', 'N2', 'N3', 'N4', 'N5'];
export const MAJORITY = 3;

/** Election timeout range and heartbeat period, in virtual ticks (latency is 1–10). */
export const ELECTION_MIN = 150;
export const ELECTION_MAX = 300;
export const HEARTBEAT = 50;

/** The linearizability checker refuses longer histories (the problem is NP-hard). */
export const CHECK_CAP = 12;

export interface Entry {
  term: number;
  value: number;
  /** Unique per (writer, write): lets a client row detect its entry was truncated. */
  seq: string;
}

export type RaftMsg =
  | { kind: 'req-vote'; term: number; lastLogIndex: number; lastLogTerm: number }
  | { kind: 'vote'; term: number; granted: boolean }
  | { kind: 'append'; term: number; prevIndex: number; prevTerm: number; entries: Entry[]; leaderCommit: number }
  | { kind: 'append-resp'; term: number; ok: boolean; matchIndex: number };

export type RaftExternal = { cmd: 'write'; value: number } | { cmd: 'read' };

export type RaftTimer = { t: 'election'; nonce: number } | { t: 'heartbeat'; nonce: number };

export type RaftPayload = RaftMsg | RaftExternal | RaftTimer;

export interface HistoryRow {
  id: string; // `${node}:${n}` — unique across the cluster
  node: NodeId;
  op: 'write' | 'read';
  value: number | null;
  invokedAt: number;
  respondedAt: number | null;
  outcome: 'pending' | 'ok' | 'lost' | 'redirect';
  /** write rows: where the entry landed, to detect truncation later. */
  index?: number;
  seq?: string;
}
