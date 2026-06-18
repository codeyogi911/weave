/**
 * The graph builder + traversal. Resolves a manifest's edge rules over a set of
 * nodes into a graph, clusters it by connected components (deterministic edges only),
 * and offers point-traversal for general reads.
 *
 * Pure + deterministic. This is the single graph builder.
 */

import { DETERMINISTIC_CONFIDENCE } from "./manifest";
import { type Cluster, type EdgeRule, type Graph, type Manifest, type Node, norm, type ResolvedEdge } from "./types";

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root) as string;
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur) as string;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export interface BuildOptions {
  /** Extra edges supplied at build time (e.g. a fuzzy match, an ML verdict). Ones at
   *  or above the clustering threshold participate in clustering. */
  extraEdges?: ResolvedEdge[];
  /** Min confidence for an edge to merge clusters. Default = deterministic only. */
  clusterThreshold?: number;
}

/** Index nodes by type → (normalized ref|label → ref). First write wins, so a node's
 *  own ref beats a colliding label from a later node. Shared by the builder and the
 *  diagnostics layer so both resolve links identically. */
export function indexNodesByType(nodes: readonly Node[]): Map<string, Map<string, string>> {
  const indexByType = new Map<string, Map<string, string>>();
  for (const n of nodes) {
    const idx = indexByType.get(n.type) ?? new Map<string, string>();
    const k = norm(n.ref);
    if (k && !idx.has(k)) idx.set(k, n.ref);
    const l = norm(n.label);
    if (l && !idx.has(l)) idx.set(l, n.ref);
    indexByType.set(n.type, idx);
  }
  return indexByType;
}

/** The one resolution pass: walk every manifest edge rule against a per-type index,
 *  calling `onResolved` for each link that matched a target node and (optionally)
 *  `onUnresolved` for each value that matched nothing. `buildGraph` uses the hits to
 *  add edges; the diagnostics layer uses the misses — neither re-implements matching. */
export function resolveManifestLinks(
  nodes: readonly Node[],
  manifest: Manifest,
  indexByType: Map<string, Map<string, string>>,
  onResolved: (fromRef: string, toRef: string, rule: EdgeRule) => void,
  onUnresolved?: (node: Node, rule: EdgeRule, value: string) => void,
): void {
  for (const rule of manifest.edges) {
    const targetIdx = indexByType.get(rule.to);
    for (const n of nodes) {
      if (n.type !== rule.from) continue;
      for (const value of n.links[rule.sourceField] ?? []) {
        const targetRef = targetIdx?.get(norm(value));
        if (targetRef) onResolved(n.ref, targetRef, rule);
        else onUnresolved?.(n, rule, value);
      }
    }
  }
}

/**
 * Build the graph: resolve every edge rule against a per-TYPE index of nodes (by
 * normalized ref AND label), union deterministic edges into clusters, and expose
 * adjacency for traversal.
 */
export function buildGraph(nodes: readonly Node[], manifest: Manifest, opts: BuildOptions = {}): Graph {
  const threshold = opts.clusterThreshold ?? DETERMINISTIC_CONFIDENCE;
  const nodesByRef = new Map(nodes.map((n) => [n.ref, n]));

  const indexByType = indexNodesByType(nodes);

  const uf = new UnionFind();
  for (const n of nodes) uf.find(n.ref);

  const edges: ResolvedEdge[] = [];
  const seen = new Set<string>();
  const addEdge = (
    from: string,
    to: string,
    relation: string,
    confidence: number,
    prov?: Pick<ResolvedEdge, "status" | "evidence" | "ruleId">,
  ) => {
    if (from === to) return;
    const k = `${from}->${to}->${relation}`;
    if (seen.has(k)) return;
    seen.add(k);
    edges.push({ from, to, relation, confidence, ...(prov ?? {}) });
    if (confidence >= threshold) uf.union(from, to);
  };

  resolveManifestLinks(nodes, manifest, indexByType, (fromRef, toRef, rule) => {
    addEdge(fromRef, toRef, rule.relation, rule.confidence);
  });
  // Caller-supplied edges carry their provenance onto the unified graph.
  for (const e of opts.extraEdges ?? []) {
    if (nodesByRef.has(e.from) && nodesByRef.has(e.to)) {
      const prov: Pick<ResolvedEdge, "status" | "evidence" | "ruleId"> = {};
      if (e.status !== undefined) prov.status = e.status;
      if (e.evidence !== undefined) prov.evidence = e.evidence;
      if (e.ruleId !== undefined) prov.ruleId = e.ruleId;
      addEdge(e.from, e.to, e.relation, e.confidence, prov);
    }
  }

  // Undirected adjacency over all edges (for traversal).
  const adjacency = new Map<string, ResolvedEdge[]>();
  for (const e of edges) {
    (adjacency.get(e.from) ?? adjacency.set(e.from, []).get(e.from)!).push(e);
    (adjacency.get(e.to) ?? adjacency.set(e.to, []).get(e.to)!).push(e);
  }

  // Connected components over deterministic edges = clusters.
  const groups = new Map<string, string[]>();
  for (const n of nodes) {
    const root = uf.find(n.ref);
    (groups.get(root) ?? groups.set(root, []).get(root)!).push(n.ref);
  }
  const clusters: Cluster[] = [...groups.values()].map((nodeRefs) => ({
    id: [...nodeRefs].sort()[0] as string,
    nodeRefs,
  }));

  return { nodes: [...nodes], nodesByRef, edges, adjacency, clusters };
}

/** The connected component containing `ref` — the whole transaction/entity a node
 *  belongs to. The natural answer to "show me this thing and everything linked". */
export function clusterOf(graph: Graph, ref: string): Node[] {
  const cluster = graph.clusters.find((c) => c.nodeRefs.includes(ref));
  if (!cluster) return graph.nodesByRef.has(ref) ? [graph.nodesByRef.get(ref) as Node] : [];
  return cluster.nodeRefs.map((r) => graph.nodesByRef.get(r)).filter((n): n is Node => Boolean(n));
}

/** Breadth-first neighbourhood out to `depth` hops — for bounded point-traversal
 *  (expanding one node a couple of relations out). */
export function expand(
  graph: Graph,
  ref: string,
  opts: { depth?: number; relations?: string[] } = {},
): { nodes: Node[]; edges: ResolvedEdge[] } {
  const depth = opts.depth ?? 2;
  const relOk = opts.relations ? new Set(opts.relations) : null;
  const visited = new Set<string>([ref]);
  const outEdges: ResolvedEdge[] = [];
  // Each edge sits in the adjacency list of BOTH its endpoints, so dedup as we go —
  // otherwise traversing both ends emits the same edge twice.
  const seenEdge = new Set<string>();
  let frontier = [ref];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const e of graph.adjacency.get(cur) ?? []) {
        if (relOk && !relOk.has(e.relation)) continue;
        const ek = `${e.from}->${e.relation}->${e.to}`;
        if (!seenEdge.has(ek)) {
          seenEdge.add(ek);
          outEdges.push(e);
        }
        const other = e.from === cur ? e.to : e.from;
        if (!visited.has(other)) {
          visited.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  return {
    nodes: [...visited].map((r) => graph.nodesByRef.get(r)).filter((n): n is Node => Boolean(n)),
    edges: outEdges,
  };
}
