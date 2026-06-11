# ADR-0005: Typed errors with `errore` instead of exceptions

- Status: accepted
- Date: 2026-03-17

## Context

Thrown exceptions are invisible in signatures: callers cannot know what can fail, and TypeScript cannot force them to handle it. In a layered app with AI-generated code, failure paths must be part of the type system.

## Decision

Errors are values, built with [`errore`](https://www.npmjs.com/package/errore) tagged errors. The chain across layers:

- **Domain** defines tagged errors (`createTaggedError`) — `UserNotFound`, `InvalidOtp`, … (PascalCase).
- **Repositories** (`lib/db/repos/`) wrap every Drizzle call in `tryAsync()`; methods return `Promise<T | DbOperationFailed>` — never throw.
- **Use-cases** return unions: `Promise<Post | PostTitleRequired | DbOperationFailed>`. Callers check with `isError()`. Never `throw` below the use-case layer.
- **Routes** handle the union exhaustively with `matchError()` — the only layer that translates errors into HTTP responses.

`throw new Error()` is an anti-pattern everywhere in app code; `throw` is acceptable only where the framework demands it (e.g. `throw redirect(…)` in RR7).

## Consequences

- \+ Every failure mode is in the signature; adding an error to a use-case breaks compilation at every unhandled call site.
- \+ No try/catch pyramids; error handling is data flow.
- − Union return types are verbose, and chains of `if (isError(x)) return x` add boilerplate (a composition helper is deliberately deferred — see ADR-0013).
