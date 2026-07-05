# `serialization/` — the over-serialization harness (templates)

Inert `.template` files (not compiled or linted) that arm a new app against
**over-serialization of React Router 7 loaders/actions** — footgun #1 being
`return { ...entity }`.

## Why

In RR7 the value a loader/action returns is serialized *whole* (turbo-stream)
and shipped to the browser — inline in the SSR HTML and again in every `.data`
request. A returned field is in the payload even if no component reads it, so
controlling client-side consumption protects nothing. The risk is leaking
sensitive columns of the current user (`passwordHash`, tokens, internal flags)
or another user's data pulled in by a join. TypeScript does not help at runtime:
annotating the return type does **not** strip excess keys (the excess-property
check only fires on object literals). Only a runtime projection removes them.

See [ADR-0002 — loader/action serialization boundary](../../../../docs/adr/0002-architecture-and-boundaries.md#loaderaction-serialization-boundary).

## The rule

Loaders/actions return an explicit, flat **read-view/DTO** object literal — never
a domain/db entity, never a nested entity, never `return { ...entity }`.

## What's here

| File | Copy to | What it is |
|---|---|---|
| `read-view.ts.template` | `app/routes/<route>/read-view.ts` | A `zod` output schema whose `.parse()` drops undeclared keys at the boundary. Imports `zod` only — no boundary crossing. |
| `current-user.route.tsx.template` | `app/routes/me.tsx` | Reference loader **and** action that project through the read-view. |
| `current-user.route.test.ts.template` | `app/routes/me.test.ts` | The **golden** integration test: pins the exact key set of the serialized `.data` payload for the loader and the action. Copy it per route that returns data. |

## Two nets (same as import boundaries)

1. **Arch test** — `assertNoEntitySpreadInReturn` (`@starter/test-utils`) fails the
   build on any object-literal spread inside a loader/action return. It ships in
   the canonical `layer.arch.spec.ts.template`, so an app that copies the arch
   test gets the spread-ban for free and the `meta-arch` test keeps it present.
2. **Golden test** — the per-route `me.test.ts` above pins the exact serialized
   shape, catching structural leaks (a new sensitive column, a nested entity)
   that the spread scan cannot see.
