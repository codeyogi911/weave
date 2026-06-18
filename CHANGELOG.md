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
- `prepare` build script so the package can also be consumed directly from a git ref
  (`git+https://…/weave.git#<tag>`) without a registry — builds `dist/` on the fly.
- Published privately to **GitHub Packages** as `@codeyogi911/weave` (scope must match
  the repo owner). `release.yml` builds + publishes on a `v*` tag using the workflow's
  `GITHUB_TOKEN` — no manual npm token. Consumers point the `@codeyogi911` scope at
  `https://npm.pkg.github.com` with a `read:packages` token.

### Changed
- Package renamed `@weave/core` → `@codeyogi911/weave` for GitHub Packages (scope =
  account owner). The public name/scope remains provisional.

> Note: the package name/scope is provisional. While in private development it ships to
> GitHub Packages under the owner scope; it may be renamed when a public scope is claimed.
