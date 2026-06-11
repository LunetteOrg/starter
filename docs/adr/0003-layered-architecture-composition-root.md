# ADR-0003: Layered architecture with a composition root

- Status: accepted
- Date: 2026-03-17

## Context

Business logic must stay testable in isolation, independent of the web framework, and the database must be unreachable from UI code. With AI agents writing much of the code, the structure has to be explicit and mechanical, not tribal knowledge.

## Decision

Each app follows fixed layers:

```
app/
├── routes/        → thin RR7 loaders/actions — consume context.app only
├── use-cases/     → orchestrate domain logic, own side effects (factories, see ADR-0013)
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

## Consequences

- \+ Every dependency is injected → unit tests need no module mocking; integration tests wire a mini-app over a test transaction.
- \+ Layer boundaries are mechanically enforceable (ADR-0004).
- − Wiring in `bootstrap/` grows with the app and is boilerplate-ish; this is accepted as the one place where everything is explicit.
