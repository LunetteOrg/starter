# ADR-0010: Secrets management via GitHub Secrets

- Status: accepted
- Date: 2026-03-17

## Context

Secrets must reach three contexts (local dev, CI, production) without a dedicated secrets manager, and must never be readable from the repo or from deploy-tool metadata.

## Decision

| Context | Mechanism |
|---|---|
| Local dev | `.env` per app (gitignored); `.env.example` committed as the reference inventory |
| CI (GitHub Actions) | GitHub Secrets → env vars in the workflow |
| Production | GitHub Secrets injected at deploy time as environment variables |

GitHub Secrets is the single source of truth for CI and production. Adding a secret takes three explicit steps: update `.env.example`, add it to GitHub Secrets, add it to the deploy workflow's env block.

In app code, secrets are only ever read in `config/env.ts` (validated, typed) and travel through `createApp(env)` — `process.env` is banned elsewhere (ADR-0003/0004).

Never put secrets in deploy-tool "config" objects (e.g. Uncloud `configs`, which travel in plaintext over gRPC) — environment interpolation only.

## Consequences

- \+ One inventory (`.env.example`) tells every developer and every agent exactly which secrets exist.
- \+ Startup-time validation fails fast on missing/malformed secrets instead of at first use.
- − Rotation is manual and per-environment; revisit a secrets manager if environments multiply.
