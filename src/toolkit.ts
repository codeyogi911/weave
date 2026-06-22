/**
 * Toolkit generation — turn a woven graph into a set of agent tools.
 *
 * The point of Weave for agents: instead of giving a model N disconnected "read"
 * tools (one per source) that return disconnected JSON, you give it a handful of
 * graph-shaped tools whose descriptions are generated from YOUR manifest — they name
 * your node types and relations, so the model knows exactly what it can read and how
 * things connect. The model asks "read this order and everything linked", and gets
 * one connected object spanning every source.
 *
 * The emitted `Tool` shape is intentionally framework-neutral (name + description +
 * JSON-Schema parameters + an `execute`), so it maps 1:1 onto the Vercel AI SDK's
 * `tool()`, an MCP tool, or your own dispatcher. Weave itself stays dependency-free.
 */

import { buildGraph, expand, indexNodesByType, resolveManifestLinks } from "./build.js";
import { validateStoredEdge } from "./config.js";
import { checkGraphInvariants, graphHealth, type GraphHealthOptions, type InvariantFinding } from "./health.js";
import { DETERMINISTIC_CONFIDENCE, mergeManifest } from "./manifest.js";
import type { EdgeRule, Graph, Manifest } from "./types.js";
import { findNode, readEntity } from "./weave.js";

/** A value that may be returned directly or as a promise — sinks can be sync or async. */
export type MaybePromise<T> = T | Promise<T>;

/**
 * Consumer-supplied persistence sink for a tuned edge. Weave never owns storage: you
 * receive a fully-VALIDATED `EdgeRule` and persist it however you like (a config row,
 * a KV value, a JSON blob keyed under `weave.edge.*`). Return whether it committed
 * (and an optional note). The fact then applies on the NEXT graph build via
 * `manifestOverrideFromConfig` → `mergeManifest`; it does not mutate the live graph.
 */
export type TuneEdgeSink = (edge: EdgeRule) => MaybePromise<{ committed: boolean; note?: string }>;

/** What `diagnose` attaches to each invariant finding: a committable fix or advice. */
export interface Remedy {
  /** `tune_edge` → `edgeFact` is a ready-to-commit proposal; `advisory` → manual fix. */
  kind: "tune_edge" | "advisory";
  /** Concrete, human-readable guidance on how to repair this finding. */
  note: string;
  /** A proposal that passes `parseStoredEdge` and can be handed straight to `tune_edge`. */
  edgeFact?: EdgeRule;
}

/** An invariant finding enriched with a proposed remedy — what `diagnose` returns. */
export interface EnrichedFinding extends InvariantFinding {
  remedy: Remedy;
}

/** A minimal JSON-Schema object (the subset every tool framework accepts). */
export interface JSONSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

/** A framework-neutral tool descriptor. Maps directly onto AI SDK / MCP tools. */
export interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
  execute: (args: Record<string, unknown>) => unknown;
}

export interface ToolkitOptions extends GraphHealthOptions {
  /** Prefix for tool names, e.g. "shop_" → "shop_read_entity". Default "". */
  namePrefix?: string;
  /** Override the noun used in descriptions (default "entity"). */
  entityNoun?: string;
  /**
   * Persistence sink for tuned edges. When provided, the toolkit additionally emits
   * the `tune_edge` (repair affordance) and `diagnose` (detect → propose) tools,
   * turning the read-only graph into a detect → propose → repair loop. When ABSENT,
   * the toolkit emits exactly the four read-only tools — existing consumers are
   * byte-for-byte unaffected.
   */
  onTuneEdge?: TuneEdgeSink;
}

/** A live graph, or a function returning one (so tools see fresh data each call). */
export type GraphSource = Graph | (() => Graph);

function resolveGraph(src: GraphSource): Graph {
  return typeof src === "function" ? src() : src;
}

function relationsByType(manifest: Manifest): string {
  const lines = manifest.edges
    .map((e) => `  • ${e.from} —${e.relation}→ ${e.to}${e.confidence < 1 ? ` (fuzzy ${e.confidence})` : ""}`)
    .join("\n");
  return lines || "  (no edges declared)";
}

/** A confidence strictly below the clustering threshold (so a demoted rule no longer
 *  auto-merges) and still inside `parseStoredEdge`'s valid `(0, 1]` range. */
function demotedConfidence(threshold: number): number {
  if (!(threshold > 0)) return 0.5; // non-positive / NaN threshold: any (0, 1] value reads as fuzzy
  if (threshold > 1) return 1; // threshold above the valid range: 1 is still strictly below it
  return threshold / 2; // threshold in (0, 1]: strictly below it and > 0
}

