/**
 * Graph health — a PURE report over a built graph (no I/O, no LLM).
 *
 * `buildGraph` is a deterministic function of its inputs, so the real questions about
 * a graph are "did projection feed it complete, correctly-linked nodes?" and "is the
 * shape sane?". This turns those into an inspectable artifact — counts by
 * type/relation, the cluster-size distribution, the isolated nodes, the surfaced
 * fuzzy edges — plus a set of structural INVARIANTS that must hold on any correct
 * graph. The same function powers fixture tests and a live harness, so a violation
 * looks identical wherever it shows up.
 */

import { DETERMINISTIC_CONFIDENCE } from "./manifest.js";
import type { Graph } from "./types.js";

export interface ClusterSummary {
  id: string;
  size: number;
  byType: Record<string, number>;
}

export interface InvariantFinding {
  /** Stable code so an asserter matches a CLASS of failure, not a message string. */
  code: "duplicate_ref" | "edge_dangling_endpoint" | "identity_collision";
  severity: "error" | "warn";
  message: string;
  refs: string[];
}

export interface GraphHealth {
  nodeCount: number;
  edgeCount: number;
  clusterCount: number;
  /** Edges below the clustering threshold — recorded for review, never merged. */
  fuzzyEdgeCount: number;
  nodesByType: Record<string, number>;
  edgesByRelation: Record<string, number>;
  /** Bucketed cluster sizes: "1" | "2" | "3-5" | "6-10" | "11+". */
  clusterSizeHistogram: Record<string, number>;
  /** Biggest clusters with their type makeup — the eyeball check. */
  largestClusters: ClusterSummary[];
  /** Nodes with NO edge at all (deterministic or fuzzy), by type — true fragmentation.
   *  A node connected only by a fuzzy edge forms its own cluster but is NOT isolated. */
  isolatedByType: Record<string, number>;
  /** A bounded sample of isolated nodes for spot-checking against the real source. */
  isolatedSample: { ref: string; type: string; label: string }[];
  invariants: InvariantFinding[];
}

export interface GraphHealthOptions {
  /** Min edge confidence counted as deterministic (matches `buildGraph`). */
  clusterThreshold?: number;
  /** How many top clusters to summarize (default 10). */
  topClusters?: number;
  /** How many isolated nodes to sample (default 25). */
  isolatedSampleSize?: number;
  /**
   * Identity node types — at most ONE of each should appear in a single deterministic
   * cluster. Two `customer` (or `person`, `account`, `device`…) nodes in one cluster
   * means a deterministic edge crossed an identity boundary — a false merge. List the
   * types that represent a unique real-world entity and a collision becomes an error.
   * Empty (default) = no identity invariant.
   */
  identityTypes?: string[];
}

function bucket(size: number): string {
  if (size <= 1) return "1";
  if (size === 2) return "2";
  if (size <= 5) return "3-5";
  if (size <= 10) return "6-10";
  return "11+";
}

function tally(into: Record<string, number>, key: string): void {
  into[key] = (into[key] ?? 0) + 1;
}

/** The structural invariants that must hold on any correct graph. Pure. */
export function checkGraphInvariants(graph: Graph, opts: GraphHealthOptions = {}): InvariantFinding[] {
  const findings: InvariantFinding[] = [];
  const identityTypes = new Set(opts.identityTypes ?? []);

  // 1. Duplicate refs — projection emitted the same entity twice (the Map dedups,
  //    so a smaller `nodesByRef` than `nodes` is the tell).
  if (graph.nodes.length !== graph.nodesByRef.size) {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const n of graph.nodes) (seen.has(n.ref) ? dupes : seen).add(n.ref);
    findings.push({
      code: "duplicate_ref",
      severity: "error",
      message: `${dupes.size} duplicate node ref(s) — the same entity was projected more than once.`,
      refs: [...dupes].slice(0, 25),
    });
  }

  // 2. Dangling edge endpoints — an edge points at a node not in the graph.
  const dangling = new Set<string>();
  for (const e of graph.edges) {
    if (!graph.nodesByRef.has(e.from)) dangling.add(e.from);
    if (!graph.nodesByRef.has(e.to)) dangling.add(e.to);
  }
  if (dangling.size) {
    findings.push({
      code: "edge_dangling_endpoint",
      severity: "error",
      message: `${dangling.size} edge endpoint(s) reference a node not present in the graph.`,
      refs: [...dangling].slice(0, 25),
    });
  }

  // 3. Identity collision — two distinct identity-type nodes in one deterministic
  //    cluster means an edge crossed an identity boundary (false entity resolution).
  if (identityTypes.size) {
    for (const c of graph.clusters) {
      for (const t of identityTypes) {
        const hits = c.nodeRefs.filter((r) => graph.nodesByRef.get(r)?.type === t);
        if (hits.length > 1) {
          findings.push({
            code: "identity_collision",
            severity: "error",
            message: `Cluster ${c.id} merges ${hits.length} distinct "${t}" nodes — a deterministic edge crossed an identity boundary.`,
            refs: hits.slice(0, 10),
          });
        }
      }
    }
  }

  return findings;
}

/** Build the full health report for a graph. Pure — graph in, report out. */
export function graphHealth(graph: Graph, opts: GraphHealthOptions = {}): GraphHealth {
  const topN = opts.topClusters ?? 10;
  const sampleSize = opts.isolatedSampleSize ?? 25;
  const threshold = opts.clusterThreshold ?? DETERMINISTIC_CONFIDENCE;

  const nodesByType: Record<string, number> = {};
  for (const n of graph.nodes) tally(nodesByType, n.type);

  const edgesByRelation: Record<string, number> = {};
  let fuzzy = 0;
  for (const e of graph.edges) {
    tally(edgesByRelation, e.relation);
    if (e.confidence < threshold) fuzzy += 1;
  }

  const histogram: Record<string, number> = {};
  const summaries: ClusterSummary[] = graph.clusters.map((c) => {
    const byType: Record<string, number> = {};
    for (const ref of c.nodeRefs) {
      const n = graph.nodesByRef.get(ref);
      if (n) tally(byType, n.type);
    }
    tally(histogram, bucket(c.nodeRefs.length));
    return { id: c.id, size: c.nodeRefs.length, byType };
  });

  // Isolated = no edge at all (deterministic OR fuzzy). A node joined only by a
  // sub-threshold edge is a singleton cluster yet still connected, so use adjacency.
  const isolatedByType: Record<string, number> = {};
  const isolatedSample: GraphHealth["isolatedSample"] = [];
  for (const n of graph.nodes) {
    if ((graph.adjacency.get(n.ref)?.length ?? 0) > 0) continue;
    tally(isolatedByType, n.type);
    if (isolatedSample.length < sampleSize) isolatedSample.push({ ref: n.ref, type: n.type, label: n.label });
  }

  return {
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    clusterCount: graph.clusters.length,
    fuzzyEdgeCount: fuzzy,
    nodesByType,
    edgesByRelation,
    clusterSizeHistogram: histogram,
    largestClusters: [...summaries].sort((a, b) => b.size - a.size).slice(0, topN),
    isolatedByType,
    isolatedSample,
    invariants: checkGraphInvariants(graph, opts),
  };
}
