# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims to adhere to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Initial extraction of the graph engine into a standalone package.
- Core: `Node` / `EdgeRule` / `Manifest` / `ResolvedEdge` / `Cluster`, `buildGraph`,
  connected-component clustering, `clusterOf`, `expand`.
- `defineSource` — declarative record → node field-map (the adapter layer).
- `weave()` one-call front door and `readEntity` agent-facing read.
- `createToolkit` — generates framework-neutral agent tools (`read_entity`,
  `find_entity`, `expand_entity`, `graph_health`) whose descriptions are derived
  from the manifest; maps 1:1 onto the Vercel AI SDK / MCP.
- `compileGraph` diagnostics (source counts, duplicate refs, unresolved links).
- Runtime-tunable joins via stored config (`manifestOverrideFromConfig`).
- Pure `graphHealth` report + structural invariants.
- Agent skill (`skills/weave/SKILL.md`) for wiring weave onto real sources.
- Runnable five-source example and architecture diagrams.

> Note: the npm package name/scope is provisional until the npm scope is claimed.
