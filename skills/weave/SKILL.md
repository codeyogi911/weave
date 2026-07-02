---
name: weave
description: Wire the @shashwatjain511/weave package into a project — build an in-memory graph over heterogeneous sources (databases, APIs, files) and generate an agent toolkit from it. Use when a user wants to stitch records from multiple systems into one connected graph, resolve entities across sources that don't share an id scheme, give an agent a "read this entity and everything linked to it" tool, or set up defineSource / manifest / createToolkit. Triggers on @shashwatjain511/weave, defineSource, buildGraph, GraphManifest, createToolkit, or "graph over my sources".
metadata:
  short-description: Wire @shashwatjain511/weave onto a project's real sources
---

# Wiring weave onto real sources

`@shashwatjain511/weave` joins records from many systems into one in-memory graph you can cluster, traverse, and hand to an agent as a toolkit. It is pure and deterministic: **you fetch the records however you like, weave joins them.** No database, no server, no I/O inside weave.

Your job when this skill loads: turn the user's actual sources into a working graph + toolkit. Do it in this order — do not skip the inventory step, it prevents the one mistake that matters.

## 0. Confirm install

```bash
npm install @shashwatjain511/weave
```

## 1. Inventory the sources and their join keys FIRST

Before writing any code, build this table with the user (read their schema / API types; ask only what you can't infer):

| Source | Becomes node type | Stable id (within source) | Human label others reference it BY | Outgoing keys (what it points at, and by which field) |
|---|---|---|---|---|

The critical column is the third one. Systems rarely share an id scheme: one holds the order *id*, another references the order *number*, a third knows only the *email*. weave matches an edge's value against a target node's **ref OR label** (normalized: trimmed, lowercased, leading `#` dropped). So whatever value source B uses to point at source A must equal A's `id` **or** A's `label`. Get this mapping right and everything else follows.

## 2. One `defineSource` per source

Each field is a property name (string) or an accessor `(record) => value`. `links` are the outgoing foreign keys, keyed by the name your manifest will reference.

```ts
import { defineSource } from "@shashwatjain511/weave";

const orders = defineSource<OrderRow>({
  type: "order",
  provider: "shopify",          // ref becomes "order:shopify:<id>"
  id: "id",
  label: "number",              // so a "by number" edge resolves to this node
  amount: "total",
  links: { customerEmail: "email", productSkus: "skus" },
});
```

Rules:
- `provider` is the system of origin; it keeps refs from different sources distinct.
- `label` should be the human value OTHER sources use to reference this record (order number, email, SKU). Default is the id.
- A `links` selector may return a scalar or an array; empties are dropped automatically.

## 3. Write the manifest — and apply the ONE rule

The manifest is plain data: how types connect. `defineManifest` infers node types from the edges.

```ts
import { defineManifest } from "@shashwatjain511/weave";

const manifest = defineManifest([
  { from: "order",   to: "customer", relation: "placed_by", sourceField: "customerEmail", confidence: 1 },
  { from: "payment", to: "order",    relation: "settles",   sourceField: "orderRefs",     confidence: 1 },
  // Shared dimension — see the rule below.
  { from: "order",   to: "product",  relation: "contains",  sourceField: "productSkus",   confidence: 0.9 },
]);
```

**THE RULE (the only modeling mistake that matters):**
> Clusters form over **confidence-1 (deterministic)** edges only. Use confidence 1 for edges that define **one real-world thing** (an order's customer, its payment, its shipment). Use **confidence < 1** for edges through **shared/reference data** — a product catalog, a tag, a category, a shared address. A shared node joined at confidence 1 will union unrelated entities into one giant cluster (a false merge). Sub-1 edges are still recorded and fully traversable; they just never merge clusters.

If you feed verdicts from a fuzzy matcher / ML model, pass them as `buildGraph(..., { extraEdges })` with their true confidence and provenance (`status`, `evidence`, `ruleId`).

## 4. Weave, then VERIFY before trusting it

```ts
import { weave, graphHealth } from "@shashwatjain511/weave";

const graph = weave(
  [
    { source: customers, records: await fetchCustomers() },
    { source: orders,    records: await fetchOrders() },
    { source: payments,  records: await fetchPayments() },
  ],
  manifest,
);

const health = graphHealth(graph, { identityTypes: ["customer"] });
```

Check the health report — this is how you know the joins are right, not vibes:
- `invariants` must have **no `error`** findings. An `identity_collision` means a deterministic edge merged two distinct identities → you violated THE RULE (a shared dimension is at confidence 1). Fix the manifest, not the data.
- `clusterSizeHistogram`: one enormous cluster usually means a false-merge through shared data. Lots of size-1 clusters means a join key isn't resolving — check that source B's pointer value matches source A's id/label after normalization.
- `isolatedByType` / `nodesByType`: sanity-check the counts against what you expect.

List `identityTypes` for every type that represents a unique real-world entity (customer, user, account, device) so collisions are caught as errors.

## 5. Generate the agent toolkit and wire it in

```ts
import { createToolkit } from "@shashwatjain511/weave";

const tools = createToolkit(() => graph, manifest, { identityTypes: ["customer"] });
// → read_entity · find_entity · expand_entity · graph_health
```

Pass `() => graph` (a getter) if the data refreshes between calls. Each tool is `{ name, description, parameters, execute }` — the descriptions are generated from the manifest, so the model is told your exact node types and relations. Map to the host framework:

```ts
// Vercel AI SDK
import { tool } from "ai";
const aiTools = Object.fromEntries(
  tools.map((t) => [t.name, tool({ description: t.description, inputSchema: t.parameters, execute: t.execute })]),
);

// MCP: register each as a tool with inputSchema = t.parameters and handler = t.execute.
```

## 6. Close the loop — coverage + self-healing (production)

Real source reads fail (rate limits, timeouts, row caps), and a graph built from partial reads lies by omission. In production, report **coverage** — how each read went — and wire the repair executors, so the agent can *detect and fix* a partial graph instead of reasoning over one:

```ts
const tools = createToolkit(() => graph, manifest, {
  identityTypes: ["customer"],
  coverage: () => lastSweep.coverage,   // SourceCoverage[]: { source, types, swept, count?, truncated?, errors? }
  onTuneEdge: async (edge) => persistEdgeFact(edge),        // grammar repair (gate writes behind approval)
  onResweep:  async ({ source }) => resweepLeg(source),     // data repair (reads only — safe unattended)
});
// → the four read tools · tune_edge · diagnose · resweep_source
```

`diagnose` returns findings with remedies: an `edgeFact` (hand to `tune_edge` — a join is wrong for this deployment), a `resweepTarget` (hand to `resweep_source` — a read failed/truncated this sweep), or honest `advisory` text. Teach your agent the loop: **diagnose → apply the committable remedies → diagnose again**.

## Done-when checklist

- [ ] One `defineSource` per system; `label` is the value others reference it by.
- [ ] Manifest edges: confidence 1 only for "one real-world thing"; shared dimensions < 1.
- [ ] `graphHealth` shows zero error invariants and a sane cluster distribution.
- [ ] `read_entity("<a real id/number>")` returns the expected cross-source cluster — and nothing from an unrelated entity.
- [ ] Toolkit mapped into the host agent framework.
- [ ] Production: coverage reported per source leg + `onResweep` wired, so a failed read is a diagnosable, agent-fixable finding — not a silently thin graph.

## Reference

Full API table and a runnable five-source example are in the package `README.md` and `examples/agent-360/`. Read those if a behavior is unclear rather than guessing — the engine is ~650 lines and the example covers every export.
