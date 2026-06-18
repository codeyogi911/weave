import { describe, expect, it } from "vitest";
import { createToolkit, defineManifest, defineSource, weave, type Manifest } from "./index";

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
