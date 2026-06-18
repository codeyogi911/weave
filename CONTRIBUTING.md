# Contributing to weave

Thanks for your interest. weave is a small, deliberately-tiny library — the bar is
*fewer concepts, not more*. Before adding surface area, check whether the change can
be expressed as data (a manifest, a source config) rather than new API.

## Develop

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # tsup → dist/ (esm + cjs + d.ts)
npm run example     # run the five-source demo
```

## Principles

- **Pure and dependency-free core.** `src/` must not take a runtime dependency. It
  runs in Node, Bun, Deno, the browser, and edge isolates — keep it that way.
- **Domain-agnostic.** Node types are just strings; the engine knows nothing about
  any business. Domain vocabulary belongs in a consumer's manifest, never in core.
- **Deterministic.** `buildGraph` is a pure function of its inputs. No I/O, no clock,
  no randomness. Same nodes + manifest → same graph.
- **The black-hole guard is sacred.** Edges below the clustering threshold are
  recorded for traversal but never merge clusters. Don't weaken this.

## Pull requests

- Add a test for any behavior change (`src/*.test.ts`).
- Keep `npm run typecheck`, `npm test`, and `npm run build` green.
- Note user-facing changes in `CHANGELOG.md` under `Unreleased`.
