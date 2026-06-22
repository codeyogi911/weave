import { describe, expect, it, vi } from "vitest";
import {
  buildGraph,
  checkGraphInvariants,
  createToolkit,
  defineManifest,
  defineSource,
  manifestOverrideFromConfig,
  mergeManifest,
  weave,
  type EdgeRule,
  type Manifest,
  type Node,
  type ResolvedEdge,
} from "./index";

const orders = defineSource<{ id: number; number: string; email: string }>({
  type: "order",
  provider: "shopify",
  id: "id",
  label: "number",
  links: { customerEmail: "email" },
});
const customers = defineSource<{ email: string }>({ type: "customer", provider: "app", id: "email", label: "email" });

const MANIFEST: Manifest = defineManifest([
  { from: "order", to: "customer", relation: "placed_by", sourceField: "customerEmail", confidence: 1 },
]);

const graph = weave(
  [
    { source: customers, records: [{ email: "ada@x.com" }] },
    { source: orders, records: [{ id: 1, number: "#1001", email: "ada@x.com" }] },
  ],
  MANIFEST,
);

describe("createToolkit", () => {
  it("emits the four graph tools with manifest-derived descriptions", () => {
    const tools = createToolkit(graph, MANIFEST);
    expect(tools.map((t) => t.name)).toEqual(["read_entity", "find_entity", "expand_entity", "graph_health"]);
    // The description names the actual node types and relations of THIS graph.
    expect(tools[0]!.description).toContain("order");
    expect(tools[0]!.description).toContain("placed_by");
  });

  it("read_entity executes and returns the connected cluster", () => {
    const [readEntity] = createToolkit(graph, MANIFEST);
    const view = readEntity!.execute({ seed: "#1001", type: "order" }) as { related: Record<string, unknown[]> };
    expect(view.related.customer).toHaveLength(1);
  });

  it("honors a name prefix and a live graph function", () => {
    let calls = 0;
    const tools = createToolkit(() => ((calls += 1), graph), MANIFEST, { namePrefix: "shop_" });
    expect(tools[0]!.name).toBe("shop_read_entity");
    tools[0]!.execute({ seed: "#1001" });
    expect(calls).toBe(1); // the getter ran on execute, not at creation
  });

  it("find_entity treats limit <= 0 as the default instead of returning nothing", () => {
    const find = createToolkit(graph, MANIFEST).find((t) => t.name === "find_entity")!;
    const all = find.execute({ query: "" }) as unknown[]; // matches every node
    expect((find.execute({ query: "", limit: 0 }) as unknown[]).length).toBe(all.length);
    expect((find.execute({ query: "", limit: -5 }) as unknown[]).length).toBe(all.length);
    expect((find.execute({ query: "", limit: 1 }) as unknown[]).length).toBe(1);
  });
});

// ── Phase 1 + 2: tune_edge / diagnose (detect → propose → repair) ──────────────

type TuneResult = { ok: boolean; reason?: string; edge?: EdgeRule; preview?: string; committed?: boolean; note?: string };
type DiagnoseResult = {
  findingCount: number;
  committable: number;
  findings: { code: string; remedy: { kind: string; note: string; edgeFact?: EdgeRule } }[];
};

// A graph that FALSELY merges two distinct customers: a deterministic self-edge pulls
// customer b into customer a's cluster, so identityTypes:["customer"] reports a collision.
const collisionNodes: Node[] = [
  { ref: "customer:app:a", type: "customer", label: "a", links: { dup: ["customer:app:b"] } },
  { ref: "customer:app:b", type: "customer", label: "b", links: {} },
];
const DUP_MANIFEST: Manifest = defineManifest([
  { from: "customer", to: "customer", relation: "dup", sourceField: "dup", confidence: 1 },
]);
const collisionGraph = buildGraph(collisionNodes, DUP_MANIFEST);

