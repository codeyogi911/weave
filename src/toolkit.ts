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

import { expand } from "./build.js";
import { graphHealth, type GraphHealthOptions } from "./health.js";
import type { Graph, Manifest } from "./types.js";
import { findNode, readEntity } from "./weave.js";

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

  return [readEntityTool, findTool, expandTool, healthTool];
}
