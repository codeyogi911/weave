/**
 * Run me:  npx tsx examples/agent-360/run.ts   (from the package root)
 *
 * Weaves five disconnected systems into one graph, then shows the two things that
 * matter: (1) an agent reading "this order and everything linked to it" as ONE object
 * spanning every source, and (2) the generated agent toolkit whose descriptions are
 * derived from the manifest.
 */

import { createToolkit, graphHealth, weave } from "../../src/index";
import { customers, DATA, MANIFEST, orders, payments, products, shipments, tickets } from "./sources";

// 1. Weave: project each source's records, then build the graph. One call.
const graph = weave(
  [
    { source: customers, records: DATA.customers },
    { source: orders, records: DATA.orders },
    { source: payments, records: DATA.payments },
    { source: tickets, records: DATA.tickets },
    { source: shipments, records: DATA.shipments },
    { source: products, records: DATA.products },
  ],
  MANIFEST,
);

const hr = (t: string) => console.log(`\n${"─".repeat(64)}\n${t}\n${"─".repeat(64)}`);

hr("GRAPH HEALTH");
const health = graphHealth(graph, { identityTypes: ["customer"] });
console.log(`${health.nodeCount} nodes · ${health.edgeCount} edges · ${health.clusterCount} clusters`);
console.log("by type:", health.nodesByType);
console.log("cluster sizes:", health.clusterSizeHistogram);
console.log("invariant violations:", health.invariants.length);

// 2. The generated toolkit — what you hand an agent.
const toolkit = createToolkit(graph, MANIFEST, { identityTypes: ["customer"] });

hr("GENERATED AGENT TOOLKIT");
for (const t of toolkit) console.log(`• ${t.name}`);
console.log("\nread_entity description (manifest-derived):\n");
console.log(toolkit[0]!.description);

// 3. The agent read: one tool call, one connected object across all five systems.
hr('AGENT CALLS read_entity("#1001")');
const readEntity = toolkit.find((t) => t.name === "read_entity")!;
const view = readEntity.execute({ seed: "#1001", type: "order" });
console.log(JSON.stringify(view, null, 2));

console.log(
  "\nAda's order #1001 came back stitched to her customer record (app DB), its Stripe\n" +
    "payment, its Shiprocket shipment, and the Zendesk ticket about it — and ONLY Ada's\n" +
    "world (Bob is a separate cluster). Four systems, one read, no shared id scheme.\n",
);

// The shared product is reachable by traversal (fuzzy edge), without merging clusters.
hr('AGENT CALLS expand_entity("order:shopify:5001") — reaching shared products');
const expandEntity = toolkit.find((t) => t.name === "expand_entity")!;
console.log(JSON.stringify(expandEntity.execute({ ref: "order:shopify:5001", relations: ["contains"] }), null, 2));
