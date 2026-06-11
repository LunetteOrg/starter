# ADR-0008: Two-layer feature flags with preview links

- Status: accepted
- Date: 2026-03-17

## Context

Trunk-based development (branches max 1-2 days) means user-facing stories merge to main before they are ready for everyone. The PO must be able to run UAT in production with real data, ideally by sharing a link with a client — without DB access or ops involvement.

## Decision

Flags resolve in priority order:

```
DB override (per-user)  →  preview cookie  →  env var FF_*  →  flags.json (repo default)
```

- `flags.json` in the repo is the global default; `FF_<NAME>` env vars override per environment.
- The **preview cookie** (`ff_preview`) is HMAC-SHA256-signed with `FLAG_PREVIEW_SECRET`, TTL 24h, validated with `Temporal`. A `/preview?token=…` route verifies a signed token, sets the cookie and redirects — the dev generates the link (`pnpm gen-preview-token <flag>`), the PO shares it. Tampered/expired cookies silently resolve to no flags.
- The **DB override** (`feature_flag_overrides` table, PK `user_id + flag_name`) handles permanent per-user enablement.
- `createFlags(env, flagRepo)` is the single factory, exposed as `context.app.flags`; routes always use `flags.forRequest(request)` so cookie overrides apply. `FlagName` is a string-literal union — flags are typo-proof.

Lifecycle: merge with flag off → enable on staging → UAT via preview link in prod → flip `flags.json` → remove the flag from the codebase once stable. Tests cover both states using the `withFlag` helper. Migration path to Unleash: swap the `FlagRepository` implementation, routes untouched.

Deferred: token revocation (`jti` + table), percentage rollouts (Unleash), admin flag UI.

## Consequences

- \+ UAT in production with zero DB writes and zero technical access for the PO.
- \+ Flag resolution is testable, typed, and swappable for a flag service later.
- − Flag cleanup is manual; stale flags accumulate unless stories include the cleanup step.
