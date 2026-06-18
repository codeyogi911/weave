import { describe, expect, it } from "vitest";
import {
  buildGraph,
  checkGraphInvariants,
  clusterOf,
  compileGraph,
  defineManifest,
  defineSource,
  expand,
  graphHealth,
  manifestOverrideFromConfig,
  mergeManifest,
  readEntity,
  weave,
  type Manifest,
  type Node,
} from "./index";

// A tiny cross-source domain: orders (Shopify), payments (Stripe), tickets (Zendesk),
// all hanging off a customer keyed by email.
const orders = defineSource<{ id: number; name: string; email: string; total: number }>({
  type: "order",
  provider: "shopify",
  source: "shopify.orders",
  kind: "graphql",
  id: "id",
  label: "name",
  amount: "total",
  currency: () => "USD",
  links: { customerEmail: "email" },
});

const payments = defineSource<{ id: string; order: string; amount: number }>({
  type: "payment",
  provider: "stripe",
  id: "id",
  amount: "amount",
  links: { orderRefs: "order" },
});

const tickets = defineSource<{ id: number; subject: string; requester: string }>({
  type: "ticket",
  provider: "zendesk",
  id: "id",
  label: "subject",
  links: { customerEmail: "requester" },
});

const customers = defineSource<{ email: string }>({
  type: "customer",
  provider: "app",
  id: "email",
  label: "email",
});

const MANIFEST: Manifest = defineManifest([
  { from: "order", to: "customer", relation: "placed_by", sourceField: "customerEmail", confidence: 1 },
  { from: "ticket", to: "customer", relation: "raised_by", sourceField: "customerEmail", confidence: 1 },
  { from: "payment", to: "order", relation: "settles", sourceField: "orderRefs", confidence: 1 },
]);

function fixture() {
  return weave(
    [
      { source: customers, records: [{ email: "ada@x.com" }, { email: "bob@y.com" }] },
      {
        source: orders,
        records: [
          { id: 1001, name: "#1001", email: "ada@x.com", total: 50 },
          { id: 1002, name: "#1002", email: "bob@y.com", total: 30 },
        ],
      },
      { source: payments, records: [{ id: "ch_1", order: "1001", amount: 50 }] },
      { source: tickets, records: [{ id: 7, subject: "where is my order", requester: "ada@x.com" }] },
    ],
    MANIFEST,
  );
}

describe("defineSource", () => {
  it("projects records into URN-keyed nodes with normalized links", () => {
    const [node] = orders.project([{ id: 1001, name: "#1001", email: "ada@x.com", total: 50 }]);
    expect(node).toMatchObject({
      ref: "order:shopify:1001",
      type: "order",
      label: "#1001",
      amount: 50,
      currency: "USD",
      links: { customerEmail: ["ada@x.com"] },
      source: { source: "shopify.orders", kind: "graphql", recordId: "1001" },
    });
  });

  it("drops empty link values and defaults label to id", () => {
    const s = defineSource<{ id: string; ref?: string }>({ type: "x", provider: "p", id: "id", links: { r: "ref" } });
    const n = s.project([{ id: "a" }])[0]!;
    expect(n.label).toBe("a");
    expect(n.links).toEqual({});
  });
});

describe("buildGraph clustering", () => {
  it("unions everything connected by deterministic edges into one cluster", () => {
    const graph = fixture();
    const adaCluster = clusterOf(graph, "customer:app:ada@x.com").map((n) => n.ref).sort();
    // Ada's customer, her order, the payment settling it, and her ticket — one thing.
    expect(adaCluster).toEqual(
      ["customer:app:ada@x.com", "order:shopify:1001", "payment:stripe:ch_1", "ticket:zendesk:7"].sort(),
    );
    // Bob is a separate cluster.
    expect(clusterOf(graph, "customer:app:bob@y.com").map((n) => n.ref)).toEqual(["customer:app:bob@y.com", "order:shopify:1002"]);
  });

  it("resolves edges by normalized label too (#1001 vs 1001)", () => {
    const graph = fixture();
    // The payment links by the order NUMBER "1001"; it still binds to order:shopify:1001 (label "#1001").
    const settles = graph.edges.find((e) => e.relation === "settles");
    expect(settles).toMatchObject({ from: "payment:stripe:ch_1", to: "order:shopify:1001" });
  });
});

describe("fuzzy black-hole guard", () => {
  it("records sub-threshold edges but never merges their clusters", () => {
    const nodes: Node[] = [
      { ref: "person:a:1", type: "person", label: "j smith", links: {} },
      { ref: "person:a:2", type: "person", label: "john smith", links: { maybeSame: ["person:a:1"] } },
    ];
    const manifest = defineManifest([{ from: "person", to: "person", relation: "maybe", sourceField: "maybeSame", confidence: 0.6 }]);
    const graph = buildGraph(nodes, manifest);
    expect(graph.edges).toHaveLength(1); // the fuzzy edge exists for traversal
    expect(graph.clusters).toHaveLength(2); // but the two people stay separate
    expect(graphHealth(graph).fuzzyEdgeCount).toBe(1);
  });
});

