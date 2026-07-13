import type { NodeId } from '../engine/events';

/** API-styles lab topology (Ch4 dataflow): one client, one API server. */
export const CLIENT: NodeId = 'Client';
export const SERVER: NodeId = 'Server';
export const API_TOPOLOGY: NodeId[] = [CLIENT, SERVER];

/** The client always loads a user profile = the user + this many posts. */
export const N_POSTS = 3;
/** Post ids the server owns for the one user. */
export const POST_IDS: string[] = Array.from({ length: N_POSTS }, (_, i) => `p${i}`);

/** Ticks a client waits for a response before giving up on that request. */
export const REQUEST_TIMEOUT = 250;

/**
 * Illustrative bytes-on-the-wire per message. REST ships a verbose JSON envelope
 * per resource; GraphQL returns one exact-shape JSON document; gRPC packs the
 * same data as compact binary protobuf. Numbers are relative, not measured.
 */
export const BYTES = {
  restUser: 220,
  restPost: 160,
  gqlQuery: 120,
  gqlResult: 360, // one document, exact shape (no repeated envelope / over-fetch)
  grpcProfile: 150, // binary — the whole profile in one compact message
} as const;

/** What every API-style flow reports (spec: round trips × bytes × failure granularity). */
export interface ApiStats {
  roundTrips: number; // client↔server request/response pairs
  bytes: number; // total bytes over the wire seen by the client
  delivered: number; // posts the client actually assembled
  expected: number; // posts the profile should contain
  failed: number; // requests that timed out
  settled: boolean; // the client is done (all requests resolved or timed out)
}
