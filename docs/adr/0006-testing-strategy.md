# ADR-0006: Testing strategy: unit, integration, e2e

- Status: accepted
- Date: 2026-03-17

## Context

Tests must be fast enough to run on every PR, trustworthy enough to gate deploys, and must not depend on mocking the database (mocks drift from real SQL behaviour).

## Decision

| Layer | Tool | Convention |
|---|---|---|
| Unit | Vitest | `.spec.ts`, co-located with the source — TDD red-green |
| Integration | Vitest + Testcontainers | `.test.ts`, co-located — real Postgres, transaction rollback |
| E2E | Playwright | `*.e2e.ts` — critical flows only: revenue, onboarding, data loss |

Rules:

- Never `vi.mock` the database or a repository in `.test.ts` — use `withTestDb` from `@starter/test-utils`: each test runs inside a transaction that is rolled back, so no state leaks between tests.
- External services get stub implementations in `@starter/test-utils` (e.g. stub `EmailService`, noop analytics) injected through the composition root — full flows are testable offline.
- `test` does not depend on `build` in the Turbo pipeline — Vitest runs on TypeScript sources (fast PR feedback). `test:e2e` depends on `build` and runs only on main push: Playwright gates the deploy, not the PR.
- Playwright starts from clean cookie state (`storageState: { cookies: [], origins: [] }`); tests that need cookies set them explicitly.
- E2E hygiene is linted (ADR-0004): no `waitForTimeout()`, no reaching into React internals.

## Consequences

- \+ Integration tests exercise real SQL; schema/query bugs surface before deploy.
- \+ PR feedback stays fast; the expensive suite runs once, where it gates production.
- − Testcontainers requires a working Docker socket (Docker-in-Docker in devcontainers/Codespaces).
- − Critical-flow discipline for e2e requires judgement; the categories (revenue/onboarding/data loss) are the tie-breaker.
