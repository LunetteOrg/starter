# ADR-0013: Use-case composition in the composition root

- Status: accepted
- Date: 2026-06-11

## Context

Every use-case is a factory `makeX(deps)` returning an async function whose result is a union of success and typed errors (ADR-0003, ADR-0005). As apps grow, use-cases need to reuse one another (e.g. "publish post" needs "detect language" and "translate upfront"), some flows need a shared database transaction, and some side effects must not fail the main operation. Alternatives considered: orchestrating multiple use-cases from the route (business logic leaks into the thin layer), a dedicated orchestrator layer (premature), and `Result`-pipe helpers to chain `T | Err` steps (deferred until the boilerplate actually hurts).

## Decision

**Use-cases compose in the composition root, through their `Deps` — never by importing each other.**

1. **Injection, not import.** A reusable use-case is created once in `createApp(env)` and passed as a plain function dependency to the factories that need it. The consumer declares only the function type in its `Deps` — it cannot tell whether the implementation is a repository method, a service, or another use-case:

```ts
// bootstrap/index.ts
const detectOrigLang = makeDetectOrigLang({ translation })
const translateUpfront = makeTranslateUpfront({ translation, translationRepo })

useCases.discussions.publishPost = makePublishPost({
  detectOrigLang,
  createPost: postRepo.create, // trivial steps stay repo passthroughs
  translateUpfront,
})
```

2. **One use-case per route action.** Routes call exactly one use-case; sequencing two use-cases in a loader/action is the signal to extract a new composing use-case.

3. **Transactions are a composition-root concern.** Repository factories accept `db | tx`. When steps must be atomic, the root wires the use-case inside `db.transaction`, rebuilding the repos over `tx`:

```ts
// bootstrap/index.ts
verifyOtp: (input: VerifyOtpInput) =>
  db.transaction((tx) =>
    makeVerifyOtp({
      otpRepo: createOtpRepository(tx),
      sessionRepo: createSessionRepository(tx),
    })(input),
  ),
```

Use-cases themselves never know about transactions — only their deps happen to share one.

4. **Best-effort side effects are explicit.** Fan-out after the primary write (notifications, eager translations, analytics) must not fail the use-case: their errors are observed/logged, never returned. Validate before any side effect; return domain errors before the first write.

Escalation path: when a flow chains many use-cases and the `if (isError(x)) return x` boilerplate dominates, introduce a small `Result`-pipe helper or a named "workflow" convention — via a new ADR, not ad hoc.

## Consequences

- \+ Leaf use-cases stay unit-testable with hand-rolled deps; no module mocking, no hidden coupling between use-case files.
- \+ The dependency graph of business flows is readable in one place (`bootstrap/`).
- − `createApp` grows with every flow; accepted (ADR-0003) — it is the single place where wiring is explicit.
- − Transactional wiring duplicates repo construction (once on `db`, once on `tx`); a `withTransaction` helper in bootstrap can fold the pattern when it repeats.
