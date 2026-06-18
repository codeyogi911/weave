/**
 * Manifests — the declarative link grammar. A manifest is plain data: a list of node
 * types and a list of edge rules. It is the ONE place you describe how records from
 * different sources connect. Ship a default; let a deployment `merge` overrides where
 * its systems carry a different join key — without forking the grammar.
 *
 * Edges can be intentionally REDUNDANT/over-complete: if an invoice's reference may
 * be either a sales-order number OR a channel order id, declare both rules and
 * whichever resolves wins. There is no penalty for an edge rule that never matches.
 */

import type { EdgeRule, Manifest, NodeType } from "./types";

/** Edges at/above this confidence form connected-component clusters. Below it, the
 *  edge is recorded for traversal but never auto-merges two clusters. */
export const DETERMINISTIC_CONFIDENCE = 1;

/** Build a manifest from a list of edge rules, inferring `nodeTypes` from the rules
 *  (plus any you pass explicitly — useful for types that have nodes but no edges
 *  yet). A thin convenience over the plain `{ nodeTypes, edges }` object. */
export function defineManifest(edges: EdgeRule[], extraNodeTypes: NodeType[] = []): Manifest {
  const nodeTypes = new Set<NodeType>(extraNodeTypes);
  for (const e of edges) {
    nodeTypes.add(e.from);
    nodeTypes.add(e.to);
  }
  return { nodeTypes: [...nodeTypes], edges };
}

/** Merge a base manifest with overrides. Override edges with the same
 *  (from, to, relation, sourceField) replace the base; new ones are appended.
 *  Node types union. Keeps the shipped default while letting a deployment retune one
 *  hop without forking the whole grammar. `undefined` override returns the base
 *  unchanged, so callers can pass an optional config straight through. */
export function mergeManifest(base: Manifest, override?: Partial<Manifest>): Manifest {
  if (!override) return base;
  const key = (e: EdgeRule) => `${e.from}|${e.to}|${e.relation}|${e.sourceField}`;
  const edges = new Map(base.edges.map((e) => [key(e), e]));
  for (const e of override.edges ?? []) edges.set(key(e), e);
  const nodeTypes: NodeType[] = [...new Set([...base.nodeTypes, ...(override.nodeTypes ?? [])])];
  return { nodeTypes, edges: [...edges.values()] };
}
