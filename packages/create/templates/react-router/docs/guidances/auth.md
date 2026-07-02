# Auth as an owned domain module

- Status: guidance

> **Recommendation, not shipped.** The starter ships no auth. When you add it to an app, this is the approach we suggest and why.

## Context

The durable recommendation is simple: **own your auth**. Model sessions and OTP behind repository interfaces defined in the domain, keep the schema 100% yours, and never let a framework dictate your database shape or leak into your routes.

Auth frameworks that own their database schema (e.g. Better-Auth-style batteries-included frameworks) prevent expressing sessions and OTP codes behind your own repository interfaces, breaking the [layered architecture](../adr/0002-architecture-and-boundaries.md#layered-architecture). That schema lock-in is the trade-off to avoid. (For reference, Lucia v3 is deprecated by its author, so it is not a path forward either.)

None of the libraries below are mandatory — pick primitives that let *you* keep ownership.

## Recommendation

### Own the layering

- **Sessions**: cookie-based, stored in Postgres behind a `SessionRepository` interface defined in the domain; the schema lives in `lib/db/schema/sessions.ts` and is 100% yours. A Redis swap stays possible behind the same interface — the domain never knows where sessions live.
- **OTP login**: an `OtpRepository` with a discriminated verify result (`valid | expired | invalid | used`), so callers handle every outcome explicitly rather than guessing from a boolean.
- **Email delivery**: an `EmailService` interface in domain terms; the provider implementation lives in `lib/email/` with its own [typed errors](../adr/0002-architecture-and-boundaries.md#typed-errors) (an infrastructure concern). A stub `EmailService` in `@starter/test-utils` makes the full OTP flow testable offline.
- **Routes never import the auth library**: session validation goes through `context.app.getSession(request)`. Wiring happens once at the [use-case composition](../adr/0002-architecture-and-boundaries.md#use-case-composition) root, not in route handlers.

### A suggested primitive: Oslo

**Oslo** is *one* option for the underlying crypto/session utilities — a set of primitives (by the original Lucia author) with no framework opinions and full schema ownership. It gives you the building blocks (secure random IDs, hashing, cookie helpers) without owning your tables, which is exactly what keeps auth inside your own layering.

Treat Oslo as an implementation detail behind `SessionRepository` / `OtpRepository`, not as the decision. Any library that leaves the schema and the interfaces in your hands is a valid substitute.

## Testing

Because auth is just another domain module, it follows the standard [testing strategy](../adr/0004-testing.md#testing-strategy): exercise repositories against a real database with [test database isolation](../adr/0004-testing.md#test-database-isolation) (`withTestDb`), and use the `@starter/test-utils` stub `EmailService` to drive the full OTP flow offline — no real provider, no network.

## Secrets

Session signing keys, OTP pepper, and email-provider credentials are secrets — manage them per the [secrets guidance](./app-infrastructure.md#secrets), never hard-coded and never in the repo.

## Consequences

- \+ Auth is just another domain module: testable with `withTestDb`, swappable infrastructure, no schema lock-in.
- − You own more code than with a batteries-included auth framework (session expiry, OTP rate limits, resend UX become your stories).
