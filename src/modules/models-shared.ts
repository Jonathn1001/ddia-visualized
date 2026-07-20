// Ch2 — data-model vocabulary: one social-graph fixture stored three ways, plus the
// three pure query engines the property + lesson tests assert against. No engine, no RNG.
import type { NodeId } from '../engine/events';

export const DM: NodeId = 'DM';
export const MODELS_NODES: NodeId[] = [DM];

export type Id = string;
export type ModelId = 'relational' | 'document' | 'graph';
export const MODELS: ModelId[] = ['relational', 'document', 'graph'];
export type QueryId = 'fof' | 'm2m';

export const STEP_EVERY = 8;
export const FOF_MULT = 2;
export const M2M_MULT = 2;
export const TECH = 'tech';

export const USERS: { id: Id; name: string }[] = [
  { id: 'alice', name: 'Alice' },
  { id: 'bob', name: 'Bob' },
  { id: 'carol', name: 'Carol' },
  { id: 'dan', name: 'Dan' },
  { id: 'eve', name: 'Eve' },
  { id: 'frank', name: 'Frank' },
];
export const USER_IDS: Id[] = USERS.map((u) => u.id);
export const FRIENDSHIPS: [Id, Id][] = [
  ['alice', 'bob'],
  ['alice', 'carol'],
  ['bob', 'dan'],
  ['carol', 'eve'],
  ['carol', 'frank'],
  ['dan', 'eve'],
];
export const POSTS: { id: Id; category: string }[] = [
  { id: 't1', category: 'tech' },
  { id: 't2', category: 'tech' },
  { id: 'c1', category: 'cooking' },
  { id: 'g1', category: 'garden' },
];
export const LIKES: [Id, Id][] = [
  ['bob', 't1'],
  ['dan', 't2'],
  ['frank', 't1'],
  ['carol', 'c1'],
  ['eve', 'g1'],
  ['alice', 'c1'],
];

export interface Step {
  kind: 'hop' | 'fetch' | 'probe';
  touched: Id[];
  note: string;
}
export interface Trace {
  steps: Step[];
  result: Id[];
  roundTrips: number;
}
export interface UserDoc {
  id: Id;
  name: string;
  friendIds: Id[];
  likes: Id[];
  nickname?: string;
}

const sortU = (xs: Iterable<Id>): Id[] => [...new Set(xs)].sort();

export function adjacency(): Record<Id, Id[]> {
  const adj: Record<Id, Id[]> = {};
  for (const id of USER_IDS) adj[id] = [];
  for (const [a, b] of FRIENDSHIPS) {
    adj[a].push(b);
    adj[b].push(a);
  }
  return adj;
}
export function userDocs(): Record<Id, UserDoc> {
  const adj = adjacency();
  const likesBy: Record<Id, Id[]> = {};
  for (const id of USER_IDS) likesBy[id] = [];
  for (const [u, p] of LIKES) likesBy[u].push(p);
  const docs: Record<Id, UserDoc> = {};
  for (const u of USERS) docs[u.id] = { id: u.id, name: u.name, friendIds: adj[u.id], likes: likesBy[u.id] };
  return docs;
}
export function postCategory(): Record<Id, string> {
  const m: Record<Id, string> = {};
  for (const p of POSTS) m[p.id] = p.category;
  return m;
}

/** GRAPH — a single traversal; each edge followed is a hop. roundTrips = 1. */
export function runGraph(query: QueryId, root: Id): Trace {
  const steps: Step[] = [];
  if (query === 'fof') {
    const adj = adjacency();
    const direct = new Set(adj[root]);
    const fof = new Set<Id>();
    for (const f of adj[root]) steps.push({ kind: 'hop', touched: [root, f], note: `${root} → ${f}` });
    for (const f of adj[root])
      for (const ff of adj[f]) {
        steps.push({ kind: 'hop', touched: [f, ff], note: `${f} → ${ff}` });
        if (ff !== root && !direct.has(ff)) fof.add(ff);
      }
    return { steps, result: sortU(fof), roundTrips: 1 };
  }
  const cat = postCategory();
  const likers: Record<Id, Id[]> = {};
  for (const [u, p] of LIKES) (likers[p] ??= []).push(u);
  const users = new Set<Id>();
  for (const p of POSTS) {
    if (cat[p.id] !== TECH) continue;
    steps.push({ kind: 'hop', touched: [p.id], note: `post ${p.id} (tech)` });
    for (const u of likers[p.id] ?? []) {
      steps.push({ kind: 'hop', touched: [p.id, u], note: `${p.id} ← ${u}` });
      users.add(u);
    }
  }
  return { steps, result: sortU(users), roundTrips: 1 };
}

/** DOCUMENT — no join; one fetch per entity. roundTrips = steps.length (the N+1). */
export function runDocument(query: QueryId, root: Id): Trace {
  const docs = userDocs();
  const cat = postCategory();
  const steps: Step[] = [];
  if (query === 'fof') {
    steps.push({ kind: 'fetch', touched: [root], note: `fetch ${root}` });
    const direct = docs[root].friendIds;
    const fof = new Set<Id>();
    for (const f of direct) {
      steps.push({ kind: 'fetch', touched: [f], note: `fetch ${f}` });
      for (const ff of docs[f].friendIds) if (ff !== root && !direct.includes(ff)) fof.add(ff);
    }
    for (const ff of sortU(fof)) steps.push({ kind: 'fetch', touched: [ff], note: `fetch ${ff}` });
    return { steps, result: sortU(fof), roundTrips: steps.length };
  }
  const users = new Set<Id>();
  for (const id of USER_IDS) {
    steps.push({ kind: 'fetch', touched: [id], note: `scan ${id}` });
    for (const p of docs[id].likes) {
      steps.push({ kind: 'fetch', touched: [id, p], note: `fetch post ${p}` });
      if (cat[p] === TECH) users.add(id);
    }
  }
  return { steps, result: sortU(users), roundTrips: steps.length };
}

/** RELATIONAL — one join over the join table; each matching row is a probe. roundTrips = 1. */
export function runRelational(query: QueryId, root: Id): Trace {
  const steps: Step[] = [];
  if (query === 'fof') {
    const rows: [Id, Id][] = [];
    for (const [a, b] of FRIENDSHIPS) {
      rows.push([a, b]);
      rows.push([b, a]);
    }
    const direct: Id[] = [];
    for (const [a, b] of rows)
      if (a === root) {
        steps.push({ kind: 'probe', touched: [a, b], note: `f1 ${a}-${b}` });
        direct.push(b);
      }
    const directSet = new Set(direct);
    const fof = new Set<Id>();
    for (const d of direct)
      for (const [a, b] of rows)
        if (a === d) {
          steps.push({ kind: 'probe', touched: [a, b], note: `f2 ${a}-${b}` });
          if (b !== root && !directSet.has(b)) fof.add(b);
        }
    return { steps, result: sortU(fof), roundTrips: 1 };
  }
  const cat = postCategory();
  const users = new Set<Id>();
  for (const [u, p] of LIKES) {
    steps.push({ kind: 'probe', touched: [u, p], note: `like ${u}-${p}` });
    if (cat[p] === TECH) users.add(u);
  }
  return { steps, result: sortU(users), roundTrips: 1 };
}

/** Schema-on-write touches every existing row; schema-on-read touches only the one doc. */
export function migrationCost(model: ModelId, nicknameAdded: boolean): number {
  if (!nicknameAdded) return 0;
  return model === 'relational' ? USER_IDS.length : 0;
}
