# App infrastructure

- Status: guidance

> **Recommendations, not shipped.** The starter ships none of the below. These are the patterns we suggest when your app needs feature flags, secrets, background jobs, or graceful shutdown.

## Feature flags

Trunk-based development (branches max 1-2 days) means user-facing stories merge to main before they are ready for everyone. The PO must be able to run UAT in production with real data, ideally by sharing a link with a client — without DB access or ops involvement. We suggest a two-layer feature-flag pattern with preview links.

Resolve flags in priority order:

```
DB override (per-user)  →  preview cookie  →  env var FF_*  →  flags.json (repo default)
```

- Use `flags.json` in the repo as the global default; `FF_<NAME>` env vars override per environment.
- Use a **preview cookie** (`ff_preview`), HMAC-SHA256-signed with `FLAG_PREVIEW_SECRET`, TTL 24h, validated with `Temporal`. A `/preview?token=…` route verifies a signed token, sets the cookie and redirects — the dev generates the link (`pnpm gen-preview-token <flag>`), the PO shares it. Tampered/expired cookies silently resolve to no flags.
- Use a **DB override** (`feature_flag_overrides` table, PK `user_id + flag_name`) for permanent per-user enablement.
- Use `createFlags(env, flagRepo)` as the single factory, exposed as `context.app.flags`; routes always use `flags.forRequest(request)` so cookie overrides apply. Make `FlagName` a string-literal union — flags are typo-proof.

Lifecycle we recommend: merge with flag off → enable on staging → UAT via preview link in prod → flip `flags.json` → remove the flag from the codebase once stable. Cover both states with tests using the `withFlag` helper. Migration path to Unleash: swap the `FlagRepository` implementation, routes untouched.

Defer: token revocation (`jti` + table), percentage rollouts (Unleash), admin flag UI.

Consequences:

- \+ UAT in production with zero DB writes and zero technical access for the PO.
- \+ Flag resolution is testable, typed, and swappable for a flag service later.
- − Flag cleanup is manual; stale flags accumulate unless stories include the cleanup step.

## Secrets

Secrets must reach three contexts (local dev, CI, production) without a dedicated secrets manager, and must never be readable from the repo or from deploy-tool metadata. We suggest managing them via GitHub Secrets.

| Context | Mechanism |
|---|---|
| Local dev | `.env` per app (gitignored); `.env.example` committed as the reference inventory |
| CI (GitHub Actions) | GitHub Secrets → env vars in the workflow |
| Production | GitHub Secrets injected at deploy time as environment variables |

Use GitHub Secrets as the single source of truth for CI and production. Adding a secret takes three explicit steps: update `.env.example`, add it to GitHub Secrets, add it to the deploy workflow's env block.

In app code, read secrets only ever in `config/env.ts` (validated, typed) and let them travel through `createApp(env)` — `process.env` is banned elsewhere (see [layered architecture](../adr/0002-architecture-and-boundaries.md#layered-architecture) and [import boundaries](../adr/0002-architecture-and-boundaries.md#import-boundaries)).

Never put secrets in deploy-tool "config" objects (e.g. Uncloud `configs`, which travel in plaintext over gRPC) — environment interpolation only.

Consequences:

- \+ One inventory (`.env.example`) tells every developer and every agent exactly which secrets exist.
- \+ Startup-time validation fails fast on missing/malformed secrets instead of at first use.
- − Rotation is manual and per-environment; revisit a secrets manager if environments multiply.

## Jobs and cron

Container platforms used for deploy have no native cron. Scheduled/async work splits into two kinds with very different reliability needs: business logic ("expire OTP codes", "retry webhooks") and ops maintenance ("nightly cleanup"). We suggest splitting them across two mechanisms — pg-boss for business logic, GitHub Actions for ops.

| Task type | Pattern |
|---|---|
| Business logic — needs reliability, retry, exactly-once | **pg-boss** scheduled job |
| Ops/maintenance — low criticality | **GitHub Actions** scheduled workflow |

- Use pg-boss (Postgres-backed: no Redis, schedule survives restarts, no clock drift). Run the worker as a separate service from the same image (`node workers/index.ts` — Node 24 strip types), and have its handlers call use-cases via the same composition root (`context.app.useCases…`).
- Use GitHub Actions cron to run standalone scripts with `DATABASE_URL` from GitHub Secrets — zero infrastructure, logs and retries in GitHub.
- Defer both until the first real need (see [tech stack baseline](../adr/0003-build-and-tooling.md#tech-stack-baseline)).

Consequences:

- \+ No queue infrastructure until a use case demands it; when it does, the queue shares the existing Postgres.
- \+ Business jobs reuse domain logic through the composition root — no logic duplicated in scripts.
- − GitHub Actions cron has minute-level granularity and external dependency on GitHub availability — acceptable for ops tasks only.

## Graceful shutdown

Rolling deploys keep the old container alive until the new one is healthy, then send SIGTERM. Without a handler, in-flight requests are cut off; with keep-alive connections, `server.close()` alone never resolves. We suggest every long-lived Node process implement graceful shutdown.

Implement: **SIGTERM → stop accepting new work → drain in-flight work → cleanup resources → `process.exit(0)`**.

For the HTTP server:

```js
const server = app.listen(3000)
const connections = new Set()
server.on('connection', (conn) => {
  connections.add(conn)
  conn.on('close', () => connections.delete(conn))
})

process.on('SIGTERM', () => {
  server.close(async () => {
    await db.end() // DB pool, queues, …
    process.exit(0)
  })
  setTimeout(() => connections.forEach((c) => c.destroy()), 5000) // drain keep-alive
  setTimeout(() => process.exit(1), 30000) // force exit, matches stop_grace_period
})
```

Compose config: `stop_grace_period: 30s` + an HTTP healthcheck, so the platform only removes the old container from rotation after the new one is healthy.

| Process type | Stop accepting | Drain | Cleanup |
|---|---|---|---|
| HTTP server (RR7, Hono) | `server.close()` | destroy keep-alive after 5s | `db.end()`, pool teardown |
| Job worker (pg-boss) | `worker.close()` | finish current job | release DB/queue connections |

Consequences:

- \+ Zero dropped requests on deploy; the 5s/30s timing chain is explicit and matches the container config.
- − Boilerplate per process type; the worker variant must be written when the [Jobs and cron](#jobs-and-cron) pattern is un-deferred.
