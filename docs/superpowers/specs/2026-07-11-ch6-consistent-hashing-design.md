# Ch6.1 — Consistent Hashing Ring — Design

**Status:** approved (brainstorm 2026-07-11)
**Goal:** Ship DDIA Chapter 6 (Partitioning) as one interactive lab — a consistent-hash ring with virtual nodes where the learner puts keys, adds/removes nodes, and *watches keys migrate*, discovering (a) consistent hashing moves far fewer keys than naive `hash mod N` on a membership change, and (b) virtual nodes smooth load. One engine-verified chaos challenge: **create a hotspot.**

Builds on the Phase-0 engine + Phase-1 kit; pairs thematically with the Ch5 leaderless (Dynamo) lab.

---

## 1. Scope

**In:**
- New pure module `src/modules/hashring.ts` (contract v0.2): consistent-hash ring with virtual nodes, key placement by successor lookup, Dynamo-faithful put routing, planned add/remove-node membership changes with key handoff, a `detectHotspot` verifier, and metrics.
- New kit component `src/ui/kit/RingView.tsx`: the SVG ring (vnodes, key dots, per-node load heatmap) — the lab's visual identity.
- New lab page `src/ui/labs/hashring/HashRingLab.tsx`: RingView + controls (vnodes, add/remove node, put-N-keys, mod-N compare) + ChallengePanel + MetricsPanel + TimelineScrubber.
- Catalog + routing: lab `6.1` active in the `ch6` chapter, App PAGES `'6.1'`, debrief `content/ch06/`.
- Property test(s) for the module; unit tests for module + verifier; a RingView render test.

**Out (explicitly deferred):**
- Hash-vs-range partitioning comparison (chosen: ring-focused scope).
- Replication / durability of keys on crash — that is Ch5's concern; this lab has one copy per key. `kill-node` (crash) is therefore *not* a membership operation here (see §7).
- The "celebrity hot-key that hashing cannot fix" nuance — lives in the debrief, not the sim.
- A second engine-verified challenge (rebalance-on-death) — the rebalance insight is delivered as the guided live+debrief follow-up to the hotspot challenge.

---

## 2. Ring model (module `hashring.ts`)

**Positions.** Reuse the engine's exported `fnv1a` (pure, deterministic, 32-bit). A key's ring position is `fnv1a(key)`. A node `n` owns `V` virtual nodes at `fnv1a(`${n}#${i}`)` for `i` in `[0, V)`. A key's **owner** is the node of the first vnode clockwise from the key's position (successor; wrap around at 2³²). No RNG, no `Date.now` — module stays ESLint-pure.

**Membership.** `config.nodeIds` is a fixed *pool* (e.g. 8 nodes, all alive in the engine). The **ring membership** is a logical subset tracked in state, started with a few nodes (e.g. 3) and grown/shrunk by `addNode`/`removeNode` client ops. This sidesteps the engine's fixed node set: "adding a node" = bringing a pool node into the ring; migration happens between *alive* nodes (a planned change, not a crash).

**`V` (vnodes per node).** A build-time parameter (like `mode` in 5.1): changing it rebuilds the sim with a fresh seed/epoch. Rationale: a live `V` change re-places nearly every key (churn that muddies the migration story); the *live* levers are add/remove node and put-keys. Raising `V` and rebuilding shows a visibly smoother distribution.

**State (per node).**
```
HashRingState {
  self: NodeId;
  members: NodeId[];        // current ring membership (shared view; updated on membership ops)
  vnodes: number;           // V
  keys: string[];           // keys this node currently owns/stores
  movedLog: { count: number };  // keys handed off to/from this node over the session (for keys-moved)
}
```

**Payload (client ops + messages).**
```
| { cmd: 'put'; key: string }
| { cmd: 'addNode'; node: NodeId }
| { cmd: 'removeNode'; node: NodeId }
| { msg: 'store'; key: string }        // owner stores the key
| { msg: 'handoff'; keys: string[] }   // migration between neighbours on membership change
| { msg: 'membership'; members: NodeId[] }  // broadcast the new ring view
| ...acks as needed
```

**Behaviour.**
- **put(key):** coordinator = the node receiving the external event; it computes `owner(key, members, V)` and sends `store` to it; the owner appends the key. (Faithful routing; reuses message-passing + ClusterView-style chaos view.)
- **addNode(n):** broadcast `membership` (adds `n`); for each existing member, the keys whose owner is now `n` (its new arcs) hand off to `n` via `handoff`; `keys-moved` counts them. The elegance to surface: only keys in `n`'s arcs move — a small fraction.
- **removeNode(n):** the keys on `n` hand off to their successors in the reduced ring; broadcast `membership` (removes `n`).
- All placement is deterministic given `(members, V)`; every node computes ownership the same way, so the membership broadcast keeps views consistent.

**Verifier — `detectHotspot(states)`:** returns the offending node when `maxLoad ≥ 2 · (totalKeys / memberCount)` (a node holding ≥ 2× its fair share). Sound and quiescence-free — it reads the current per-node `keys` counts. Returns `null` otherwise.

**Metrics:** `max-load-ratio` (maxLoad / fairShare — the skew number), `keys-moved` (cumulative handoffs), `vnodes` (V), `ring-nodes` (member count).

---

## 3. `RingView` kit component

