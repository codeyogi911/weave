/**
 * The one-call front door + the agent-facing read.
 *
 * `weave()` ties the whole pipeline together: project records through their sources,
 * then build the graph against a manifest. `readEntity()` answers the question an
 * agent actually asks — "give me this thing and everything connected to it" — as one
 * compact, source-blind object instead of N disconnected tool results.
 */

import { type BuildOptions, buildGraph, clusterOf } from "./build";
import type { Graph, Manifest, Node, ResolvedEdge } from "./types";
import { norm } from "./types";
import type { Source } from "./source";

export interface SourceInput<T> {
  source: Source<T>;
  records: readonly T[];
}

/**
 * Project every source's records into nodes and build the graph in one call.
 *
 *   const graph = weave(
 *     [
 *       { source: orders, records: orderRows },
 *       { source: payments, records: paymentRows },
 *     ],
 *     manifest,
 *   );
 */
export function weave(inputs: readonly SourceInput<any>[], manifest: Manifest, opts?: BuildOptions): Graph {
  const nodes: Node[] = [];
  for (const { source, records } of inputs) nodes.push(...source.project(records));
  return buildGraph(nodes, manifest, opts);
}

/** A connected, source-blind view of one entity — what an agent reads in one shot. */
export interface EntityView {
  seed: NodeSummary;
  /** Every node in the seed's cluster, grouped by type (the seed included). */
  related: Record<string, NodeSummary[]>;
  /** The edges among the cluster's nodes, as plain `from -relation-> to` triples. */
  edges: { from: string; relation: string; to: string; confidence: number }[];
}

export interface NodeSummary {
  ref: string;
  type: string;
  label: string;
  status?: string;
  amount?: number;
  currency?: string;
  occurredAt?: string;
}

function summarize(n: Node): NodeSummary {
  const s: NodeSummary = { ref: n.ref, type: n.type, label: n.label };
  if (n.status != null) s.status = n.status;
  if (n.amount != null) s.amount = n.amount;
  if (n.currency != null) s.currency = n.currency;
  if (n.occurredAt != null) s.occurredAt = n.occurredAt;
  return s;
}

/** Resolve a seed by ref, or by normalized label/number across (optionally) a type. */
export function findNode(graph: Graph, seed: string, type?: string): Node | undefined {
  if (graph.nodesByRef.has(seed)) return graph.nodesByRef.get(seed);
  const target = norm(seed);
  return graph.nodes.find((n) => norm(n.label) === target && (!type || n.type === type));
}

/**
 * Read one entity and everything in its cluster as a single compact object. `seed`
 * is a node ref OR a human label/number (resolved leniently). Returns `null` if the
 * seed isn't in the graph.
 */
export function readEntity(graph: Graph, seed: string, opts: { type?: string } = {}): EntityView | null {
  const node = findNode(graph, seed, opts.type);
  if (!node) return null;

  const members = clusterOf(graph, node.ref);
  const memberRefs = new Set(members.map((m) => m.ref));

  const related: Record<string, NodeSummary[]> = {};
  for (const m of members) (related[m.type] ??= []).push(summarize(m));

  const edges: EntityView["edges"] = [];
  const seenEdge = new Set<string>();
  for (const m of members) {
    for (const e of graph.adjacency.get(m.ref) ?? []) {
      if (!memberRefs.has(e.from) || !memberRefs.has(e.to)) continue;
      const k = `${e.from}->${e.relation}->${e.to}`;
      if (seenEdge.has(k)) continue;
      seenEdge.add(k);
      edges.push({ from: e.from, relation: e.relation, to: e.to, confidence: e.confidence });
    }
  }

  return { seed: summarize(node), related, edges };
}

export type { ResolvedEdge };
