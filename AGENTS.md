# Agent instructions for weave

You are working with **weave** (`@codeyogi911/weave`) — a pure TypeScript library that stitches records from heterogeneous sources (databases, APIs, files) into one in-memory, traversable graph and generates a framework-neutral agent toolkit from it. Zero runtime dependencies. No database, no server, no I/O inside core.

## Before you act

1. **Read `README.md`** for the public API and mental model.
2. **Read `skills/weave/SKILL.md`** when wiring weave onto a consumer's real sources — it has the inventory table, the one modeling rule, and the done-when checklist.
3. **Run the example** when behavior is unclear: `npm run example` (`examples/agent-360/run.ts`).
4. **Prefer data over code.** New entity kinds and joins belong in `defineSource` + manifest edges, not new engine surface area.

## Architecture

```
src/
  types.ts      — Node, EdgeRule, Manifest, Graph, norm()
  source.ts     — defineSource(): raw records → nodes
  manifest.ts   — defineManifest(), mergeManifest()
  build.ts      — buildGraph(), clusterOf(), expand()
  weave.ts      — weave(), readEntity(), findNode()
  compile.ts    — compileGraph() + unresolved-link diagnostics
  config.ts     — manifestOverrideFromConfig() for runtime-tuned edges
  health.ts     — graphHealth(), checkGraphInvariants()
  toolkit.ts    — createToolkit() → read_entity / find_entity / expand_entity / graph_health
  index.ts      — re-exports
```

Pipeline: **sources → nodes → manifest edges → graph → read/traverse/toolkit**.

## Core principles

- **Pure and dependency-free.** `src/` must not take runtime dependencies. Runs in Node, Bun, Deno, browser, edge isolates.
- **Domain-agnostic.** Node types are strings. No business vocabulary in core.
- **Deterministic.** Same nodes + manifest → same graph. No I/O, clock, or randomness.
- **The black-hole guard is sacred.** Edges below the clustering threshold (`confidence < 1` by default) are recorded for traversal but **never merge clusters**. Do not weaken this.

## The one modeling rule

> Clusters form over **confidence-1 (deterministic)** edges only.

- Use `confidence: 1` for edges that define one real-world thing (order → customer, payment → order).
- Use `confidence < 1` for shared/reference dimensions (product catalog, tags, categories). A shared node at confidence 1 will false-merge unrelated entities into one giant cluster.
- After building, always run `graphHealth(graph, { identityTypes: [...] })` and fix any `identity_collision` or enormous cluster-size histogram before trusting the graph.

## Making changes

1. **Behavior change** → add or update a test in `src/*.test.ts`.
2. **User-facing change** → note it in `CHANGELOG.md` under `Unreleased`.
3. **Keep the bar high on surface area.** Ask: can this be a manifest edge, a source config field, or an `extraEdge` instead of new API?
4. Match existing style: small modules, file-level doc comments, no unnecessary abstractions.

## Don't

- Don't add runtime dependencies to `src/`.
- Don't put domain-specific types or vocabulary in core.
- Don't bypass `resolveManifestLinks` / `indexNodesByType` when adding link resolution — builder and diagnostics must share one pass.
- Don't auto-merge clusters on fuzzy edges.
- Don't guess join keys — inventory sources first; verify with `graphHealth` and `readEntity` on a known seed.
- Don't add docs files the user didn't ask for.

## Validation

Before declaring a change done:

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # tsup → dist/
npm run example     # five-source demo
```

## Wiring weave for consumers

When helping a user integrate weave (outside this repo):

1. Inventory sources: stable id, human label others reference, outgoing keys.
2. One `defineSource` per system; set `label` to what other sources point at.
3. Write manifest edges; apply the confidence rule.
4. `weave()` → `graphHealth()` → `createToolkit(() => graph, manifest)`.
5. Map tools to the host framework (Vercel AI SDK, MCP, etc.).

See `examples/agent-360/` for a complete five-source reference.
