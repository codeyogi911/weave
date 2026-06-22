import { describe, expect, it } from "vitest";
import {
  buildGraph,
  checkGraphInvariants,
  defineManifest,
  graphHealth,
  type Graph,
  type Node,
} from "./index";

describe("checkGraphInvariants — duplicate_ref", () => {
  it("flags the same entity projected more than once", () => {
    // Two nodes with the same ref: the nodesByRef Map dedups, the nodes array doesn't.
    const nodes: Node[] = [
      { ref: "order:s:1", type: "order", label: "#1", links: {} },
      { ref: "order:s:1", type: "order", label: "#1 dup", links: {} },
    ];
    const findings = checkGraphInvariants(buildGraph(nodes, defineManifest([])));
    expect(findings.map((f) => f.code)).toContain("duplicate_ref");
    const dup = findings.find((f) => f.code === "duplicate_ref")!;
    expect(dup.severity).toBe("error");
    expect(dup.refs).toContain("order:s:1");
  });
});

describe("checkGraphInvariants — edge_dangling_endpoint", () => {
  it("flags an edge pointing at a node not in the graph", () => {
    const a: Node = { ref: "a:x:1", type: "a", label: "1", links: {} };
    const graph: Graph = {
      nodes: [a],
      nodesByRef: new Map([[a.ref, a]]),
      edges: [{ from: "a:x:1", to: "a:x:missing", relation: "points_at", confidence: 1 }],
      adjacency: new Map(),
      clusters: [{ id: "a:x:1", nodeRefs: ["a:x:1"] }],
    };
    const findings = checkGraphInvariants(graph);
    const dangling = findings.find((f) => f.code === "edge_dangling_endpoint")!;
    expect(dangling).toBeTruthy();
    expect(dangling.severity).toBe("error");
    expect(dangling.refs).toContain("a:x:missing");
  });
});

describe("checkGraphInvariants — identity types", () => {
  it("emits no identity invariant when identityTypes is empty (the default)", () => {
    const nodes: Node[] = [
      { ref: "customer:app:a", type: "customer", label: "a", links: { dup: ["customer:app:b"] } },
      { ref: "customer:app:b", type: "customer", label: "b", links: {} },
    ];
    const manifest = defineManifest([{ from: "customer", to: "customer", relation: "dup", sourceField: "dup", confidence: 1 }]);
    const graph = buildGraph(nodes, manifest);
    expect(checkGraphInvariants(graph).map((f) => f.code)).not.toContain("identity_collision");
    expect(checkGraphInvariants(graph, { identityTypes: ["customer"] }).map((f) => f.code)).toContain("identity_collision");
  });
});

describe("graphHealth report shape", () => {
  it("tallies edges by relation and bins cluster sizes", () => {
    const nodes: Node[] = [
      { ref: "order:s:1", type: "order", label: "#1", links: { by: ["customer:a:ada"] } },
      { ref: "customer:a:ada", type: "customer", label: "ada", links: {} },
      { ref: "order:s:2", type: "order", label: "#2", links: {} }, // isolated
    ];
    const manifest = defineManifest([{ from: "order", to: "customer", relation: "placed_by", sourceField: "by", confidence: 1 }]);
    const health = graphHealth(buildGraph(nodes, manifest));
    expect(health.nodeCount).toBe(3);
    expect(health.edgeCount).toBe(1);
    expect(health.edgesByRelation).toEqual({ placed_by: 1 });
    expect(health.nodesByType).toEqual({ order: 2, customer: 1 });
    // One 2-node cluster (order+customer) and one singleton (the isolated order).
    expect(health.clusterSizeHistogram).toEqual({ "1": 1, "2": 1 });
    expect(health.isolatedByType).toEqual({ order: 1 });
    expect(health.largestClusters[0]?.size).toBe(2);
  });
});