/**
 * Candidate manifest rules that COULD be responsible for an identity collision: a
 * deterministic rule whose relation + endpoint types match a deterministic edge
 * incident to a colliding node. This is only a shortlist — a `ResolvedEdge` carries no
 * rule/`sourceField` provenance and `buildGraph` also admits non-manifest deterministic
 * `extraEdges`, so a match here does NOT prove the rule caused the merge. Each candidate
 * is verified by SIMULATION before it is ever proposed as committable.
 */
function candidateRulesForCollision(
  graph: Graph,
  manifest: Manifest,
  finding: InvariantFinding,
  threshold: number,
): EdgeRule[] {
  const candidates = new Map<string, EdgeRule>();
  for (const ref of finding.refs) {
    const idNode = graph.nodesByRef.get(ref);
    if (!idNode) continue;
    for (const e of graph.adjacency.get(ref) ?? []) {
      if (e.confidence < threshold) continue; // only deterministic edges merge clusters
      const otherRef = e.from === ref ? e.to : e.from;
      const otherNode = graph.nodesByRef.get(otherRef);
      if (!otherNode) continue;
      for (const rule of manifest.edges) {
        if (rule.confidence < threshold || rule.relation !== e.relation) continue;
        const forward = rule.from === otherNode.type && rule.to === idNode.type;
        const backward = rule.from === idNode.type && rule.to === otherNode.type;
        if (forward || backward) candidates.set(`${rule.from}|${rule.to}|${rule.relation}|${rule.sourceField}`, rule);
      }
    }
  }
  return [...candidates.values()];
}

/**
 * Prove (don't guess) that demoting `rule` clears THIS collision. Rebuild the graph
 * from the SAME nodes with the rule demoted below threshold, PRESERVING every other
 * deterministic edge currently in the graph that the demoted manifest doesn't itself
 * redraw — crucially the non-manifest `extraEdges` (an external matcher's verdicts),
 * which `Graph` doesn't retain but which still merge on a real rebuild. Returns the
 * demoted `EdgeRule` only if the colliding refs are no longer co-clustered; else null.
 */
function verifiedDemotion(
  graph: Graph,
  manifest: Manifest,
  finding: InvariantFinding,
  rule: EdgeRule,
  threshold: number,
  opts: GraphHealthOptions,
): EdgeRule | null {
  const demoted: EdgeRule = { ...rule, confidence: demotedConfidence(threshold) };
  const override = mergeManifest(manifest, { edges: [demoted] });

  // Which (from→to, relation) does the OVERRIDE manifest itself redraw over these nodes?
  // Everything else deterministic in the live graph is a non-manifest edge we must keep.
  const redrawn = new Set<string>();
  const index = indexNodesByType(graph.nodes);
  resolveManifestLinks(graph.nodes, override, index, (fromRef, toRef, r) => {
    redrawn.add(`${fromRef}->${toRef}->${r.relation}`);
  });
  const preservedExtra = graph.edges.filter(
    (e) => e.confidence >= threshold && !redrawn.has(`${e.from}->${e.to}->${e.relation}`),
  );

  const rebuilt = buildGraph(graph.nodes, override, { extraEdges: preservedExtra, clusterThreshold: threshold });
  // Honest check: re-run the SAME invariants and confirm no identity collision still
  // references these exact refs — the specific finding is gone, not merely fewer.
  const collidingRefs = new Set(finding.refs);
  const cleared = !checkGraphInvariants(rebuilt, opts).some(
    (f) => f.code === "identity_collision" && f.refs.some((r) => collidingRefs.has(r)),
  );
  return cleared ? demoted : null;
}

/** Propose a remedy for one invariant finding. A finding is committable (`kind:
 *  "tune_edge"` with an `edgeFact`) ONLY when SIMULATING that edge-fact provably clears
 *  it — never on a heuristic match — so a collision actually caused by an `extraEdges`
 *  edge is never "fixed" by a no-op rule demotion. Everything else is honest advisory. */
