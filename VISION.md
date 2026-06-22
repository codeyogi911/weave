# weave — Vision & Charter

> The connective tissue between every data source and every agent.

## The problem: every business is a pile of disconnected systems

The modern company does not have *a* database. It has Shopify for orders, Zoho or a CRM for customers, a billing system, a warehouse system, a pile of spreadsheets, and — increasingly — a dozen MCP servers and SaaS connectors, each one exposing its own slice of the business as its own entities and objects. The "customer" in Shopify, the "account" in the CRM, and the "payer" in billing are the same human being, but no system knows that. The business is real and coherent; its data is scattered and contradictory.

The lakehouse pitch — "pour everything into one giant store and just query it" — assumes a world that does not exist for most companies. Centralizing every source into one warehouse is a months-long, expensive integration project, and the moment it is done a new tool shows up and it is out of date. Big enterprises buy their way partway there and still live with silos. Small businesses never get there at all. The data does not want to move; it lives where the work happens.

So the real question is not "how do we move everything into one place?" It is "how do we make everything *behave* as one place — without moving it?"

## The vision: stitch, don't centralize

weave is the layer that sits between the sources and the agents and stitches them into a single, coherent, queryable graph of the business — its entities, the relationships between them, and the facts that connect them — while the underlying data stays exactly where it is.

weave is not another warehouse. It is a semantic graph and ontology that maps heterogeneous sources — connectors, MCP servers, databases, manifests — onto a shared model of what the business actually *is*: customers, orders, accounts, payments, shipments, and the edges between them. A connector says "here are my objects"; weave says "here is what they *mean* and how they connect to everything else."

The result is one graph you can stand on, assembled from many systems none of which had to agree in advance.

## Why now: the agent is the user

The reason this matters now is that the consumer of business data is no longer only a dashboard or a human analyst — it is an agent. And agents are only as good as the affordances they are handed. Point an agent at six raw connectors and it drowns: every source has different names, different shapes, different trust levels, no map of how anything relates. Point it at weave and it gets a single, legible surface with great tool affordance — it can find the data it wants, *understand* what that data means, and reason across systems instead of within one.

weave is designed agent-first. The graph is the tool surface. The ontology is the agent's map. Getting, understanding, and traversing the business is a first-class, low-friction operation — not a bespoke integration the agent has to reverse-engineer every time.

## Self-healing: the graph the agent can tune

Real integrations break. A source changes shape, an entity stops resolving, two records that are the same person refuse to merge, a join goes wrong. In most systems that is a ticket and a human. In weave it should be something the agent can *see and fix*.

The graph is introspectable and tunable. It exposes its own health — broken edges, orphaned entities, identity collisions, low-confidence facts — so an agent can diagnose what is wrong. And it gives the agent the controls to repair it: adjust the mapping, reconcile the entities, raise or lower confidence, and build **facades** — purpose-shaped views over the underlying graph that present exactly the model a given task or agent needs, without forking the source of truth. When something is broken, the agent tunes the graph and creates a facade; the graph heals instead of failing.

This is the difference between an integration that is a static artifact and one that is a living system: weave is meant to be steered, by agents, in motion.

## Principles

1. **Stitch, don't centralize.** Data stays at the source. weave unifies meaning, not storage. Coherence without a migration.
2. **Agent-native by default.** The graph is the tool surface and the ontology is the map. Optimize relentlessly for agent affordance: find it, understand it, traverse it.
3. **Self-healing.** The graph reports its own health and exposes the controls to repair itself. Breakage is a tunable state, not a dead end.
4. **Facades over forks.** Shape views to fit the task without mutating the source of truth. Many lenses, one graph.
5. **Facts carry trust.** Every edge knows where it came from and how confident it is. Identity, provenance, and confidence are bounded and enforced, not advisory.
6. **Small business first.** If it works for a company living across six SaaS tools and a spreadsheet, it works for the enterprise too. Start where the lakehouse never reaches.

## What weave is — and is not

**weave is:** a semantic graph + ontology engine that maps many sources onto a shared business model; an agent-native query and traversal surface; a self-healing, tunable, facade-able layer between systems of record and the agents that act on them.

**weave is not:** a data warehouse or lakehouse; an ETL pipeline that copies your data somewhere new; a connector marketplace; a system that requires every source to agree on a schema before you get value.

## The shape of the system

weave already centers on the primitives this vision needs: an ontology of business entity types; manifests that describe how a given source/tenant maps onto that ontology; edges modeled as first-class facts with provenance and bounded confidence; reconciliation to resolve when records across systems are the same entity; and health checks that surface the graph's broken or suspect state. The roadmap is the disciplined extension of exactly these: richer source adapters (connectors, MCP, databases) onto the ontology, deeper reconciliation, agent-facing tools for diagnosis and repair, and first-class facades.

## Where this is going

The end state: a small business — or an enterprise team — connects the tools it already uses, and an agent is handed one coherent graph of the whole operation that it can query, understand, repair, and shape. No lakehouse. No migration. No silos the agent has to bridge by hand. Just the business, stitched together, legible to the agents working on its behalf.

That layer is weave.
