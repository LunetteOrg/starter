# ADR-0016: Self-arming enforcement for scaffolded apps

- Status: accepted
- Date: 2026-06-29

## Context

Import boundaries are guarded by two nets (ADR-0004): Biome `noRestrictedImports`
overrides, applied automatically by glob to `apps/*`, and a per-app
`app/arch.spec.ts` that also catches dynamic `import()` the linter misses. The
nets are asymmetric: the Biome net arrives for free, but the architecture test
must be copied by hand into every new app. The first app that forgets it loses
half the net, and boundaries drift before anyone notices.

More broadly, this is a template. Anything we add must not become friction for
the project scaffolded from it — least of all dead example code that has to be
deleted.

## Decision

Enforcement that protects the template's own guarantees is added **now** but
kept **inert until a real app exists**; application code is shipped only as
inert `.template` files to copy, never as live code.

- A repo-level meta-test (`packages/test-utils/src/meta-arch.spec.ts`) discovers
  `apps/*` at runtime and, for each app that has an `app/` layer, requires an
  `app/arch.spec.ts` that actually invokes `assertLayerBoundaries` (presence
  alone is gameable — an empty file would enforce nothing). At day-0 (`apps/`
  holds only `.gitkeep`) it iterates over nothing and passes; it arms itself the
  moment `apps/<x>/app/` appears.
- The boundary scanner's coverage is locked with regression fixtures
  (re-exports, `import type`) so a refactor cannot silently make a check pass
  vacuously. If those ever fail, that is the signal to move from the regex scan
  to a TS-AST walk.
- Reference components/use-cases are shipped as `*.template` files (e.g.
  `packages/ui/src/_example/Button.tsx.template`), mirroring
  `packages/test-utils/templates/layer.arch.spec.ts.template`.

Rule of thumb: infra / CI / enforcement → do it now (inert until needed);
application code → ship as a template to copy.

## Consequences

- \+ New apps cannot quietly skip the architecture test; the gap fails CI with a
  pointer to the template.
- \+ Zero friction at day-0; the template stays generic.
- \+ Boundary coverage is regression-tested, not assumed.
- − The meta-test encodes the `apps/*/app/arch.spec.ts` convention; changing the
  layout means updating it (one place).
- − The arch-test template (`layer.arch.spec.ts.template`) assumes the layer
  layout `app/{domain,use-cases,routes}/`; `assertLayerBoundaries` throws on an
  empty glob, so an app that arms the test without one of those folders fails
  until the template is adapted to its actual layers.
