/**
 * Runtime-tunable joins — the READ side, pure.
 *
 * Sometimes the join grammar isn't known at build time: different tenants, customers,
 * or deployments stitch their records with different keys. Instead of forking code,
 * persist each tuned edge as a small config record (a row, a KV value, a JSON blob)
 * and `merge` it onto the shipped manifest at build time. An absent config is exactly
 * the default behaviour.
 *
 * This module is intentionally LENIENT on read: it validates structure + node-type
 * membership and drops anything malformed rather than throwing — a hand-edited or
 * legacy config record must never break a build. Validate strictly on the WRITE side.
 *
 * Guardrail: a stored edge may only reference node types already in the base
 * manifest. Stored config can retune how known types join; it can't introduce a new
 * entity kind out of band. Pure + deterministic: config in, manifest override out.
 */

import type { EdgeRule, Manifest, NodeType } from "./types.js";

/** Default config-key prefix for a tuned edge: `weave.edge.<id>`. */
export const EDGE_CONFIG_PREFIX = "weave.edge.";

/** A stored config record, narrowed to what this parser needs. */
export interface ConfigRecord {
  key: string;
  value: unknown;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** The outcome of validating a stored value: the parsed edge, or a human reason it
 *  was rejected. `parseStoredEdge` is the boolean-style wrapper; callers that want to
 *  tell a user WHY (e.g. an agent tool) read `reason` directly. */
export type StoredEdgeValidation = { ok: true; edge: EdgeRule } | { ok: false; reason: string };

/**
 * Validate one stored value into an `EdgeRule` or an explained rejection. `from`/`to`
 * must be members of `nodeTypes`; `relation` + `sourceField` must be non-empty;
 * `confidence` must be in (0, 1]. This is the single source of truth for the rules —
 * {@link parseStoredEdge} wraps it, so the two can never drift.
 */
export function validateStoredEdge(value: unknown, nodeTypes: readonly NodeType[]): StoredEdgeValidation {
  if (!value || typeof value !== "object") return { ok: false, reason: "Edge proposal must be an object." };
  const r = value as Record<string, unknown>;
  const fields = { from: asString(r.from), to: asString(r.to), relation: asString(r.relation), sourceField: asString(r.sourceField) };
  const missing = (Object.keys(fields) as (keyof typeof fields)[]).filter((k) => !fields[k]);
  if (missing.length) return { ok: false, reason: `Missing or empty required field(s): ${missing.join(", ")}.` };
  const from = fields.from as string;
  const to = fields.to as string;
  // Node-type guardrail: never let a stored record introduce a new entity kind.
  const unknownTypes = [from, to].filter((t) => !nodeTypes.includes(t));
  if (unknownTypes.length)
    return { ok: false, reason: `Unknown node type(s): ${unknownTypes.map((t) => JSON.stringify(t)).join(", ")}. Known types: ${nodeTypes.join(", ")}.` };
  const confidence = typeof r.confidence === "number" && Number.isFinite(r.confidence) ? r.confidence : NaN;
  if (!(confidence > 0 && confidence <= 1)) return { ok: false, reason: `confidence must be a number in (0, 1]; got ${JSON.stringify(r.confidence)}.` };
  const cardinality = r.cardinality === "1:1" || r.cardinality === "1:N" || r.cardinality === "N:N" ? r.cardinality : undefined;
  return {
    ok: true,
    edge: { from, to, relation: fields.relation as string, sourceField: fields.sourceField as string, confidence, ...(cardinality ? { cardinality } : {}) },
  };
}

/**
 * Validate one stored value into an `EdgeRule`, or `null` if malformed / out of
 * scope. A thin boolean-style wrapper over {@link validateStoredEdge}.
 */
export function parseStoredEdge(value: unknown, nodeTypes: readonly NodeType[]): EdgeRule | null {
  const result = validateStoredEdge(value, nodeTypes);
  return result.ok ? result.edge : null;
}

/**
 * Collect stored `<prefix><id>` config records into a manifest override. `base`
 * supplies the fixed node-type set used to reject out-of-scope edges. Returns
 * `undefined` when there are no valid edges, so callers can pass it straight to
 * `mergeManifest` (which treats `undefined` as "use the base unchanged").
 */
export function manifestOverrideFromConfig(
  records: readonly ConfigRecord[],
  base: Manifest,
  prefix: string = EDGE_CONFIG_PREFIX,
): Partial<Manifest> | undefined {
  const edges: EdgeRule[] = [];
  for (const f of records) {
    if (!f.key.startsWith(prefix)) continue;
    const edge = parseStoredEdge(f.value, base.nodeTypes);
    if (edge) edges.push(edge);
  }
  return edges.length ? { edges } : undefined;
}
