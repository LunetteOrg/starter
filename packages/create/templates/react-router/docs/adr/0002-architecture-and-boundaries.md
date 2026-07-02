# ADR-0002: Architecture & boundaries

- Status: accepted
- Date: 2026-07-02

This template's application architecture is **hexagonal (ports and adapters)**: a pure domain at the center, the web framework (React Router) and infrastructure (DB, email, …) at the edges behind injected ports. Concretely — how each app is layered, how those layers are mechanically kept apart, how errors flow through them as typed values, how use-cases compose in the composition root, and how the template arms its own enforcement the moment a real app appears.

## Layered architecture

### Context

Business logic must stay testable in isolation, independent of the web framework, and the database must be unreachable from UI code. With AI agents writing much of the code, the structure has to be explicit and mechanical, not tribal knowledge.

### Decision

Each app follows fixed layers:

```
app/
├── routes/        → thin RR7 loaders/actions — consume context.app only
├── use-cases/     → orchestrate domain logic, own side effects (factories, see #use-case-composition)
├── domain/        → pure logic + repository interfaces + typed errors — no framework, no lib/
├── lib/           → infrastructure: db/repos (Drizzle), email, flags, …
├── bootstrap/     → createApp(env) — the composition root, wires repos → use-cases
└── config/        → env.ts — the only place that reads process.env, type-safe validation
```

Dependency matrix:

| Layer | May import | Must not import |
|---|---|---|
| routes | `#app/context`, react-router | use-cases, domain, lib/db, bootstrap |
| use-cases | domain | react-router, lib/db and other infrastructure (interfaces are injected) |
| domain | nothing from the app | react-router, lib |
| lib/db/repos | domain interfaces, drizzle | react-router |
| bootstrap | everything | — |
| config | zod | anything else |

Wiring: `createApp(env)` builds repos, services and use-cases once; `export type App = ReturnType<typeof createApp>` is the single source of truth for the app type. Routes receive the app through React Router context (`getLoadContext` / middleware), whose signature takes only a web-standard `Request` — no Express types — keeping the Cloudflare Workers path open.

```ts
export async function loader({ request, context }: Route.LoaderArgs) {
  const app = context.get(appContext)
  const result = await app.useCases.auth.verifyOtp({ … })
  return matchError(result, { … })
}
```

### Consequences

