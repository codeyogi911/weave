# Changelog

All notable changes to `@shashwatjain511/weave` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-06-22

### Changed

- Corrected npm package metadata so links resolve: `repository` now points at the
  `codeyogi911/ops-room-2` monorepo with `directory: "oss/weave"`, and `homepage`
  and `bugs` point at the same repo. Added an `author` field and broadened
  `keywords` (ontology, business-graph, mcp).

### Added

- `VISION.md` — the project vision & charter.
- `CONTRIBUTING.md` and this `CHANGELOG.md`.
- A README diagnostics section documenting the `compile.ts` layer
  (`compileGraph` / `diagnoseGraphInputs` / `projectSourceInputs`).
- Expanded unit tests for stored-edge parsing bounds and guardrails, runtime
  config overrides, the identity-collision invariant, and compile diagnostics.

### Fixed

- Documentation: the Vercel AI SDK mapping snippet in `README.md` and
  `skills/weave/SKILL.md` now uses the current `inputSchema:` key instead of the
  deprecated `parameters:` key on `tool({ ... })`.

> No public API or exported surface changed in this release.

## [0.1.0] - 2026-06-22

### Added

- Initial public release. A pure, dependency-free TypeScript engine that stitches
  records from many heterogeneous sources into one connected, traversable graph:
  - **Graph engine** — `buildGraph` resolves a manifest's edge rules over projected
    nodes, clusters them by connected components (deterministic edges only), and
    exposes adjacency for traversal (`clusterOf`, `expand`).
  - **Sources** — `defineSource` declaratively maps raw records onto source-blind
    `Node`s with URN refs (`<type>:<provider>:<id>`), labels, and outgoing links.
  - **Manifest / ontology** — `defineManifest` and `mergeManifest` describe how node
    types connect, with a confidence-graded "black-hole" guard: sub-threshold edges
    are recorded for traversal but never auto-merge clusters.
  - **Edges as facts** — resolved edges carry confidence and optional provenance
    (status, evidence, rule id); `extraEdges` lets you feed an external matcher's
    verdicts onto the one graph.
  - **Runtime reconciliation** — `manifestOverrideFromConfig` / `parseStoredEdge`
    read per-tenant/-deployment edge rules out of stored config and merge them onto
    the shipped manifest, with a node-type guardrail and a bounded `(0, 1]`
    confidence check.
  - **Health** — `graphHealth` and `checkGraphInvariants` produce a pure report
    (counts, cluster-size histogram, isolated nodes, fuzzy-edge count) plus
    structural invariants (`duplicate_ref`, `edge_dangling_endpoint`,
    `identity_collision`).
  - **Agent toolkit** — `createToolkit` emits framework-neutral `read_entity` /
    `find_entity` / `expand_entity` / `graph_health` tools whose descriptions are
    generated from your manifest.

[0.1.1]: https://github.com/codeyogi911/ops-room-2/tree/main/oss/weave
[0.1.0]: https://github.com/codeyogi911/ops-room-2/tree/main/oss/weave
