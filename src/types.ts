/**
 * Weave — the core graph types.
 *
 * Weave is a small, pure, dependency-free engine that stitches records from many
 * heterogeneous sources (a Postgres table, a Shopify REST call, a CSV on disk, a
 * remote API) into ONE connected graph you can cluster and traverse. It knows about
 * nodes, declarative edge rules (a "manifest"), and connected components — and
 * nothing about your domain. You project records into `Node`s and supply a manifest;
 * the engine resolves the edges and finds the clusters.
 *
 * Pure + deterministic: nodes + manifest in, graph out. No I/O, no database, no LLM.
 * Runs anywhere JS runs — Node, Bun, Deno, the browser, an edge isolate.
 */

/** A node type is just a string (e.g. "order", "customer", "invoice", "user").
 *  The manifest references types by name, so a new entity kind needs no code change. */
export type NodeType = string;

/** Where a projected record came from. Useful for diagnostics and agent-facing evidence. */
export type SourceKind = "mcp" | "rest" | "db" | "graphql" | "api" | "file" | "custom";

export interface SourceProvenance {
  source: string;
  kind?: SourceKind;
  recordId?: string;
  observedAt?: string;
}

/** A source-blind projection of any record into the graph.
 *
 *  `ref` is the stable URN — by convention `<type>:<provider>:<id>` (e.g.
 *  `order:shopify:1001`) so the same entity from the same source always gets the
 *  same ref. `links` holds this node's outgoing foreign keys, keyed by field name,
 *  each a list of refs OR human identifiers — a manifest edge's `sourceField` names
 *  one of these keys. `raw` carries the original record for consumers that want it. */
export interface Node {
  ref: string;
  type: NodeType;
  /** Human identifier (order number, email, SKU) — an edge can resolve TO it. */
  label: string;
  status?: string | null;
  amount?: number | null;
  currency?: string | null;
  occurredAt?: string | null;
  /** Outgoing foreign keys: { customerEmail: ["a@b.com"], orderRefs: ["1001"] }. */
  links: Record<string, string[]>;
  /** Source provenance for diagnostics and agent-facing evidence. */
  source?: SourceProvenance;
  /** The original record, untouched. */
  raw?: unknown;
}

/** A declarative edge rule — the "spine" of the graph. For each node of type `from`,
 *  the values in `from.links[sourceField]` are resolved against nodes of type `to`
 *  (matched by normalized ref OR label). Deterministic rules (confidence >= the
 *  clustering threshold) form the connected components; lower-confidence rules are
 *  recorded as edges for traversal but never auto-merge clusters — the entity-
 *  resolution "black-hole" guard that stops one bad fuzzy match collapsing the world. */
export interface EdgeRule {
  from: NodeType;
  to: NodeType;
  /** Semantic name, e.g. "placed_by" / "fulfills" / "settles". */
  relation: string;
  /** Key in the source node's `links` whose values point at the target. */
  sourceField: string;
  /** 1.0 = deterministic key; < 1 = fuzzy/heuristic (edge only, no auto-merge). */
  confidence: number;
  cardinality?: "1:1" | "1:N" | "N:N";
}

export interface Manifest {
  nodeTypes: NodeType[];
  edges: EdgeRule[];
}

/** A resolved edge between two present nodes. Manifest edges carry just a relation +
 *  confidence; edges you supply directly (e.g. from a fuzzy matcher or an ML model)
 *  may also carry PROVENANCE — the disposition, the human evidence, and the rule id —
 *  so the ONE graph can express a fuzzy/curated match without a parallel graph type. */
export interface ResolvedEdge {
  from: string;
  to: string;
  relation: string;
  confidence: number;
  /** Resolution disposition, e.g. "curated" | "source_embedded" | "ambiguous". */
  status?: string;
  /** Human-readable provenance lines explaining why the edge was drawn. */
  evidence?: string[];
  /** The rule/model that produced it (stable id; logs/UI reference it). */
  ruleId?: string;
}

/** A connected component over deterministic edges ≈ one real-world thing
 *  (a transaction, a customer's footprint, a device's history). */
export interface Cluster {
  /** Stable id — the lexicographically smallest member ref. */
  id: string;
  nodeRefs: string[];
}

export interface Graph {
  nodes: Node[];
  nodesByRef: Map<string, Node>;
  edges: ResolvedEdge[];
  /** Undirected adjacency over ALL edges (deterministic + fuzzy), for traversal. */
  adjacency: Map<string, ResolvedEdge[]>;
  /** Connected components over DETERMINISTIC edges only. */
  clusters: Cluster[];
}

/** Normalize a ref/identifier for cross-source comparison: trim, drop a leading '#',
 *  lowercase. Different systems prefix and case the same id differently
 *  (`#1001` vs `1001`, `SKU-A` vs `sku-a`); this makes them match. */
export function norm(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/^#/, "").toLowerCase();
}
