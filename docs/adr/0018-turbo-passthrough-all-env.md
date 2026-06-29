# ADR-0018: Turbo passes through all env vars

- Status: accepted
- Date: 2026-06-29

## Context

Turborepo 2.x runs in **strict** env-mode by default: a task's subprocess only
receives the env vars Turbo is told to pass (`globalPassThroughEnv` /
`passThroughEnv` / `env`) plus a built-in system list. Narrowing
`globalPassThroughEnv` to an explicit allowlist looks like good secrets hygiene,
but it filters the variables our toolchain needs at runtime — notably
`DOCKER_HOST`, `DOCKER_TLS_VERIFY`, `DOCKER_CERT_PATH` and `TESTCONTAINERS_*`.
Integration tests use Testcontainers, so an allowlist that omits these passes in
CI (default Docker socket) but breaks `turbo test` on a developer machine using
colima, podman, or a non-default Docker context — "green in CI, broken on the
laptop". This question has come up repeatedly across our repos.

## Decision

Keep `globalPassThroughEnv: ["*"]` in `turbo.json`. Do not narrow it to an
explicit allowlist. The same choice is kept in sibling repos (e.g. pelion) for
consistency.

Secrets discipline is enforced where it actually matters, not at the Turbo
boundary: env vars are read only in `config/env.ts` (ADR-0010). The cost of
maintaining a passthrough allowlist (chasing every tool's runtime env on every
machine) is not worth the marginal benefit over that boundary.

## Consequences

- \+ Local integration tests work regardless of the developer's Docker setup.
- \+ One fewer moving part; no allowlist to keep in sync with the toolchain.
- − Turbo's cache keys don't gain the precision an explicit `env` list would
  give; declare task-specific `env`/`inputs` where cache correctness matters.
- − Relies on ADR-0010 (env read only in `config/env.ts`) as the real secrets
  boundary.