describe("createToolkit — backward compatibility", () => {
  it("emits EXACTLY the four read-only tools when onTuneEdge is absent", () => {
    const tools = createToolkit(graph, MANIFEST);
    expect(tools).toHaveLength(4);
    expect(tools.map((t) => t.name)).toEqual(["read_entity", "find_entity", "expand_entity", "graph_health"]);
  });

  it("adds tune_edge and diagnose only when onTuneEdge is provided", () => {
    const tools = createToolkit(graph, MANIFEST, { onTuneEdge: () => ({ committed: true }) });
    expect(tools).toHaveLength(6);
    expect(tools.map((t) => t.name)).toEqual([
      "read_entity",
      "find_entity",
      "expand_entity",
      "graph_health",
      "tune_edge",
      "diagnose",
    ]);
  });
});

describe("tune_edge", () => {
  const sinkAndTool = () => {
    const sink = vi.fn((_edge: EdgeRule) => ({ committed: true, note: "saved" }));
    const tool = createToolkit(graph, MANIFEST, { onTuneEdge: sink }).find((t) => t.name === "tune_edge")!;
    return { sink, tool };
  };
  const valid = { from: "order", to: "customer", relation: "refers", sourceField: "customerEmail", confidence: 0.9 };

  it("rejects confidence 0 without calling the sink", async () => {
    const { sink, tool } = sinkAndTool();
    const out = (await tool.execute({ ...valid, confidence: 0 })) as TuneResult;
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/confidence/);
    expect(sink).not.toHaveBeenCalled();
  });

  it("rejects confidence > 1 without calling the sink", async () => {
    const { sink, tool } = sinkAndTool();
    const out = (await tool.execute({ ...valid, confidence: 1.5 })) as TuneResult;
    expect(out.ok).toBe(false);
    expect(sink).not.toHaveBeenCalled();
  });

  it("rejects an unknown node type without calling the sink", async () => {
    const { sink, tool } = sinkAndTool();
    const out = (await tool.execute({ ...valid, to: "spaceship" })) as TuneResult;
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/Unknown node type/);
    expect(sink).not.toHaveBeenCalled();
  });

  it("on a valid edge calls the sink once with the parsed EdgeRule and returns a preview", async () => {
    const { sink, tool } = sinkAndTool();
    const out = (await tool.execute(valid)) as TuneResult;
    expect(out.ok).toBe(true);
    expect(sink).toHaveBeenCalledTimes(1);
    const passed = sink.mock.calls[0]![0] as EdgeRule;
    expect(passed).toEqual({ from: "order", to: "customer", relation: "refers", sourceField: "customerEmail", confidence: 0.9 });
    expect(out.edge).toEqual(passed);
    expect(out.committed).toBe(true);
    expect(out.note).toBe("saved");
    expect(out.preview).toContain("next graph build");
    expect(out.preview).toContain("does NOT change the live in-memory graph");
  });
});