An SVG circle (the ring):
- **vnodes** as tick marks / short arc segments around the circumference at their `fnv1a` angle, colored per owning node (a stable per-node hue).
- **keys** as small dots at their `fnv1a(key)` angle, just inside the ring.
- **per-node load heatmap:** each node's arc color intensity (or a companion per-node load bar) ∝ its key count, so a hotspot is visually obvious.
- membership change animates keys hopping to the new owner (or at minimum re-renders their color).

Reuses theme tokens only (`ink/panel/line/dim/fg/set/sign/warn`). `ClusterView` is untouched — the other labs keep it; `RingView` is this lab's dedicated view. `MetricsPanel`, `TimelineScrubber`, `ChallengePanel`, `KVControls`(adapted or a small `RingControls`), the SimDriver/store bridge — all reused unchanged.

---

## 4. Controls (`HashRingLab.tsx`)

- **vnodes slider `V`** (rebuilds on change; default low ~1–3 so imbalance is visible, up to ~200).
- **add node / remove node** buttons (choose from the pool of out-of-ring nodes / current members).
- **"put N keys"** — enqueue N puts of distinct keys (`k0..k{N-1}`) to exercise placement/load.
- **headline compare readout:** for the **last** membership change, two numbers side by side — keys the consistent-hash ring actually moved (from the module's per-change handoff count) **vs** how many a naive `hash mod N` scheme *would* have moved (computed in the UI over the current key set) — few vs ~all. Distinct from the cumulative `keys-moved` metric in §2 (which trends over the whole session); this readout is the single last-change delta.
- driver init follows the **effect-based pattern** established in PR #2 (build the sim/driver in `useEffect`, driver in `useState`, `if (!driver) return null`), keyed on `[vnodes, epoch]`.

---

## 5. Chaos challenge (engine-verified, predict-before-run)

**Primary — "create a hotspot".** Uses the shared kit `ChallengePanel` (predict → start attempt → engine verifies → prediction-vs-reality reveal), `storageKeyPrefix` `ddia:ch06:hotspot`. `check = () => detectHotspot(statesOf())`. Win: one node holds ≥ 2× fair share — reachable at low `V` with enough keys (few nodes own large arcs). `renderWin` names the hot node, its load, and the fair share.

**Guided follow-up (live + debrief, not a second verifier):** raise `V` (rebuild) or add a node → the `max-load-ratio` metric drops and the heatmap evens out. Debrief covers: consistent hashing's minimal-migration property, virtual nodes for balance, and the celebrity hot-key that hashing alone can't fix (contrast with per-key sharding / caching).

---

## 6. Global constraints

- `src/modules/**` stays pure: no React/DOM imports, no `Math.random`/`Date.now`; all placement from `fnv1a`; state plain JSON. (ESLint-enforced.)
- Zero engine changes — reuse `fnv1a`, the SimModule contract v0.2, chaos, and the bridge as-is.
- Theme tokens only in UI; no hardcoded slate/sky.
- localStorage key scheme `<prefix>:attempt` / `<prefix>:prediction:<n>`; challenge prefix `ddia:ch06:hotspot`.
- Coverage gate ≥ 80% on `src/engine/**` + `src/modules/**` holds.
- Bundle stays under the 500 KB gzip CI budget.
- Conventional commits; every task leaves a deployable state.

---

## 7. Design decisions

- **Dynamo-faithful routing** (chosen over a static compute-all-placements module): coordinator routes to owner; membership change re-homes via handoff messages. Reads like the protocol, reuses chaos, and makes migration *visible traffic* — the whole point of the lab.
- **Membership = logical subset of an alive pool; add/remove are planned ops** (not `kill-node`). Consistent hashing without replication has one copy per key, so a *crash* would lose data — a Ch5 concern, out of scope here. Planned add/remove between alive nodes shows the elegant minimal migration cleanly. (`kill-node` may still appear in the toolbar as a contrast — killing an owner makes its keys unreachable — but it is not the rebalance mechanism.)
- **`V` is build-time** (rebuild on change); live levers are add/remove node + put-keys. Keeps the migration story about membership, not V churn.
- **One primary challenge** (create-a-hotspot), rebalance as the guided follow-up — matches the single-primary-challenge shape of 5.1/5.2.
- **New `RingView`, `ClusterView` untouched** — the ring is a distinct visualization; don't overload the cluster view.

---

## 8. Definition of Done

- Lab `6.1` live, Ch6 active in the sidebar; the hotspot challenge is winnable with predict-before-run and engine verification.
- Adding/removing a node visibly migrates only the affected keys; the `keys-moved` vs `hash mod N` readout makes the contrast concrete.
- Raising `V` (rebuild) visibly smooths the load heatmap and drops `max-load-ratio`.
- ≥ 3 live metrics; ≥ 1 property test green (e.g. *every key routes to exactly one member; a membership change moves only keys in the changed arcs*); module + verifier unit-tested.
- Coverage ≥ 80% holds; full suite + typecheck + lint + build green; bundle < 500 KB gzip; CI deploys; site returns 200 with the 6.1 lab active.
- Debrief `content/ch06/` covers minimal migration, virtual nodes, and the hot-key limit.

---

## 9. Open questions

- **RingView animation depth:** full key-hop animation vs a simpler recolor-on-migration. Recommend starting with recolor + a `keys-moved` counter; add motion only if cheap. (Resolve in the plan.)
- **Property-test phrasing** for "minimal migration": assert that on `addNode`, every migrated key's new owner is the added node (no unrelated key moves). (Resolve in the plan.)
