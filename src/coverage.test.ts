import { describe, expect, it } from "vitest";
import {
  buildGraph,
  checkCoverage,
  coverageComplete,
  createToolkit,
  defineManifest,
  defineSource,
  graphHealth,
  impairedLegsForType,
  weave,
  type EnrichedFinding,
  type Graph,
  type Manifest,
  type SourceCoverage,
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

const WHOLE: SourceCoverage = { source: "shopify.orders", types: ["order"], swept: true, count: 1 };
const ERRORED: SourceCoverage = {
  source: "zoho.invoices",
  types: ["invoice"],
  swept: true,
  count: 0,
  errors: ["Zoho token refresh HTTP 400: too many requests continuously"],
};
const TRUNCATED: SourceCoverage = { source: "shopify.orders", types: ["order"], swept: true, count: 250, truncated: true };
const SKIPPED: SourceCoverage = { source: "zoho.payments", types: ["payment"], swept: false, errors: ["gathered point-wise by design"] };

describe("coverageComplete", () => {
  it("is true when every attempted leg came back whole; skipped legs don't count", () => {
    expect(coverageComplete([WHOLE, SKIPPED])).toBe(true);
  });

  it("is false on an errored or truncated leg", () => {
    expect(coverageComplete([WHOLE, ERRORED])).toBe(false);
    expect(coverageComplete([TRUNCATED])).toBe(false);
  });
});

describe("checkCoverage", () => {
  it("emits source_error (error) for a failed leg and source_truncated (warn) for a capped one", () => {
    const findings = checkCoverage([WHOLE, ERRORED, TRUNCATED, SKIPPED]);
    expect(findings).toHaveLength(2);
    const error = findings.find((f) => f.code === "source_error")!;
    expect(error.severity).toBe("error");
    expect(error.source).toBe("zoho.invoices");
    expect(error.refs).toEqual(["invoice"]);
    expect(error.message).toContain("too many requests");
    const warn = findings.find((f) => f.code === "source_truncated")!;
    expect(warn.severity).toBe("warn");
    expect(warn.source).toBe("shopify.orders");
  });

  it("stays silent on a fully-whole report", () => {
    expect(checkCoverage([WHOLE, SKIPPED])).toEqual([]);
  });
});

describe("impairedLegsForType", () => {
  it("returns only swept legs feeding the type that errored or truncated", () => {
    expect(impairedLegsForType([WHOLE, ERRORED, SKIPPED], "invoice").map((l) => l.source)).toEqual(["zoho.invoices"]);
    expect(impairedLegsForType([WHOLE, ERRORED, SKIPPED], "order")).toEqual([]);
    // A skipped leg is never "impaired" — skipping is policy, not failure.
    expect(impairedLegsForType([SKIPPED], "payment")).toEqual([]);
  });
});

describe("graphHealth with coverage", () => {
  it("carries the report + coverageComplete and folds coverage findings into invariants", () => {
    const health = graphHealth(graph, { coverage: [WHOLE, ERRORED] });
    expect(health.coverageComplete).toBe(false);
    expect(health.coverage).toHaveLength(2);
    expect(health.invariants.some((f) => f.code === "source_error")).toBe(true);
  });

  it("omits coverage fields when no report is supplied (back-compat)", () => {
    const health = graphHealth(graph);
    expect(health.coverage).toBeUndefined();
    expect(health.coverageComplete).toBeUndefined();
    expect(health.invariants).toEqual([]);
  });

  it("accepts a coverage thunk (live report alongside a live graph)", () => {
    let calls = 0;
    const health = graphHealth(graph, {
      coverage: () => ((calls += 1), [ERRORED]),
    });
    expect(health.coverageComplete).toBe(false);
    expect(calls).toBe(1); // resolved once, shared by report + invariants
  });
});

describe("toolkit emission matrix", () => {
  const names = (opts: Parameters<typeof createToolkit>[2]) => createToolkit(graph, MANIFEST, opts).map((t) => t.name);

  it("no repair executors → the four read tools (byte-for-byte back-compat)", () => {
    expect(names({})).toEqual(["read_entity", "find_entity", "expand_entity", "graph_health"]);
  });

  it("onTuneEdge only → + tune_edge + diagnose (0.2.0 behaviour)", () => {
    expect(names({ onTuneEdge: () => ({ committed: true }) })).toEqual([
      "read_entity",
      "find_entity",
      "expand_entity",
      "graph_health",
      "tune_edge",
      "diagnose",
    ]);
  });

  it("onResweep only → + diagnose + resweep_source (no tune_edge without its sink)", () => {
    expect(names({ onResweep: () => ({ ok: true }) })).toEqual([
      "read_entity",
      "find_entity",
      "expand_entity",
      "graph_health",
      "diagnose",
      "resweep_source",
    ]);
  });

  it("both sinks → all seven tools", () => {
    expect(names({ onTuneEdge: () => ({ committed: true }), onResweep: () => ({ ok: true }) })).toHaveLength(7);
  });
});

describe("diagnose + resweep over an impaired source", () => {
  const opts = {
    coverage: [WHOLE, ERRORED] as SourceCoverage[],
    onResweep: () => ({ ok: true, note: "re-swept" }),
  };

  it("enriches a source_error finding with a committable resweep remedy", () => {
    const tools = createToolkit(graph, MANIFEST, opts);
    const diagnose = tools.find((t) => t.name === "diagnose")!;
    const out = diagnose.execute({}) as { coverageComplete: boolean; committable: number; findings: EnrichedFinding[] };
    expect(out.coverageComplete).toBe(false);
    const finding = out.findings.find((f) => f.code === "source_error")!;
    expect(finding.remedy.kind).toBe("resweep");
    expect(finding.remedy.resweepTarget).toEqual({ source: "zoho.invoices" });
    expect(out.committable).toBeGreaterThanOrEqual(1);
  });

  it("downgrades to advisory when no resweep executor is wired", () => {
    const tools = createToolkit(graph, MANIFEST, { coverage: [ERRORED], onTuneEdge: () => ({ committed: true }) });
    const diagnose = tools.find((t) => t.name === "diagnose")!;
    const out = diagnose.execute({}) as { findings: EnrichedFinding[] };
    expect(out.findings[0]!.remedy.kind).toBe("advisory");
  });

  it("resweep_source hands the leg id to the sink and rejects unknown legs", async () => {
    const swept: string[] = [];
    const tools = createToolkit(graph, MANIFEST, {
      coverage: [WHOLE, ERRORED],
      onResweep: (t) => (swept.push(t.source), { ok: true, note: "leg re-run" }),
    });
    const resweep = tools.find((t) => t.name === "resweep_source")!;

    const ok = (await resweep.execute({ source: "zoho.invoices" })) as { ok: boolean; note?: string; followUp: string };
    expect(ok.ok).toBe(true);
    expect(ok.note).toBe("leg re-run");
    expect(swept).toEqual(["zoho.invoices"]);

    const bad = (await resweep.execute({ source: "nope.nothing" })) as { ok: boolean; reason?: string };
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain("zoho.invoices");
  });

  it("attributes dangling endpoints to an impaired leg instead of calling them stale", () => {
    // Hand-construct a graph whose edge points at an invoice that never projected —
    // exactly what a consumer that keeps its own edge list sees when a leg fails.
    const orderNode = { ref: "order:shopify:1", type: "order", label: "#1001", links: {} };
    const built = buildGraph([orderNode], MANIFEST);
    const withDangling: Graph = {
      ...built,
      edges: [...built.edges, { from: "order:shopify:1", to: "invoice:zoho:9", relation: "billed_by", confidence: 1 }],
    };
    const tools = createToolkit(withDangling, MANIFEST, opts);
    const diagnose = tools.find((t) => t.name === "diagnose")!;
    const out = diagnose.execute({}) as { findings: EnrichedFinding[] };
    const dangling = out.findings.find((f) => f.code === "edge_dangling_endpoint")!;
    expect(dangling.remedy.kind).toBe("resweep");
    expect(dangling.remedy.resweepTarget).toEqual({ source: "zoho.invoices" });
    expect(dangling.remedy.note).toContain("coverage artifact");
  });
});