function remedyForFinding(finding: InvariantFinding, graph: Graph, manifest: Manifest, opts: GraphHealthOptions): Remedy {
  const threshold = opts.clusterThreshold ?? DETERMINISTIC_CONFIDENCE;
  switch (finding.code) {
    case "identity_collision": {
      for (const rule of candidateRulesForCollision(graph, manifest, finding, threshold)) {
        const edgeFact = verifiedDemotion(graph, manifest, finding, rule, threshold, opts);
        if (edgeFact) {
          return {
            kind: "tune_edge",
            note:
              `A deterministic rule (${rule.from} —${rule.relation}→ ${rule.to}, via links.${rule.sourceField}) merged ` +
              `distinct "${graph.nodesByRef.get(finding.refs[0] ?? "")?.type ?? "identity"}" entities into one cluster. ` +
              `Verified by simulation: committing this edgeFact demotes that rule to confidence ${edgeFact.confidence} ` +
              `(fuzzy — recorded for traversal, never auto-merges) and the false merge clears on the next build. It ` +
              `overrides the shipped rule by from|to|relation|sourceField.`,
            edgeFact,
          };
        }
      }
      return {
        kind: "advisory",
        note:
          `Distinct identity entities share a deterministic cluster, but no single manifest-rule demotion clears it ` +
          `in simulation — the merge comes from a non-manifest edge (e.g. an extraEdges verdict), multiple rules, or ` +
          `a different deterministic source. An additive edge-fact cannot honestly fix this; review the join that ` +
          `over-merges ${finding.refs.join(", ")} (or the external matcher that emitted the edge) by hand.`,
      };
    }
    case "edge_dangling_endpoint":
      return {
        kind: "advisory",
        note:
          `An edge points at a node that isn't in the graph — a stale reference, or a source that failed to ` +
          `project. No additive edge-fact can fix this: re-run the missing source's projection, or drop the stale ` +
          `reference at projection. Dangling endpoint(s): ${finding.refs.join(", ")}.`,
      };
    case "duplicate_ref":
      return {
        kind: "advisory",
        note:
          `The same entity (ref) was projected more than once. Dedupe at projection — emit one Node per ref before ` +
          `building. An edge-fact cannot fix a duplicated node. Duplicated ref(s): ${finding.refs.join(", ")}.`,
      };
    default:
      return { kind: "advisory", note: "Unrecognized finding — inspect the graph manually." };
  }
}

/**
 * Generate the agent toolkit for a graph. Descriptions are derived from the manifest
 * so the model is told your exact node types and relations. Pass a function for
 * `graph` if your data refreshes between calls.
 */