- \+ Every dependency is injected → unit tests need no module mocking; integration tests wire a mini-app over a test transaction.
- \+ Layer boundaries are mechanically enforceable ([import boundaries](#import-boundaries)).
- − Wiring in `bootstrap/` grows with the app and is boilerplate-ish; this is accepted as the one place where everything is explicit.

## Import boundaries

### Context

The layer boundaries of [layered architecture](#layered-architecture) are worthless if they only live in documentation. They must fail fast (pre-commit) and fail reliably (CI), without adding a new tool to the stack.

### Decision

Two independent nets, both expressing the same matrix:

**1. Biome, at lint time (pre-commit + CI).** Root `biome.json` carries `overrides` keyed on layer globs that work for any app under `apps/*`:

- `apps/*/app/domain/**` — `noRestrictedImports` bans `react-router` and `#app/lib`.
- `apps/*/app/use-cases/**` — bans `react-router` and `#app/lib/db`; concrete infrastructure modules (e.g. `#app/lib/email`) are added to this override as they appear.
- `apps/*/app/routes/**` — bans `#app/use-cases`, `#app/domain`, `#app/lib/db`, `#app/bootstrap`.
- `apps/*/app/**` (excluding tests) — `noRestrictedGlobals` bans `Date` in favour of `Temporal`.
- `apps/*/__tests__/**/*.e2e.ts` — GritQL plugins from `packages/biome-config/` ban `waitForTimeout()` (implicit sync) and React internals (`__reactProps$`/`__reactFiber$`) in e2e tests.

**2. Architecture tests, at CI time.** Each app ships an `app/arch.spec.ts` built on `@starter/test-utils`, asserting the same matrix by scanning sources. Use `assertLayerBoundaries` (auto-discovers a layer's files, merges the default `*.spec.ts`/`*.test.ts` excludes, and is built on `getImports` so it also catches dynamic `import()`); drop to the lower-level `getImports` + `assertNoForbiddenImports` only for bespoke checks. Canonical template:

```ts
import { resolve } from 'node:path'
import { assertLayerBoundaries } from '@starter/test-utils'
import { describe, it } from 'vitest'

const APP = resolve(__dirname)

describe('architecture boundaries', () => {
  it('domain imports no framework or lib', async () => {
    await assertLayerBoundaries({
      pattern: resolve(APP, 'domain/**/*.{ts,tsx}'),
      layer: 'domain',
      forbidden: [/^react-router/, /^#app\/lib\//],
    })
  })
  it('routes reach the app only through context', async () => {
    await assertLayerBoundaries({
      pattern: resolve(APP, 'routes/**/*.{ts,tsx}'),
      layer: 'routes',
      forbidden: [/^#app\/use-cases/, /^#app\/domain/, /^#app\/lib\/db/, /^#app\/bootstrap/],
    })
  })
  it('use-cases import no framework or db', async () => {
    await assertLayerBoundaries({
      pattern: resolve(APP, 'use-cases/**/*.{ts,tsx}'),
      layer: 'use-cases',
      forbidden: [/^react-router/, /^#app\/lib\/db/],
    })
  })
})
```

A ready-to-copy version lives at `packages/test-utils/templates/layer.arch.spec.ts.template`.

Path aliases use Node.js subpath imports (`"imports": { "#app/*": … }` in each app's `package.json`) — portable, no bundler-specific config, and a stable target for both nets.

### Consequences

- \+ Violations surface in the editor and at pre-commit (Biome), and cannot slip past CI even if a hook is skipped (arch tests).
- \+ New apps inherit the Biome rules for free via the `apps/*` globs; they only need to add `arch.spec.ts`.
- − The matrix is written twice (Biome config + test). Accepted: the redundancy is the feature.
- − The use-cases override must be extended manually when a new infrastructure module lands in `lib/`.

## Typed errors

### Context

Thrown exceptions are invisible in signatures: callers cannot know what can fail, and TypeScript cannot force them to handle it. In a layered app with AI-generated code, failure paths must be part of the type system.

### Decision

Errors are values, built with [`errore`](https://www.npmjs.com/package/errore) tagged errors. The chain across layers:

- **Domain** defines tagged errors (`createTaggedError`) — `UserNotFound`, `InvalidOtp`, … (PascalCase).
- **Repositories** (`lib/db/repos/`) wrap every Drizzle call in `tryAsync()`; methods return `Promise<T | DbOperationFailed>` — never throw.
- **Use-cases** return unions: `Promise<Post | PostTitleRequired | DbOperationFailed>`. Callers check with `isError()`. Never `throw` below the use-case layer.
- **Routes** handle the union exhaustively with `matchError()` — the only layer that translates errors into HTTP responses.

`throw new Error()` is an anti-pattern everywhere in app code; `throw` is acceptable only where the framework demands it (e.g. `throw redirect(…)` in RR7).

### Consequences

- \+ Every failure mode is in the signature; adding an error to a use-case breaks compilation at every unhandled call site.
- \+ No try/catch pyramids; error handling is data flow.
- − Union return types are verbose, and chains of `if (isError(x)) return x` add boilerplate (a composition helper is deliberately deferred — see [use-case composition](#use-case-composition)).

## Use-case composition

### Context

Every use-case is a factory `makeX(deps)` returning an async function whose result is a union of success and typed errors ([layered architecture](#layered-architecture), [typed errors](#typed-errors)). As apps grow, use-cases need to reuse one another (e.g. "publish post" needs "detect language" and "translate upfront"), some flows need a shared database transaction, and some side effects must not fail the main operation. Alternatives considered: orchestrating multiple use-cases from the route (business logic leaks into the thin layer), a dedicated orchestrator layer (premature), and `Result`-pipe helpers to chain `T | Err` steps (deferred until the boilerplate actually hurts).

### Decision

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

### Consequences

- \+ Leaf use-cases stay unit-testable with hand-rolled deps; no module mocking, no hidden coupling between use-case files.
- \+ The dependency graph of business flows is readable in one place (`bootstrap/`).
- − `createApp` grows with every flow; accepted ([layered architecture](#layered-architecture)) — it is the single place where wiring is explicit.
- − Transactional wiring duplicates repo construction (once on `db`, once on `tx`); a `withTransaction` helper in bootstrap can fold the pattern when it repeats.

## Self-arming enforcement

### Context

Import boundaries are guarded by two nets ([import boundaries](#import-boundaries)): Biome `noRestrictedImports`
overrides, applied automatically by glob to `apps/*`, and a per-app
`app/arch.spec.ts` that also catches dynamic `import()` the linter misses. The
nets are asymmetric: the Biome net arrives for free, but the architecture test
must be copied by hand into every new app. The first app that forgets it loses
half the net, and boundaries drift before anyone notices.

More broadly, this is a template. Anything we add must not become friction for
the project scaffolded from it — least of all dead example code that has to be
deleted.

### Decision

Enforcement that protects the template's own guarantees is added **now** but
kept **inert until a real app exists**; application code is shipped only as
inert `.template` files to copy, never as live code.

- A repo-level meta-test (`packages/test-utils/src/meta-arch.spec.ts`) discovers
  `apps/*` at runtime and, for each app that has an `app/` layer, requires an
  `app/arch.spec.ts` that actually invokes `assertLayerBoundaries` (presence
  alone is gameable — an empty file would enforce nothing). At day-0 (`apps/`
  holds only `.gitkeep`) it iterates over nothing and passes; it arms itself the
  moment `apps/<x>/app/` appears.
- The boundary scanner's coverage is locked with regression fixtures
  (re-exports, `import type`) so a refactor cannot silently make a check pass
  vacuously. If those ever fail, that is the signal to move from the regex scan
  to a TS-AST walk.
- Reference components/use-cases are shipped as `*.template` files (e.g.
  `packages/ui/src/_example/Button.tsx.template`), mirroring
  `packages/test-utils/templates/layer.arch.spec.ts.template`.

Rule of thumb: infra / CI / enforcement → do it now (inert until needed);
application code → ship as a template to copy.

### Consequences

- \+ New apps cannot quietly skip the architecture test; the gap fails CI with a
  pointer to the template.
- \+ Zero friction at day-0; the template stays generic.
- \+ Boundary coverage is regression-tested, not assumed.
- − The meta-test encodes the `apps/*/app/arch.spec.ts` convention; changing the
  layout means updating it (one place).
- − The arch-test template (`layer.arch.spec.ts.template`) assumes the layer
  layout `app/{domain,use-cases,routes}/`; `assertLayerBoundaries` throws on an
  empty glob, so an app that arms the test without one of those folders fails
  until the template is adapted to its actual layers.