describe("diagnose → tune_edge (end-to-end repair loop)", () => {
  const buildToolkit = () => {
    const sink = vi.fn((edge: EdgeRule) => ({ committed: true, note: `stored ${edge.relation}` }));
    const tools = createToolkit(collisionGraph, DUP_MANIFEST, { onTuneEdge: sink, identityTypes: ["customer"] });
    return {
      sink,
      diagnose: tools.find((t) => t.name === "diagnose")!,
      tuneEdge: tools.find((t) => t.name === "tune_edge")!,
    };
  };

  it("enriches each finding with a remedy and proposes a committable edgeFact for the collision", () => {
    const { diagnose } = buildToolkit();
    const out = diagnose.execute({}) as DiagnoseResult;
    const collision = out.findings.find((f) => f.code === "identity_collision")!;
    expect(collision.remedy.kind).toBe("tune_edge");
    expect(collision.remedy.edgeFact).toBeDefined();
    // The proposed fix demotes the over-eager rule below the clustering threshold.
    expect(collision.remedy.edgeFact!.confidence).toBeLessThan(1);
    expect(out.committable).toBeGreaterThanOrEqual(1);
  });

  it("gives advisory remedies (no edgeFact) for projection-level findings", () => {
    const dupNodes: Node[] = [
      { ref: "order:s:1", type: "order", label: "#1", links: {} },
      { ref: "order:s:1", type: "order", label: "#1 dup", links: {} },
    ];
    const sink = vi.fn(() => ({ committed: true }));
    const diagnose = createToolkit(buildGraph(dupNodes, defineManifest([])), defineManifest([]), { onTuneEdge: sink })
      .find((t) => t.name === "diagnose")!;
    const out = diagnose.execute({}) as DiagnoseResult;
    const dup = out.findings.find((f) => f.code === "duplicate_ref")!;
    expect(dup.remedy.kind).toBe("advisory");
    expect(dup.remedy.edgeFact).toBeUndefined();
  });

  it("the edgeFact diagnose proposes validates through tune_edge and reaches the sink", async () => {
    const { sink, diagnose, tuneEdge } = buildToolkit();
    const out = diagnose.execute({}) as DiagnoseResult;
    const edgeFact = out.findings.find((f) => f.code === "identity_collision")!.remedy.edgeFact!;
    const applied = (await tuneEdge.execute(edgeFact as unknown as Record<string, unknown>)) as TuneResult;
    expect(applied.ok).toBe(true);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]![0]).toEqual(edgeFact);
  });

  it("applying the proposed edgeFact actually HEALS the collision on rebuild", () => {
    const { diagnose } = buildToolkit();
    const edgeFact = (diagnose.execute({}) as DiagnoseResult).findings.find((f) => f.code === "identity_collision")!
      .remedy.edgeFact!;
    // Apply it the way a consumer would: stored config → manifest override → rebuild.
    const override = manifestOverrideFromConfig([{ key: `weave.edge.${edgeFact.relation}`, value: edgeFact }], DUP_MANIFEST);
    const healed = buildGraph(collisionNodes, mergeManifest(DUP_MANIFEST, override));
    const findings = checkGraphInvariants(healed, { identityTypes: ["customer"] });
    expect(findings.some((f) => f.code === "identity_collision")).toBe(false);
  });

  // The blocking-bug guard: a collision actually caused by a deterministic extraEdges
  // edge whose relation + endpoint types ALSO match an innocent manifest rule must NOT
  // be marked committable — demoting that rule is a no-op (the extra edge still merges).
  it("refuses a no-op demotion when the collision comes from an extraEdges edge (misattribution guard)", () => {
    const nodes: Node[] = [
      { ref: "customer:app:a", type: "customer", label: "a", links: {} },
      { ref: "customer:app:b", type: "customer", label: "b", links: {} },
    ];
    // The manifest rule resolves NOTHING (no node carries linkField) — it is innocent.
    const manifest = defineManifest([
      { from: "customer", to: "customer", relation: "linked", sourceField: "linkField", confidence: 1 },
    ]);
    // The real culprit: a deterministic, non-manifest edge sharing the same relation+types.
    const extraEdges: ResolvedEdge[] = [
      { from: "customer:app:a", to: "customer:app:b", relation: "linked", confidence: 1, status: "curated" },
    ];
    const g = buildGraph(nodes, manifest, { extraEdges });
    const sink = vi.fn((_edge: EdgeRule) => ({ committed: true }));
    const diagnose = createToolkit(g, manifest, { onTuneEdge: sink, identityTypes: ["customer"] }).find(
      (t) => t.name === "diagnose",
    )!;
    const out = diagnose.execute({}) as DiagnoseResult;
    const collision = out.findings.find((f) => f.code === "identity_collision");
    expect(collision).toBeDefined();
    expect(collision!.remedy.kind).toBe("advisory");
    expect(collision!.remedy.edgeFact).toBeUndefined();
    expect(out.committable).toBe(0);
  });
});
