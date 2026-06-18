/**
 * Sources — the bridge from raw records to graph nodes.
 *
 * `buildGraph` wants `Node`s, but your data arrives as whatever a database row, an
 * API response, or a CSV line looks like. A `Source` is the small, declarative
 * mapping between the two: name the type and provider, say which field is the id,
 * the label, the foreign keys — and `project()` turns an array of raw records into
 * nodes. Each field is either a property name (a string) or an accessor function for
 * anything computed. This is the "few config steps" — it is the whole adapter.
 *
 * Pure + deterministic. No I/O: you fetch the records however you like (Drizzle,
 * fetch, fs), then hand them to `project`.
 */

import type { Node, NodeType, SourceKind } from "./types";

/** A field is read either by property name or by an accessor function. */
export type Selector<T> = keyof T | ((record: T) => unknown);

export interface SourceConfig<T> {
  /** The node type these records become, e.g. "order". */
  type: NodeType;
  /** The system of origin, e.g. "shopify". Used to build the URN ref + keep refs
   *  from different sources distinct. */
  provider: string;
  /** Optional human source name for diagnostics, e.g. "shopify_graphql.orders". */
  source?: string;
  /** Source transport/kind for diagnostics. */
  kind?: SourceKind;
  /** The record's stable id within its provider. Combined into `<type>:<provider>:<id>`. */
  id: Selector<T>;
  /** Human identifier an edge can resolve TO (order number, email, SKU). Defaults to the id. */
  label?: Selector<T>;
  status?: Selector<T>;
  amount?: Selector<T>;
  currency?: Selector<T>;
  occurredAt?: Selector<T>;
  observedAt?: Selector<T>;
  /** Outgoing foreign keys, keyed by the name a manifest edge's `sourceField` uses.
   *  Each selector may return a scalar or an array; empties are dropped. */
  links?: Record<string, Selector<T>>;
  /** Attach the original record as `node.raw` (default true). */
  keepRaw?: boolean;
}

export interface Source<T> {
  readonly source?: string;
  readonly kind?: SourceKind;
  readonly type: NodeType;
  readonly provider: string;
  /** Project one record into a node. */
  projectOne(record: T): Node;
  /** Project many records into nodes. */
  project(records: readonly T[]): Node[];
}

function read<T>(record: T, sel: Selector<T> | undefined): unknown {
  if (sel === undefined) return undefined;
  return typeof sel === "function" ? sel(record) : record[sel];
}

function asScalarString(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** Coerce a link selector's output into a clean list of string identifiers. */
function asLinkList(v: unknown): string[] {
  const out: string[] = [];
  for (const item of Array.isArray(v) ? v : [v]) {
    const s = asScalarString(item);
    if (s) out.push(s);
  }
  return out;
}

/**
 * Define a source: the declarative mapping from raw records of type `T` to nodes.
 * Returns a `Source` whose `project()` you feed already-fetched records.
 */
export function defineSource<T>(config: SourceConfig<T>): Source<T> {
  const keepRaw = config.keepRaw ?? true;

  const projectOne = (record: T): Node => {
    const id = asScalarString(read(record, config.id));
    if (!id) throw new Error(`weave: source "${config.type}:${config.provider}" produced an empty id for a record`);
    const ref = `${config.type}:${config.provider}:${id}`;

    const links: Record<string, string[]> = {};
    for (const [field, sel] of Object.entries(config.links ?? {})) {
      const list = asLinkList(read(record, sel));
      if (list.length) links[field] = list;
    }
    const observedAt = asScalarString(read(record, config.observedAt));

    const node: Node = {
      ref,
      type: config.type,
      label: asScalarString(read(record, config.label)) ?? id,
      links,
      source: {
        source: config.source ?? `${config.type}:${config.provider}`,
        ...(config.kind ? { kind: config.kind } : {}),
        recordId: id,
        ...(observedAt ? { observedAt } : {}),
      },
    };
    const status = asScalarString(read(record, config.status));
    if (status !== undefined) node.status = status;
    const amount = asNumber(read(record, config.amount));
    if (amount !== undefined) node.amount = amount;
    const currency = asScalarString(read(record, config.currency));
    if (currency !== undefined) node.currency = currency;
    const occurredAt = asScalarString(read(record, config.occurredAt));
    if (occurredAt !== undefined) node.occurredAt = occurredAt;
    if (keepRaw) node.raw = record;
    return node;
  };

  return {
    ...(config.source ? { source: config.source } : {}),
    ...(config.kind ? { kind: config.kind } : {}),
    type: config.type,
    provider: config.provider,
    projectOne,
    project: (records) => records.map(projectOne),
  };
}