export function createToolkit(graph: GraphSource, manifest: Manifest, opts: ToolkitOptions = {}): Tool[] {
  const p = opts.namePrefix ?? "";
  const noun = opts.entityNoun ?? "entity";
  const types = manifest.nodeTypes.join(", ");
  const shape = `\n\nNode types: ${types}.\nRelations:\n${relationsByType(manifest)}`;

  const readEntityTool: Tool = {
    name: `${p}read_entity`,
    description:
      `Read one ${noun} and EVERYTHING connected to it across all sources, as one object: ` +
      `the seed, every related node grouped by type, and the edges between them. ` +
      `Seed by ref (e.g. "order:shopify:1001") or by a human number/label (e.g. "#1001").` +
      shape,
    parameters: {
      type: "object",
      properties: {
        seed: { type: "string", description: "A node ref, or a human label/number." },
        type: { type: "string", description: `Optional node type to disambiguate a label. One of: ${types}.` },
      },
      required: ["seed"],
      additionalProperties: false,
    },
    execute: (args) => readEntity(resolveGraph(graph), String(args.seed), args.type ? { type: String(args.type) } : {}),
  };

  const findTool: Tool = {
    name: `${p}find_entity`,
    description: `Find ${noun} nodes whose ref or label contains a query string. Returns compact {ref,type,label} matches.` + shape,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring to match against ref or label (case-insensitive)." },
        type: { type: "string", description: `Optional node type filter. One of: ${types}.` },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: (args) => {
      const g = resolveGraph(graph);
      const q = String(args.query).toLowerCase();
      const type = args.type ? String(args.type) : null;
      const rawLimit = args.limit;
      const limit = typeof rawLimit === "number" && Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 20;
      return g.nodes
        .filter((n) => (!type || n.type === type) && (n.ref.toLowerCase().includes(q) || n.label.toLowerCase().includes(q)))
        .slice(0, limit)
        .map((n) => ({ ref: n.ref, type: n.type, label: n.label }));
    },
  };

  const expandTool: Tool = {
    name: `${p}expand_entity`,
    description:
      `Traverse outward from one ${noun} node to a bounded depth, optionally only along certain relations. ` +
      `Use when you want neighbours a hop or two out rather than the whole cluster.` +
      shape,
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "The node ref to start from." },
        depth: { type: "number", description: "Hops to traverse (default 2)." },
        relations: { type: "array", items: { type: "string" }, description: "Optional relation names to follow." },
      },
      required: ["ref"],
      additionalProperties: false,
    },
    execute: (args) => {
      const g = resolveGraph(graph);
      const node = findNode(g, String(args.ref));
      if (!node) return null;
      const out = expand(g, node.ref, {
        ...(typeof args.depth === "number" ? { depth: args.depth } : {}),
        ...(Array.isArray(args.relations) ? { relations: args.relations.map(String) } : {}),
      });
      return {
        nodes: out.nodes.map((n) => ({ ref: n.ref, type: n.type, label: n.label })),
        edges: out.edges.map((e) => ({ from: e.from, relation: e.relation, to: e.to })),
      };
    },
  };

  const healthTool: Tool = {
    name: `${p}graph_health`,
    description: `Summarize the whole graph: node/edge counts, types, cluster-size distribution, isolated nodes, and any invariant violations.`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: () => graphHealth(resolveGraph(graph), opts),
  };

  const baseTools = [readEntityTool, findTool, expandTool, healthTool];

  // Read-only by default: no persistence sink → exactly the four read tools above.
  const onTuneEdge = opts.onTuneEdge;
  if (!onTuneEdge) return baseTools;

  // Phase 1 — repair affordance. Validates a proposed join against the manifest, then
  // persists it through the consumer's sink. The fact applies on the NEXT build.
  const tuneEdgeTool: Tool = {
    name: `${p}tune_edge`,
    description:
      `Propose a tuned join (an edge rule) for this graph: declare that nodes of one type link to another via a ` +
      `named relation, resolved from a source field. The proposal is validated against the manifest's node types ` +
      `and a confidence in (0, 1] BEFORE anything is persisted; on success it is saved as a tuned-edge fact and ` +
      `merges into the manifest on the NEXT graph build — it does NOT mutate the live in-memory graph right now. ` +
      `Use it to ADD a missing join, or to DEMOTE an over-eager deterministic rule by re-proposing the same ` +
      `from/to/relation/sourceField with confidence below ${DETERMINISTIC_CONFIDENCE} (fuzzy: recorded for ` +
      `traversal, never auto-merges clusters).` +
      shape,
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: `Source node type. One of: ${types}.` },
        to: { type: "string", description: `Target node type. One of: ${types}.` },
        relation: { type: "string", description: 'Semantic relation name, e.g. "placed_by" / "settles".' },
        sourceField: { type: "string", description: "Key in the source node's links whose values point at the target." },
        confidence: { type: "number", description: `1 = deterministic (clusters); <${DETERMINISTIC_CONFIDENCE} = fuzzy (edge only). Must be in (0, 1].` },
        cardinality: { type: "string", description: 'Optional: "1:1" | "1:N" | "N:N".' },
      },
      required: ["from", "to", "relation", "sourceField", "confidence"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const candidate: Record<string, unknown> = {
        from: args.from,
        to: args.to,
        relation: args.relation,
        sourceField: args.sourceField,
        confidence: args.confidence,
        ...(args.cardinality !== undefined ? { cardinality: args.cardinality } : {}),
      };
      const validated = validateStoredEdge(candidate, manifest.nodeTypes);
      if (!validated.ok) return { ok: false, reason: validated.reason };
      const edge = validated.edge;
      const result = await onTuneEdge(edge);
      const preview =
        `On the next graph build this fact merges into the manifest (via manifestOverrideFromConfig → mergeManifest) ` +
        `as: ${edge.from} —${edge.relation}→ ${edge.to}, resolved from links.${edge.sourceField}, confidence ${edge.confidence} ` +
        `(${edge.confidence < DETERMINISTIC_CONFIDENCE ? "fuzzy — recorded for traversal, not auto-merged" : "deterministic — participates in clustering"}). ` +
        `It does NOT change the live in-memory graph now; rebuild to apply.`;
      return {
        ok: true,
        edge,
        preview,
        committed: result.committed,
        ...(result.note !== undefined ? { note: result.note } : {}),
      };
    },
  };

  // Phase 2 — detect → propose. Runs the invariant checks and enriches each finding
  // with a remedy; committable ones carry an `edgeFact` ready for `tune_edge`.
  const diagnoseTool: Tool = {
    name: `${p}diagnose`,
    description:
      `Diagnose the graph's structural health and propose fixes: runs the same invariant checks as ${p}graph_health ` +
      `and returns each finding ENRICHED with a remedy. A remedy is either a ready-to-commit edgeFact you pass to ` +
      `${p}tune_edge (e.g. demoting a rule that falsely merged two distinct entities), or advisory guidance for ` +
      `problems no additive edge-fact can fix (duplicate projections, stale/dangling references). Detect → propose → ` +
      `repair, all derived from your manifest.` +
      shape,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: () => {
      const g = resolveGraph(graph);
      const health = graphHealth(g, opts);
      const findings: EnrichedFinding[] = health.invariants.map((f) => ({
        ...f,
        remedy: remedyForFinding(f, g, manifest, opts),
      }));
      return {
        nodeCount: health.nodeCount,
        edgeCount: health.edgeCount,
        clusterCount: health.clusterCount,
        findingCount: findings.length,
        committable: findings.filter((f) => f.remedy.kind === "tune_edge").length,
        findings,
      };
    },
  };

  return [...baseTools, tuneEdgeTool, diagnoseTool];
}
