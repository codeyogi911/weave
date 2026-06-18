/**
 * The sample domain: a tiny e-commerce business whose data is scattered across five
 * systems. None of them share an id scheme; they only agree on human things —
 * a customer's email, an order number, a SKU. Weave stitches them into one graph.
 *
 * In a real app each `records` array below would come from a DB query or an API call.
 * Here they're inline fixtures so the example runs with zero setup.
 */

import { defineManifest, defineSource, type Manifest } from "../../src/index";

// ── Sources: one declarative mapping per system ──────────────────────────────

/** Internal app DB — the customer directory, keyed by email. */
export const customers = defineSource<{ email: string; name: string }>({
  type: "customer",
  provider: "app",
  id: "email",
  label: "email", // the label is the email, so every "by email" edge resolves to it
});

/** Shopify — channel orders. They carry the customer's email and a SKU list. */
export const orders = defineSource<{ id: number; number: string; email: string; total: number; skus: string[] }>({
  type: "order",
  provider: "shopify",
  id: "id",
  label: "number",
  amount: "total",
  currency: () => "USD",
  links: {
    customerEmail: "email",
    productSkus: "skus",
  },
});

// NOTE on the `contains` edge below: a product is SHARED reference data — the same
// SKU appears in many customers' orders. If `order —contains→ product` were
// deterministic (confidence 1), that shared product would union two unrelated
// customers into one cluster (a false merge). So it's declared at confidence 0.9:
// recorded for traversal, but never merges clusters. This is the fuzzy "black-hole"
// guard doing its job — clusters stay clean, the edge is still there to walk.

/** Stripe — payments. They reference the order by its human NUMBER, not Shopify's id. */
export const payments = defineSource<{ id: string; orderNumber: string; amount: number }>({
  type: "payment",
  provider: "stripe",
  id: "id",
  amount: "amount",
  currency: () => "USD",
  links: { orderRefs: "orderNumber" },
});

/** Zendesk — support tickets. They carry the requester's email; some name an order. */
export const tickets = defineSource<{ id: number; subject: string; requester: string; aboutOrder?: string }>({
  type: "ticket",
  provider: "zendesk",
  id: "id",
  label: "subject",
  status: () => "open",
  links: {
    customerEmail: "requester",
    orderRefs: (t) => t.aboutOrder ?? null,
  },
});

/** Shiprocket — shipments. They reference the order they fulfill by its number. */
export const shipments = defineSource<{ awb: string; orderNumber: string; status: string }>({
  type: "shipment",
  provider: "shiprocket",
  id: "awb",
  label: "awb",
  status: "status",
  links: { orderRefs: "orderNumber" },
});

/** Product catalog — keyed by SKU (the label), so order.productSkus resolves to it. */
export const products = defineSource<{ sku: string; title: string }>({
  type: "product",
  provider: "catalog",
  id: "sku",
  label: "sku",
});

// ── The manifest: how the types connect (plain data) ─────────────────────────

export const MANIFEST: Manifest = defineManifest([
  { from: "order", to: "customer", relation: "placed_by", sourceField: "customerEmail", confidence: 1 },
  { from: "ticket", to: "customer", relation: "raised_by", sourceField: "customerEmail", confidence: 1 },
  { from: "ticket", to: "order", relation: "about_order", sourceField: "orderRefs", confidence: 1 },
  { from: "payment", to: "order", relation: "settles", sourceField: "orderRefs", confidence: 1 },
  { from: "shipment", to: "order", relation: "fulfills", sourceField: "orderRefs", confidence: 1 },
  // Shared dimension — traversable but NON-clustering (see note above).
  { from: "order", to: "product", relation: "contains", sourceField: "productSkus", confidence: 0.9 },
]);

// ── Fixture data (would be DB rows / API responses in real life) ──────────────

export const DATA = {
  customers: [
    { email: "ada@example.com", name: "Ada Lovelace" },
    { email: "bob@example.com", name: "Bob Khan" },
  ],
  orders: [
    { id: 5001, number: "#1001", email: "ada@example.com", total: 120, skus: ["TEE-BLK-M", "MUG-01"] },
    { id: 5002, number: "#1002", email: "bob@example.com", total: 40, skus: ["MUG-01"] },
  ],
  payments: [{ id: "ch_aaa", orderNumber: "1001", amount: 120 }],
  tickets: [
    { id: 77, subject: "Where is my order?", requester: "ada@example.com", aboutOrder: "1001" },
    { id: 78, subject: "Mug arrived chipped", requester: "bob@example.com", aboutOrder: "1002" },
  ],
  shipments: [{ awb: "AWB123", orderNumber: "1001", status: "in_transit" }],
  products: [
    { sku: "TEE-BLK-M", title: "Black Tee (M)" },
    { sku: "MUG-01", title: "Enamel Mug" },
  ],
};
