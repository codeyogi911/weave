import { describe, expect, it } from "vitest";
import {
  defineManifest,
  defineSource,
  diagnoseGraphInputs,
  projectSourceInputs,
  type Manifest,
} from "./index";

const orders = defineSource<{ id: number; number: string; email: string }>({
  type: "order",
  provider: "shopify",
  source: "shopify.orders",
  kind: "rest",
  id: "id",
  label: "number",
  links: { customerEmail: "email" },
});
const customers = defineSource<{ email: string }>({ type: "customer", provider: "app", id: "email", label: "email" });

const MANIFEST: Manifest = defineManifest([
  { from: "order", to: "customer", relation: "placed_by", sourceField: "customerEmail", confidence: 1 },
]);

describe("projectSourceInputs", () => {
  it("projects every source's records into a flat node list", () => {
    const nodes = projectSourceInputs([
      { source: customers, records: [{ email: "ada@x.com" }] },
      { source: orders, records: [{ id: 1, number: "#1001", email: "ada@x.com" }] },
    ]);
    expect(nodes.map((n) => n.ref).sort()).toEqual(["customer:app:ada@x.com", "order:shopify:1"]);
  });
});

describe("diagnoseGraphInputs", () => {
  it("reports source counts (with kind) and the global node-type histogram", () => {
    const nodes = projectSourceInputs([
      { source: customers, records: [{ email: "ada@x.com" }] },
      { source: orders, records: [{ id: 1, number: "#1001", email: "ada@x.com" }] },
    ]);
    const diag = diagnoseGraphInputs(nodes, MANIFEST);
    expect(diag.nodesByType).toEqual({ customer: 1, order: 1 });
    const shop = diag.sourceCounts.find((s) => s.source === "shopify.orders");
    expect(shop).toMatchObject({ kind: "rest", nodeCount: 1, nodesByType: { order: 1 } });
    expect(diag.unresolvedLinks).toHaveLength(0); // ada's order resolves to ada
  });

  it("flags a link that resolves to no target node", () => {
    const nodes = projectSourceInputs([{ source: orders, records: [{ id: 1, number: "#1001", email: "ghost@x.com" }] }]);
    const diag = diagnoseGraphInputs(nodes, MANIFEST);
    expect(diag.unresolvedLinks[0]).toMatchObject({
      from: "order:shopify:1",
      fromType: "order",
      relation: "placed_by",
      sourceField: "customerEmail",
      targetType: "customer",
      value: "ghost@x.com",
    });
  });

  it("caps unresolved links at maxUnresolvedLinks", () => {
    const records = Array.from({ length: 10 }, (_, i) => ({ id: i, number: `#${i}`, email: `ghost${i}@x.com` }));
    const nodes = projectSourceInputs([{ source: orders, records }]);
    expect(diagnoseGraphInputs(nodes, MANIFEST, { maxUnresolvedLinks: 3 }).unresolvedLinks).toHaveLength(3);
    expect(diagnoseGraphInputs(nodes, MANIFEST).unresolvedLinks).toHaveLength(10); // default 50 > 10
  });
});
