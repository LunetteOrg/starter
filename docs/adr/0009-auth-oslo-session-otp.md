# ADR-0009: Auth with Oslo primitives and owned schema

- Status: accepted
- Date: 2026-03-17

## Context

Auth frameworks that own their database schema (e.g. Better Auth) prevent expressing sessions and OTP codes behind our own repository interfaces, breaking the layering of ADR-0003. Lucia v3 is deprecated by its author.

## Decision

- **Oslo** (primitive crypto/session utilities, by the original Lucia author) — no framework opinions, full schema ownership.
- **Sessions**: cookie-based, stored in Postgres behind a `SessionRepository` interface defined in domain; schema lives in `lib/db/schema/sessions.ts` and is 100% ours. Redis swap stays possible behind the same interface.
- **OTP login**: `OtpRepository` with a discriminated verify result (`valid | expired | invalid | used`).
- **Email delivery**: an `EmailService` interface in domain terms; provider implementation in `lib/email/` with its own typed errors (infrastructure concern). A stub `EmailService` in `@starter/test-utils` makes the full OTP flow testable offline.
- Routes never import the auth library: session validation goes through `context.app.getSession(request)`.

## Consequences

- \+ Auth is just another domain module: testable with `withTestDb`, swappable infrastructure, no schema lock-in.
- − We own more code than with a batteries-included auth framework (session expiry, OTP rate limits, resend UX are our stories).
