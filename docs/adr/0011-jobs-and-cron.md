# ADR-0011: Jobs and cron: pg-boss for business logic, GitHub Actions for ops

- Status: accepted
- Date: 2026-03-17

## Context

Container platforms used for deploy have no native cron. Scheduled/async work splits into two kinds with very different reliability needs: business logic ("expire OTP codes", "retry webhooks") and ops maintenance ("nightly cleanup").

## Decision

| Task type | Pattern |
|---|---|
| Business logic — needs reliability, retry, exactly-once | **pg-boss** scheduled job |
| Ops/maintenance — low criticality | **GitHub Actions** scheduled workflow |

- pg-boss is Postgres-backed (no Redis, schedule survives restarts, no clock drift). The worker runs as a separate service from the same image (`node workers/index.ts` — Node 24 strip types), and its handlers call use-cases via the same composition root (`context.app.useCases…`).
- GitHub Actions cron runs standalone scripts with `DATABASE_URL` from GitHub Secrets — zero infrastructure, logs and retries in GitHub.
- Both are deferred until the first real need (ADR-0002 triggers).

## Consequences

- \+ No queue infrastructure until a use case demands it; when it does, the queue shares the existing Postgres.
- \+ Business jobs reuse domain logic through the composition root — no logic duplicated in scripts.
- − GitHub Actions cron has minute-level granularity and external dependency on GitHub availability — acceptable for ops tasks only.