describe("readEntity (the agent read)", () => {
  it("returns one entity and its whole cluster, grouped by type, by ref or by number", () => {
    const graph = fixture();
    const byRef = readEntity(graph, "order:shopify:1001");
    const byNumber = readEntity(graph, "#1001", { type: "order" });
    expect(byRef).toEqual(byNumber);
    expect(byRef?.related.customer?.[0]?.label).toBe("ada@x.com");
    expect(byRef?.related.payment).toHaveLength(1);
    expect(byRef?.related.ticket).toHaveLength(1);
    expect(byRef?.edges.length).toBeGreaterThan(0);
  });

  it("returns null for an unknown seed", () => {
    expect(readEntity(fixture(), "order:shopify:9999")).toBeNull();
  });
});

describe("health invariants", () => {
  it("flags an identity collision when two identity nodes land in one cluster", () => {
    // A bad edge merges two distinct customers.
    const nodes: Node[] = [
      { ref: "customer:app:a", type: "customer", label: "a", links: { dup: ["customer:app:b"] } },
      { ref: "customer:app:b", type: "customer", label: "b", links: {} },
    ];
    const manifest = defineManifest([{ from: "customer", to: "customer", relation: "dup", sourceField: "dup", confidence: 1 }]);
    const findings = checkGraphInvariants(buildGraph(nodes, manifest), { identityTypes: ["customer"] });
    expect(findings.map((f) => f.code)).toContain("identity_collision");
  });

  it("a healthy fixture graph has no error-level invariants", () => {
    const findings = checkGraphInvariants(fixture(), { identityTypes: ["customer"] });
    expect(findings.filter((f) => f.severity === "error")).toHaveLength(0);
  });
});

describe("runtime config override", () => {
  it("merges a stored edge onto the base manifest, rejecting unknown node types", () => {
    const base = defineManifest([{ from: "order", to: "customer", relation: "placed_by", sourceField: "customerEmail", confidence: 1 }]);
    const override = manifestOverrideFromConfig(
      [
        { key: "weave.edge.refund", value: { from: "order", to: "customer", relation: "refunded_to", sourceField: "refundEmail", confidence: 1 } },
        { key: "weave.edge.bad", value: { from: "alien", to: "customer", relation: "x", sourceField: "y", confidence: 1 } },
        { key: "unrelated.key", value: { nope: true } },
      ],
      base,
    );
    const merged = mergeManifest(base, override);
    expect(merged.edges).toHaveLength(2); // base + the one valid override; alien rejected
    expect(merged.edges.some((e) => e.relation === "refunded_to")).toBe(true);
  });
});

describe("compileGraph diagnostics", () => {
  it("reports source counts, duplicate refs, and unresolved manifest links", () => {
    const result = compileGraph(
      [
        {
          source: orders,
          records: [
            { id: 1001, name: "#1001", email: "missing@x.com", total: 50 },
            { id: 1001, name: "#1001 duplicate", email: "missing@x.com", total: 50 },
          ],
        },
      ],
      MANIFEST,
    );

    expect(result.diagnostics.sourceCounts[0]).toMatchObject({
      source: "shopify.orders",
      kind: "graphql",
      nodeCount: 2,
      nodesByType: { order: 2 },
    });
    expect(result.diagnostics.duplicateRefs).toEqual(["order:shopify:1001"]);
    expect(result.diagnostics.unresolvedLinks[0]).toMatchObject({
      from: "order:shopify:1001",
      relation: "placed_by",
      sourceField: "customerEmail",
      targetType: "customer",
      value: "missing@x.com",
    });
  });
});

describe("expand", () => {
  it("emits each edge once even when both endpoints are traversed", () => {
    const graph = fixture();
    // Depth 2 from the order reaches the customer and back via the payment/ticket —
    // every edge sits in both endpoints' adjacency, so without dedup they'd double.
    const out = expand(graph, "order:shopify:1001", { depth: 3 });
    const keys = out.edges.map((e) => `${e.from}->${e.relation}->${e.to}`);
    expect(new Set(keys).size).toBe(keys.length); // no duplicates
  });
});

describe("graphHealth isolation", () => {
  it("does NOT count a fuzzy-only-connected node as isolated", () => {
    const nodes: Node[] = [
      { ref: "a:x:1", type: "a", label: "1", links: { soft: ["a:x:2"] } },
      { ref: "a:x:2", type: "a", label: "2", links: {} },
      { ref: "a:x:3", type: "a", label: "3", links: {} }, // truly isolated
    ];
    const manifest = defineManifest([{ from: "a", to: "a", relation: "soft", sourceField: "soft", confidence: 0.5 }]);
    const health = graphHealth(buildGraph(nodes, manifest));
    expect(health.clusterCount).toBe(3); // fuzzy edge doesn't merge clusters
    expect(health.isolatedByType.a).toBe(1); // only node 3 has no edge at all
    expect(health.isolatedSample.map((n) => n.ref)).toEqual(["a:x:3"]);
  });
});
