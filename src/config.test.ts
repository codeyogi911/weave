import { describe, expect, it } from "vitest";
import {
  EDGE_CONFIG_PREFIX,
  defineManifest,
  manifestOverrideFromConfig,
  mergeManifest,
  norm,
  parseStoredEdge,
  type EdgeRule,
  type NodeType,
} from "./index";

const NODE_TYPES: NodeType[] = ["order", "customer"];
const VALID = { from: "order", to: "customer", relation: "placed_by", sourceField: "customerEmail", confidence: 1 };

describe("parseStoredEdge — structure", () => {
  it("parses a well-formed record into an EdgeRule", () => {
    expect(parseStoredEdge(VALID, NODE_TYPES)).toEqual<EdgeRule>({
      from: "order",
      to: "customer",
      relation: "placed_by",
      sourceField: "customerEmail",
      confidence: 1,
    });
  });

  it("rejects non-object values", () => {
    for (const v of [null, undefined, "edge", 42, true, []]) {
      expect(parseStoredEdge(v, NODE_TYPES)).toBeNull();
    }
  });

  it("rejects a record missing any required string field", () => {
    for (const k of ["from", "to", "relation", "sourceField"] as const) {
      const { [k]: _drop, ...rest } = VALID;
      expect(parseStoredEdge(rest, NODE_TYPES)).toBeNull();
    }
  });

  it("rejects empty / whitespace-only string fields", () => {
    expect(parseStoredEdge({ ...VALID, relation: "   " }, NODE_TYPES)).toBeNull();
    expect(parseStoredEdge({ ...VALID, sourceField: "" }, NODE_TYPES)).toBeNull();
  });

  it("trims surrounding whitespace on string fields", () => {
    const edge = parseStoredEdge({ ...VALID, relation: "  placed_by  " }, NODE_TYPES);
    expect(edge?.relation).toBe("placed_by");
  });
});

describe("parseStoredEdge — confidence bound (0, 1]", () => {
  it("accepts the inclusive upper and an interior value", () => {
    expect(parseStoredEdge({ ...VALID, confidence: 1 }, NODE_TYPES)?.confidence).toBe(1);
    expect(parseStoredEdge({ ...VALID, confidence: 0.5 }, NODE_TYPES)?.confidence).toBe(0.5);
  });

  it("rejects 0, negatives, and anything above 1 (exclusive lower / inclusive upper)", () => {
    for (const c of [0, -0.1, 1.0001, 2]) {
      expect(parseStoredEdge({ ...VALID, confidence: c }, NODE_TYPES)).toBeNull();
    }
  });

  it("rejects non-finite or non-number confidence", () => {
    for (const c of [Number.NaN, Number.POSITIVE_INFINITY, "1", null, undefined]) {
      expect(parseStoredEdge({ ...VALID, confidence: c }, NODE_TYPES)).toBeNull();
    }
  });
});

describe("parseStoredEdge — node-type guardrail", () => {
  it("rejects an edge whose `from` is not a known node type", () => {
    expect(parseStoredEdge({ ...VALID, from: "alien" }, NODE_TYPES)).toBeNull();
  });

  it("rejects an edge whose `to` is not a known node type", () => {
    expect(parseStoredEdge({ ...VALID, to: "alien" }, NODE_TYPES)).toBeNull();
  });

  it("never lets stored config introduce a new entity kind", () => {
    // Both endpoints unknown — must not slip a brand-new type into the graph.
    expect(parseStoredEdge({ ...VALID, from: "gadget", to: "widget" }, NODE_TYPES)).toBeNull();
  });
});

describe("parseStoredEdge — cardinality", () => {
  it("keeps a valid cardinality and drops an invalid one", () => {
    expect(parseStoredEdge({ ...VALID, cardinality: "1:N" }, NODE_TYPES)?.cardinality).toBe("1:N");
    expect(parseStoredEdge({ ...VALID, cardinality: "many" }, NODE_TYPES)).not.toHaveProperty("cardinality");
    expect(parseStoredEdge({ ...VALID, cardinality: "many" }, NODE_TYPES)?.from).toBe("order");
  });
});

describe("manifestOverrideFromConfig", () => {
  const base = defineManifest([VALID]);

  it("returns undefined when no record yields a valid edge", () => {
    expect(manifestOverrideFromConfig([], base)).toBeUndefined();
    expect(
      manifestOverrideFromConfig([{ key: `${EDGE_CONFIG_PREFIX}bad`, value: { from: "alien" } }], base),
    ).toBeUndefined();
  });

  it("only reads records under the config prefix", () => {
    const override = manifestOverrideFromConfig(
      [
        { key: "unrelated.key", value: VALID },
        { key: `${EDGE_CONFIG_PREFIX}refund`, value: { ...VALID, relation: "refunded_to", sourceField: "refundEmail" } },
      ],
      base,
    );
    expect(override?.edges).toHaveLength(1);
    expect(override?.edges?.[0]?.relation).toBe("refunded_to");
  });

  it("honors a custom prefix", () => {
    const records = [{ key: "custom.edge.x", value: { ...VALID, relation: "tagged" } }];
    expect(manifestOverrideFromConfig(records, base, "custom.edge.")?.edges?.[0]?.relation).toBe("tagged");
    expect(manifestOverrideFromConfig(records, base)).toBeUndefined(); // default prefix doesn't match
  });
});

describe("mergeManifest", () => {
  const base = defineManifest([VALID]);

  it("returns the base unchanged for an undefined override", () => {
    expect(mergeManifest(base, undefined)).toBe(base);
  });

  it("replaces an edge with the same (from,to,relation,sourceField) and unions node types", () => {
    const override = { edges: [{ ...VALID, confidence: 0.5 }], nodeTypes: ["refund"] };
    const merged = mergeManifest(base, override);
    expect(merged.edges).toHaveLength(1); // same key → replaced, not appended
    expect(merged.edges[0]?.confidence).toBe(0.5);
    expect(merged.nodeTypes).toEqual(expect.arrayContaining(["order", "customer", "refund"]));
  });

  it("appends an edge with a new key", () => {
    const merged = mergeManifest(base, { edges: [{ ...VALID, relation: "billed_to", sourceField: "billEmail" }] });
    expect(merged.edges).toHaveLength(2);
  });
});

describe("norm", () => {
  it("trims, strips a single leading #, and lowercases", () => {
    expect(norm("  #1001 ")).toBe("1001");
    expect(norm("SKU-A")).toBe("sku-a");
  });

  it("maps nullish to the empty string", () => {
    expect(norm(null)).toBe("");
    expect(norm(undefined)).toBe("");
  });
});
