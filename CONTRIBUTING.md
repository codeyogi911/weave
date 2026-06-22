# Contributing to weave

Thanks for your interest in weave. It is a small, pure, dependency-free TypeScript
engine, and the goal is to keep it that way: fewer concepts, fewer moving parts, no
runtime dependencies.

## Where this lives

weave is developed inside the [`codeyogi911/ops-room-2`](https://github.com/codeyogi911/ops-room-2)
monorepo, under `oss/weave/`. It is a pnpm workspace package (`pnpm-workspace.yaml`
globs `oss/*`), so its dev dependencies resolve from the repo root. The published npm
package is `@shashwatjain511/weave`; only the built `dist/`, `README.md`, and
`LICENSE` ship in the tarball.

## Prerequisites

- Node.js 22+ and [pnpm](https://pnpm.io/).
- From the repo root, install once: `pnpm install`.

## Build, test, typecheck

All scripts are defined in `oss/weave/package.json` and run from within `oss/weave/`:

```bash
pnpm run typecheck   # tsc --noEmit
pnpm run build       # tsc -p tsconfig.build.json → emits dist/ (js + .d.ts)
pnpm run clean       # rm -rf dist
pnpm test            # vitest run (the fixture suite — no credentials needed)
pnpm run test:watch  # vitest in watch mode
pnpm run example     # tsx examples/agent-360/run.ts — a runnable cross-source demo
```

`prepublishOnly` runs `clean → build → test`, so a publish never ships stale or
untested output.

## The dist / exports contract

- The package is ESM-only (`"type": "module"`).
- The single entry point is the barrel `src/index.ts`, compiled to `dist/index.js`
  with types at `dist/index.d.ts` (see `main` / `types` / `exports` in
  `package.json`).
- The public API is exactly what `src/index.ts` re-exports. **Do not** change the
  exported surface without a deliberate version bump and a CHANGELOG entry — adding
  or removing an export is a semver-significant change.
- `dist/` is generated (git-ignored) and rebuilt by `pnpm run build`. Never edit it
  by hand or commit it.

## Working on the code

- **Keep it pure and dependency-free.** Every public function is a deterministic
  transform — records/nodes/graph in, value out. No I/O, no database, no LLM, no new
  runtime dependencies.
- **Lock behavior with a test.** New behavior or a bug fix should come with a focused
  unit test in `src/*.test.ts`. Don't loosen an existing test to make a change pass —
  if a bound or guardrail is in the way, that's usually the test doing its job.
- **Update the docs.** If you change or add to the public surface, update `README.md`
  (including the API table) and add a `CHANGELOG.md` entry under an `Unreleased`
  heading.

## Proposing a change

1. Open an issue at <https://github.com/codeyogi911/ops-room-2/issues> describing the
   problem or proposal.
2. Make your change in a branch under `oss/weave/`, with `typecheck`, `build`, and
   `test` all green.
3. Open a pull request against `main`, summarizing what changed and why, and noting
   any impact on the exported surface.
