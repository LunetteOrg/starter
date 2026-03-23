# starter — Where We Are

## Status: Architecture Complete ✅

Architecture document: `_bmad-output/planning-artifacts/architecture.md`

---

## Next Step: Create Epics & Stories

```
/bmad-create-epics-and-stories
```

Foundation Stories to generate (in order):
1. Biome + Vitest + Lefthook + `turbo.json` pipeline
2. `createApp(env)` + `getLoadContext` + typed `Env` + `App` type
3. Drizzle + Postgres + `packages/test-utils` (Testcontainers + `withTestDb` + stubs)
4. Lucia + `SessionRepository` + `OtpRepository` + stub `EmailService`
5. First feature domain module + use case + route

---

## Key Decisions (quick ref)

- **Framework:** React Router v7 — loaders/actions, Hono for webhooks
- **DB:** Drizzle + Postgres only (no Redis)
- **Auth:** Lucia + cookie sessions + OTP via Sendgrid (`EmailService` interface)
- **Errors:** `errore` — `createTaggedError` / `tryAsync` / `matchError`
- **DI:** `createApp(env)` → `App = ReturnType<typeof createApp>` → `context.app` in routes
- **Tests:** `.spec.ts` unit, `.test.ts` integration (Testcontainers), Playwright on main push
- **Deploy:** Uncloud (primary), Kamal (fallback), Cloudflare Workers path ready
- **Branching:** Trunk-based, Tech Stories free, User Stories behind feature flag
