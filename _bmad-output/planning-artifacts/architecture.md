---
stepsCompleted: [1, 2, 3, 4, 5, 6, 7, 8]
lastStep: 8
status: 'complete'
completedAt: '2026-03-17'
inputDocuments: []
workflowType: 'architecture'
project_name: 'starter'
user_name: 'Ilmeskio'
date: '2026-03-17'
---

# Architecture Decision Document

_This document builds collaboratively through step-by-step discovery. Sections are appended as we work through each architectural decision together._

## Project Context Analysis

### Requirements Overview

**Functional Requirements:**
- TypeScript monorepo supporting multiple apps and shared packages
- Full-stack web application(s) with server-rendered UI (React Router v7)
- Type-safe API layer (tRPC/Hono RPC) between client and server
- Database access via Drizzle ORM + Postgres
- Background job processing (BullMQ / Trigger.dev)
- Auth within app, extractable when needed
- Payments (Stripe), i18n, realtime (SSE-first)
- Infrastructure managed via docker-compose locally, Uncloud in production

**Non-Functional Requirements:**
- **Portability:** Web Standards first — Node today, Cloudflare Workers viable without rewrite
- **Testability:** TDD red-green, full test isolation via DI composition root
- **Maintainability:** Static import boundaries, domain isolation, AI-assisted ADRs
- **Developer Experience:** Single command setup, one tool per concern, zero path alias magic
- **Scalability:** Monorepo handles multi-app, multi-team growth — start lean, extract when needed
- **Security:** `process.env` banned outside config boundary, per-app secrets, type-safe validation

**Scale & Complexity:**
- Primary domain: Full-stack TypeScript monorepo
- Complexity level: Medium-High — sophisticated architecture patterns, deliberate lean start
- Team size: 2 now, scaling to 5+
- Apps: 1 today, multiple planned

### Technical Constraints & Dependencies
- TypeScript throughout — no non-TS consumers planned
- `moduleResolution: bundler` — no build step for internal packages
- Uncloud/VPS as primary deploy (no managed cloud services)
- BMAD methodology — stories must be small, trunk-based dev

### Cross-Cutting Concerns

| Concern | Mechanism |
|---|---|
| Error handling | `errore` typed errors throughout |
| Config/secrets | `createApp(env)` composition root |
| Observability | OTel instrumentation + Sentry |
| Import discipline | Biome `noRestrictedImports` |
| Test isolation | Testcontainers + transaction rollback |
| Portability | `getLoadContext()` wired day 1 |
| Feature flags | `flags.json` in repo, `createFlags(env)` abstraction |
| Git hooks | Lefthook + `--filter=...[origin/main]` |

### Architecture Layers

```
routes/          → thin RR7 loaders/actions, consume context.app only
use-cases/       → orchestrate domain services, own side effects
domain/          → pure logic + repository interfaces + errore typed errors
lib/db/repos/    → Drizzle implementations + tryAsync() at boundary
lib/flags/       → createFlags(env) — flags.json today, Unleash tomorrow
bootstrap/       → createApp(env) — wires repos → domain → use cases
config/          → env.ts — type-safe validation, only place that reads env
packages/
  test-utils/    → withTestDb (transaction rollback) + fixture builders + Testcontainers
  ui/            → lightweight shared component library
```

### Migration Strategy (ADR)
Destructive schema changes require 3-step release:
1. **Expand** — add new structure, keep old (backward compatible deploy)
2. **Migrate** — data migration, app writes to both old and new
3. **Contract** — remove old structure once no traffic touches it

CI pipeline order: `migrate → test → deploy`

### Story & Branch Strategy

| Type | Merge Strategy | UAT |
|---|---|---|
| Tech Story | Merge freely to main — no user surface | None |
| User Story | Merge behind feature flag | Flag on staging → PO sign off → flag on prod |

Trunk-based: all branches max 1-2 days. Conventional commits enforced via commitlint + Lefthook. Squash and merge — 1 story = 1 commit on main.

**Branch Naming Convention:**
```
{type}/{story-id}/{short-slug}
```

| Segment | Values | Example |
|---|---|---|
| `type` | `feat`, `fix`, `chore`, `refactor`, `docs` | `feat` |
| `story-id` | Epic + story number from epics list | `E1-S01` |
| `short-slug` | 2-4 word kebab-case description | `project-scaffolding` |

Examples:
- `feat/E1-S01/project-scaffolding`
- `fix/E2-S03/auth-token-refresh`
- `chore/E1-S02/ci-pipeline-setup`

Rules:
- Lowercase only, hyphens and slashes as separators
- No usernames in branch names — `git blame` covers attribution
- Keep slug to 3-4 words max
- For tech stories without a story ID, use `chore/no-story/short-slug`

### Feature Flag Lifecycle
```
FF_OFF (local dev) → merge to main → FF_ON (staging) → UAT → FF_ON (prod) → cleanup
```

### Feature Flag Strategy

#### Two-Layer Model

| Layer | Mechanism | Priority | Use Case |
|---|---|---|---|
| User override | `feature_flag_overrides` DB table | Highest | Permanent per-user enable (ops-assigned) |
| Preview cookie | HMAC-signed cookie `ff_preview` | Second | UAT in prod — self-serve, time-limited |
| Env var | `FF_<FLAG_NAME>=true` | Third | CI / staging control |
| Global default | `flags.json` in repo | Lowest | Base state for all users |

**Primary UAT approach: Option B — Preview Link.** Zero DB writes, zero technical access required. PO can share a link directly with a client.

#### Resolution Order

```
DB override  →  cookie override  →  env var FF_*  →  flags.json
```

#### TypeScript Shape

```ts
// lib/flags/types.ts
export type FlagName = 'new-checkout' | 'new-onboarding'  // extend per feature

export interface FlagRepository {
  getUserOverride(userId: string, flag: FlagName): Promise<boolean | null>
}

export interface FlagEvaluator {
  isEnabled(flag: FlagName): boolean
  isEnabledForUser(flag: FlagName, userId: string): Promise<boolean>
  forRequest(request: Request): RequestScopedFlagEvaluator
}

export interface RequestScopedFlagEvaluator {
  isEnabled(flag: FlagName): boolean
  isEnabledForUser(flag: FlagName, userId: string): Promise<boolean>
}
```

#### Preview Cookie — Payload & Signing

```ts
// lib/flags/preview-cookie.ts
interface PreviewPayload {
  flags: FlagName[]
  expiresAt: string  // ISO 8601 Temporal.Instant — TTL: 24h
}
```

- Signed with HMAC-SHA256 using `env.FLAG_PREVIEW_SECRET`
- `expiresAt` validated via `Temporal` — never `new Date()`
- Expired or tampered cookies silently return `[]` — no error surfaced to user
- Cookie attributes: `HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`

#### `createFlags` Factory

```ts
// lib/flags/index.ts
export function createFlags(env: Env, flagRepo: FlagRepository): FlagEvaluator {
  const base = {
    isEnabled(flag: FlagName): boolean {
      const envKey = `FF_${flag.toUpperCase().replace(/-/g, '_')}` as keyof Env
      return (env[envKey] as boolean | undefined) ?? flagsJson[flag] ?? false
    }
  }
  return {
    ...base,
    async isEnabledForUser(flag, userId) {
      const dbOverride = await flagRepo.getUserOverride(userId, flag)
      if (dbOverride !== null) return dbOverride
      return base.isEnabled(flag)
    },
    forRequest(request) {
      const cookieFlags = parsePreviewCookie(request, env.FLAG_PREVIEW_SECRET)
      return {
        isEnabled: base.isEnabled,
        async isEnabledForUser(flag, userId) {
          const dbOverride = await flagRepo.getUserOverride(userId, flag)
          if (dbOverride !== null) return dbOverride
          if (cookieFlags.includes(flag)) return true
          return base.isEnabled(flag)
        }
      }
    }
  }
}
```

#### Route Consumption

```ts
// In any loader — always use forRequest to get cookie awareness
export async function loader({ request, context }: LoaderFunctionArgs) {
  const session = await context.app.getSession(request)
  if (!session) return redirect('/auth/login')

  const flags = context.app.flags.forRequest(request)
  const hasNewCheckout = await flags.isEnabledForUser('new-checkout', session.userId)

  return { hasNewCheckout }
}
```

#### `/preview` Route — Entry Point

```ts
// routes/preview.tsx
// GET /preview?token=X → validates signed token → sets ff_preview cookie → redirects to /
// Token comes as query param (link-friendly — PO shares URL directly)
export async function loader({ request, context }: LoaderFunctionArgs) {
  const url = new URL(request.url)
  const token = url.searchParams.get('token')
  if (!token) throw new Response('Missing token', { status: 400 })

  const flags = verifyPreviewToken(token, context.app.env.FLAG_PREVIEW_SECRET)
  if (!flags) throw new Response('Invalid token', { status: 403 })

  const cookie = signPreviewFlags(flags, context.app.env.FLAG_PREVIEW_SECRET)
  return redirect('/', {
    headers: { 'Set-Cookie': `ff_preview=${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400` }
  })
}
```

#### Token Generation (Dev CLI)

```ts
// scripts/gen-preview-token.ts
// Usage: pnpm gen-preview-token new-checkout new-dashboard
import { parseEnv } from '../apps/web/app/config/env'

const env = parseEnv(process.env)  // respects process.env ban — single parse point
const flags = process.argv.slice(2) as FlagName[]
const token = signPreviewFlags(flags, env.FLAG_PREVIEW_SECRET)
console.log(`https://app.starter.com/preview?token=${token}`)
```

Dev genera il link → manda al PO → PO lo condivide anche con il cliente. Link valido 24h.

#### UAT in Prod Workflow

```
Dev merges feature (FF globally OFF)
  ↓
pnpm gen-preview-token --flags new-checkout
  ↓
Link → PO (→ eventualmente cliente finale)
  ↓
PO/cliente testa in prod con dati reali — tutti gli altri utenti non vedono nulla
  ↓
Sign-off → flags.json[flag] = true → rimuovi eventuali DB overrides
  ↓
Cleanup: rimuovi flag da codebase una volta stabile
```

#### DB Schema (Option A — override permanente)

```ts
// lib/db/schema/feature-flag-overrides.ts
export const featureFlagOverrides = pgTable('feature_flag_overrides', {
  userId:    uuid('user_id').notNull().references(() => users.id),
  flagName:  text('flag_name').notNull(),
  enabled:   boolean('enabled').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.userId, t.flagName] }) }))
```

#### Unleash Migration Path

Swap `createFlagRepository(db)` → `createUnleashFlagRepository(unleashClient)` — stessa interfaccia `FlagRepository`, zero modifiche alle routes.

#### Deferred

- **Token revocation** — aggiungi `jti` + tabella `revoked_preview_tokens` quando serve (non ora)
- **Percentage rollouts** — Unleash strategy quando si migra
- **Flag UI admin** — route interna per gestire overrides DB senza SQL diretto

### `turbo.json` Pipeline

```json
{
  "$schema": "https://turbo.build/schema.json",
  "ui": "tui",
  "tasks": {
    "lint":        { "outputs": [] },
    "typecheck":   { "outputs": [] },
    "test": {
      "outputs": ["coverage/**"],
      "inputs": ["src/**", "!**/*.spec.ts"]
    },
    "build": {
      "dependsOn": ["^build", "lint", "typecheck"],
      "outputs": ["build/**", "dist/**", ".react-router/**"]
    },
    "dev":         { "cache": false, "persistent": true },
    "db:migrate":  { "cache": false, "outputs": [] },
    "db:generate": { "cache": false, "outputs": ["drizzle/**"] },
    "test:e2e": {
      "dependsOn": ["build"],
      "cache": false,
      "outputs": ["test-results/**", "playwright-report/**"]
    }
  }
}
```

- `test` does NOT depend on `build` — Vitest runs directly on TypeScript sources via Vite (fast CI)
- `test:e2e` depends on `build` — Playwright tests production bundle only, never on PR
- `db:migrate` has no cache — always runs against live DB

### CI/CD Pipeline Detail

```yaml
# ci.yml — PR only (fast feedback)
steps: lint → typecheck → test

# deploy.yml — main push (gates production)
jobs:
  e2e:
    steps:
      - pnpm build
      - docker compose -f infra/docker/compose.yaml up -d   # ephemeral CI DB
      - pnpm db:migrate                                      # against CI DB
      - pnpm test:e2e                                        # Playwright vs localhost
      - docker compose down

  deploy:
    needs: e2e                        # ← real gate
    steps:
      # Intent: deploy migrate container → run migrations → deploy app
      # Exact Uncloud commands TBD during Foundation Story (deploy pipeline).
      # Candidate pattern — migrate service in compose with restart:no:
      #   uc deploy -f infra/uncloud/compose.yaml migrate
      #   uc deploy -f infra/uncloud/compose.yaml app
      # Alternative: uc service run ${APP_IMAGE} pnpm db:migrate -e DATABASE_URL=...
      # Verify against Uncloud docs/community when implementing.
      - run: echo "migrate + deploy — see comment above"
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          APP_IMAGE: ${{ env.APP_IMAGE }}
```

**Rollback note:** Every migration is backward-compatible by design (expand-contract ADR). If `test:e2e` fails post-migrate, deploy does not happen — DB is valid for both old and new code. Rollback = "don't deploy", no DB revert needed.

### Biome `noRestrictedImports` — Strategy B (overrides per layer)

```json
{
  "overrides": [
    {
      "include": ["apps/web/app/domain/**"],
      "linter": {
        "rules": {
          "correctness": {
            "noRestrictedImports": {
              "level": "error",
              "options": {
                "paths": [
                  { "name": "react-router", "message": "Framework forbidden in domain. Domain must stay pure." },
                  { "name": "~/lib", "message": "Lib forbidden in domain. Use injected interfaces only." }
                ]
              }
            }
          }
        }
      }
    },
    {
      "include": ["apps/web/app/routes/**"],
      "linter": {
        "rules": {
          "correctness": {
            "noRestrictedImports": {
              "level": "error",
              "options": {
                "paths": [
                  { "name": "~/use-cases", "message": "Use context.app.useCases instead." },
                  { "name": "~/domain",    "message": "Use context.app instead." },
                  { "name": "~/lib/db",    "message": "DB forbidden in routes." },
                  { "name": "~/bootstrap", "message": "Use context.app in routes, never import bootstrap directly." }
                ]
              }
            }
          }
        }
      }
    }
  ]
}
```

**Fallback:** If `overrides` maintenance becomes friction, collapse to global conservative rules (Strategy A) + architecture tests as second net.

**Architecture tests (second net — `packages/test-utils/src/arch.test.ts`):**
```ts
it('domain files must not import react-router', async () => { ... })
it('routes must not import use-cases directly', async () => { ... })
```
Biome catches violations at pre-commit. Architecture tests catch them in CI.

### Testing Strategy

| Layer | Tool | Convention |
|---|---|---|
| Unit | Vitest | `.spec.ts` — TDD red-green |
| Integration | Vitest + Testcontainers | `.test.ts` — transaction rollback |
| E2E | Playwright | Critical flows only: revenue / onboarding / data loss |

#### Feature Flag Test Helper

```ts
// packages/test-utils/src/flags.ts
export async function withFlag<T>(
  db: Database,
  userId: string,
  flag: FlagName,
  enabled: boolean,
  fn: () => Promise<T>
): Promise<T> {
  await db.insert(featureFlagOverrides)
    .values({ userId, flagName: flag, enabled, createdAt: Temporal.Now.instant().toString() })
    .onConflictDoUpdate({
      target: [featureFlagOverrides.userId, featureFlagOverrides.flagName],
      set: { enabled }
    })
  try {
    return await fn()
  } finally {
    await db.delete(featureFlagOverrides)
      .where(and(eq(featureFlagOverrides.userId, userId), eq(featureFlagOverrides.flagName, flag)))
  }
}
```

Usage — always test both states:
```ts
it('shows new checkout when flag ON', () =>
  withTestDb((db) => withFlag(db, user.id, 'new-checkout', true, async () => { ... })))

it('shows old checkout when flag OFF', () =>
  withTestDb((db) => withFlag(db, user.id, 'new-checkout', false, async () => { ... })))
```

#### Playwright — Cookie Isolation

All Playwright tests start with clean cookie state. No `ff_preview` cookie inherited between tests.

```ts
// playwright.config.ts
export default defineConfig({
  use: {
    storageState: { cookies: [], origins: [] }
  }
})
```

Tests that explicitly verify flag behaviour set the cookie manually:
```ts
test('new checkout visible with preview cookie', async ({ context, page }) => {
  await context.addCookies([{
    name: 'ff_preview',
    value: signPreviewFlags(['new-checkout'], TEST_FLAG_SECRET),
    domain: 'localhost', path: '/'
  }])
  await page.goto('/checkout')
  await expect(page.getByTestId('new-checkout')).toBeVisible()
})
```

### Gaps Resolved (Party Mode Session)

| Decision | Resolution |
|---|---|
| Migration strategy | Blue-green + expand-contract ADR + CI job ordering |
| Import boundaries | Biome `noRestrictedImports` Strategy B (overrides per layer) + architecture tests |
| Use case convention | Two patterns (factory + env chain) — experiment to decide |
| Error boundaries | Repository layer owns `tryAsync()` |
| Repository pattern | Domain defines interface, `lib/db/repos/` implements |
| Integration tests | Testcontainers + transaction rollback |
| Test utils | `packages/test-utils` — `withTestDb` + `withFlag` + fixture builders |
| Critical flow definition | Revenue / onboarding / data loss |
| Story types | Tech Story vs User Story + layer checklist |
| Trunk-based + FF | Tech Stories merge freely, User Stories behind flag |
| UAT | Preview link (signed cookie, 24h TTL) — PO shares link with client, zero DB writes |
| Feature flags | `flags.json` + `createFlags(env, flagRepo)` + preview cookie two-layer model |
| Git hooks | Lefthook + `--filter=...[origin/main]` everywhere |
| Commit convention | Conventional commits via commitlint |
| Auth library | Oslo (primitives) — full schema ownership, Lucia v3 deprecated |
| `getLoadContext` wiring | `{ app, env }` — documented in server.ts, module augmentation in bootstrap/index.ts |
| `turbo.json` pipeline | All tasks defined — test independent of build, test:e2e gates deploy only |
| CI/CD deploy sequence | Ephemeral CI env for Playwright → migrate container → deploy app (exact Uncloud commands TBD in Foundation Story) |
| VPS networking | Tailscale (system daemon) + cloudflared (Docker) + Caddy (HTTP reverse proxy) |
| Secrets management | GitHub Secrets — single source of truth for CI and prod |
| Playwright FF isolation | `storageState: { cookies: [] }` in config — explicit cookie setup per test |

---

## Product Analytics

### Tool: PostHog

**Deployment:** PostHog Cloud (EU region — `https://eu.posthog.com`). Self-hosted su VPS quando: data sovereignty richiesta o eventi > 1M/mese in modo continuativo.

**Integrazione architetturale:** `context.app.analytics` — stessa factory pattern di `createFlags`.

```ts
// lib/analytics/types.ts
export interface AnalyticsService {
  capture(event: string, properties?: Record<string, unknown>): void
  identify(userId: string, traits?: Record<string, unknown>): void
}

// lib/analytics/posthog.ts
import { PostHog } from 'posthog-node'
export function createPostHogAnalytics(apiKey: string): AnalyticsService {
  const client = new PostHog(apiKey, { host: 'https://eu.posthog.com' })
  return {
    capture: (event, props) => client.capture({ distinctId: 'server', event, properties: props }),
    identify: (userId, traits) => client.identify({ distinctId: userId, properties: traits }),
  }
}

// packages/test-utils/src/analytics.ts
export const noopAnalytics: AnalyticsService = {
  capture: () => {},
  identify: () => {},
}
```

```ts
// bootstrap/index.ts
export function createApp(env: Env) {
  const analytics = createPostHogAnalytics(env.POSTHOG_API_KEY)
  return { ..., analytics }
}
```

**Client-side:** `posthog-js` inizializzato nel root layout RR7 **solo dopo consenso** (vedi sezione Cookie Consent).

**Secrets da aggiungere a `.env.example`:**
```bash
POSTHOG_API_KEY=          # server-side (posthog-node)
VITE_POSTHOG_API_KEY=     # client-side (posthog-js, public — ok)
```

### Event Taxonomy

| Evento | Layer | Note |
|---|---|---|
| `registration_completed` | Server — route action | Dopo use case success |
| `checkout_step_viewed` | Client — posthog-js | Interazione UI intermedia |
| `checkout_completed` | Server — route action | Dopo Stripe webhook |
| `purchase` | Server | `{ productId, amount }` |

**Regola:** eventi di business → server via `context.app.analytics`. Interazioni UI intermedie → `posthog-js` client. Mai duplicare lo stesso evento su entrambi i layer.

---

## Cookie Consent & GDPR

**Utenti target:** residenti in Italia (EU) — consenso esplicito obbligatorio day 1 per il Garante Privacy.

**Tool:** `vanilla-cookieconsent` (Orest Bida) — npm package, TypeScript first-class, ~6KB, script auto-blocking built-in.

### Google Consent Mode v2

Implementato day 1 come forward-compatibility. Costa zero, richiesto da Google se si aggiungono GA4 o Google Ads in futuro.

```ts
// lib/consent/config.ts — sezione categories
analytics: {
  onAccept: () => gtag('consent', 'update', { analytics_storage: 'granted' }),
  onDecline: () => gtag('consent', 'update', { analytics_storage: 'denied' })
}
```

### Configurazione

```ts
// lib/consent/config.ts
import type { CookieConsentConfig } from 'vanilla-cookieconsent'

export const consentConfig: CookieConsentConfig = {
  revision: 1,  // ⚠️ incrementa ad ogni nuovo vendor → re-prompt utenti

  guiOptions: {
    consentModal: { layout: 'bar', position: 'bottom' }
  },

  categories: {
    necessary: { enabled: true, readOnly: true },
    analytics: {
      autoClear: {
        cookies: [{ name: /^_ph_/ }, { name: 'ph_session' }]
      },
      onAccept: () => gtag('consent', 'update', { analytics_storage: 'granted' }),
      onDecline: () => gtag('consent', 'update', { analytics_storage: 'denied' })
    },
    monitoring: {
      autoClear: { cookies: [{ name: /^_sentry/ }] }
    }
  },

  language: {
    default: 'it',
    translations: {
      it: {
        consentModal: {
          title: 'Utilizziamo i cookie',
          description: 'Utilizziamo strumenti analitici per migliorare il servizio e monitorare gli errori tecnici.',
          acceptAllBtn: 'Accetta tutti',
          rejectAllBtn: 'Rifiuta',
          showPreferencesBtn: 'Gestisci preferenze'
        },
        preferencesModal: {
          title: 'Preferenze cookie',
          sections: [
            {
              title: 'Analisi utilizzo',
              description: 'PostHog — statistiche aggregate sull\'utilizzo del servizio.',
              linkedCategory: 'analytics',
              cookieTable: {
                headers: { name: 'Cookie', duration: 'Durata', description: 'Descrizione' },
                body: [
                  { name: '_ph_*', duration: '1 anno', description: 'Analisi comportamento utente' }
                ]
              }
            },
            {
              title: 'Monitoraggio errori',
              description: 'Sentry — tracciamento errori tecnici anonimi.',
              linkedCategory: 'monitoring'
            }
          ]
        }
      }
    }
  }
}
```

**`posthog-js` gated da consenso:**
```ts
// root.tsx
useEffect(() => {
  if (CookieConsent.acceptedCategory('analytics')) {
    posthog.init(env.VITE_POSTHOG_API_KEY, {
      host: 'https://eu.posthog.com',
      persistence: 'localStorage',
      loaded: (ph) => userId && ph.identify(userId)
    })
  }
}, [])
```

### Cookie Declaration (GDPR Garante)

La `preferencesModal` con `cookieTable` per categoria **è la cookie declaration** — soddisfa il requisito Garante di elencare ogni cookie, scopo e durata.

**Generazione iniziale:** Cookiebot free scanner (cookiebot.com/en/cookie-checker/) puntato su staging — produce la lista di cookie rilevati da trascrivere nel config.

**`revision`** — checklist obbligatoria per ogni story che aggiunge un vendor esterno:
- [ ] Aggiorna `cookieTable` nella categoria corretta
- [ ] Incrementa `revision` in `lib/consent/config.ts`
- [ ] Aggiorna `.env.example` con il nuovo secret se necessario

### Cookie Audit in CI (Playwright)

```ts
// tests/cookie-audit.spec.ts
test('no tracking cookies set without consent', async ({ context, page }) => {
  // storageState: { cookies: [] } già nel playwright.config.ts
  await page.goto('/')
  const cookies = await context.cookies()
  const tracking = cookies.filter(c =>
    c.name.startsWith('_ph_') || c.name.startsWith('_sentry')
  )
  expect(tracking).toHaveLength(0)
})

test('only declared cookies present after consent', async ({ context, page }) => {
  await context.addCookies([{
    name: 'cc_cookie',
    value: JSON.stringify({ categories: ['necessary', 'analytics', 'monitoring'] }),
    domain: 'localhost', path: '/'
  }])
  await page.goto('/')
  const cookies = await context.cookies()
  const declared = ['_ph_', 'ph_session', 'cc_cookie', '_sentry']
  const undeclared = cookies.filter(c => !declared.some(d => c.name.startsWith(d)))
  expect(undeclared).toHaveLength(0)
})
```

Gira in `deploy.yml` — ogni deploy verifica che la declaration sia aggiornata.

---

## Advertising & Server-side Tracking

### Approccio primario: PostHog Data Pipelines

Quando arriva la necessità di advertising tracking (Google Ads, Meta, LinkedIn):

```
Evento business (checkout_completed)
  → context.app.analytics.capture('purchase', { productId, amount })
  → PostHog Data Pipelines → Google Ads Conversion API (server-side)
                           → Meta Conversion API (server-side)
```

Zero cookie di terze parti, zero GTM necessario, GDPR semplificato.

### GTM — Deferred

**Trigger per valutare GTM:** quando un canale advertising richiede tracking client-side non coperto dalle Conversion API server-side.

**Se GTM viene aggiunto:**
- GTM Workspaces separati: `staging` / `production`
- Nessun marketer pubblica direttamente in production — passa da review dev
- Ogni nuovo tag → aggiornamento `cookieTable` + bump `revision` obbligatorio

### Safety net: GH Action cookie scan automatico

Quando GTM è attivo, una GH Action scheduled cattura variazioni di cookie indipendenti dai deploy:

```yaml
# .github/workflows/cookie-audit.yml
on:
  schedule:
    - cron: '0 3 * * *'   # nightly
  workflow_dispatch:

jobs:
  cookie-audit:
    steps:
      - uses: actions/checkout@v4
      - run: pnpm playwright test tests/cookie-audit.spec.ts
        env:
          BASE_URL: https://app.starter.com
      - name: Open PR if undeclared cookies found
        if: failure()
        # → auto-PR con lista cookie rilevati non dichiarati
        # → notifica Slack al team
```

---

## PO Prototyping Environment

### Approccio: `apps/proto` nel monorepo

Il prototipo usa i componenti reali di `@starter/ui` — zero divergenza visiva tra prototipo e produzione.

**⚠️ `apps/proto` è un wireframe interattivo in React — equivalente a un mockup Figma navigabile. Dati hardcodati, zero API call, zero autenticazione reale. L'unico scopo è visualizzare flussi e componenti reali al loro posto. Il codice non viene mai mergiato direttamente in altri app.**

### Vincoli rilassati per `apps/proto`

```json
// apps/proto/biome.json
{
  "extends": ["../../biome.json"],
  "overrides": [
    {
      "include": ["app/**"],
      "linter": {
        "rules": {
          "correctness": { "noRestrictedImports": "off" }
        }
      }
    }
  ]
}
```

**Turbo — escluso da lint/typecheck/test, incluso in build e dev:**
```json
// turbo.json — tasks esistenti, aggiungere filter dove necessario
```

**CI — escluso da tutti i job:**
```yaml
# ci.yml e deploy.yml
- run: pnpm turbo lint typecheck test --filter=!apps/proto
```

**Incluso nel build Turbo** per rilevare breaking changes ai componenti `@starter/ui`. Se il build si rompe, lo sappiamo prima della demo.

### Struttura `apps/proto`

```
apps/proto/
  app/
    components/    ← nuovi componenti creati dal PO (non in @starter/ui)
    routes/        ← flussi prototipali — no domain layer, no use-cases
  README.md        ← ⚠️ PROTOTYPE ONLY — visual reference, never merge
```

**Il PO non modifica `@starter/ui`.** Se serve un componente nuovo:
1. PO lo crea in `apps/proto/app/components/`
2. Dev valida e promuove a `packages/ui/src/components/` via story BMAD

### Bootstrap: Lovable

Il primo prototipo viene generato dal team dev a partire da Lovable — velocità massima per avere una base navigabile. Il codice generato viene importato in `apps/proto/` nel monorepo.

**Perché Lovable per il bootstrap:**
- Genera rapidamente flussi React navigabili da una descrizione
- Il team dev supervisiona l'import e adatta dove necessario
- Non è il PO che lavora in autonomia in questa fase — è il team che costruisce la base

### Iterazioni successive: OpenHands

Dopo il bootstrap iniziale, il PO usa OpenHands per iterare su `apps/proto/` in autonomia.

Web UI chat-based. Gira in Docker, legge il repo, scrive in `apps/proto/`, può avviare `pnpm dev` e mostrare la preview nel browser integrato.

**Istruzioni da fornire a OpenHands:**
- Usa componenti `@starter/ui` disponibili
- Dati sempre hardcodati — nessuna fetch, nessun API call
- Nessuna autenticazione reale — simula lo stato loggato con una costante
- Routes puramente presentazionali — nessun use case, nessun domain layer
- Obiettivo: navigare il flusso e vedere i componenti al loro posto, non funzionare davvero

**Fallback:** se OpenHands non soddisfa le esigenze, deploy di `apps/proto` su `proto.starter.com` come staging prototipale condivisibile.

### Collaborazione UX-PO

Sally (UX) è sparring partner opzionale per ogni sessione di prototyping significativa:
- Orienta il PO sui componenti già disponibili in `@starter/ui`
- Evita duplicati e inconsistenze di pattern
- Non supervisiona — co-progetta

### Handoff a BMAD

Story BMAD con riferimento al prototipo nel frontmatter:
```yaml
prototype_ref: apps/proto/app/routes/checkout.tsx
# oppure
prototype_ref: https://proto.starter.com/checkout
```

Il team dev analizza il prototipo e ha diritto di push back motivato (vincolo architetturale, effort non stimato, violazione pattern).

---

## Remote Development

### Dev Container

`.devcontainer/devcontainer.json` nel repo — ambiente identico per tutti i dev, ovunque nel mondo.

```json
{
  "name": "starter",
  "image": "mcr.microsoft.com/devcontainers/typescript-node:24",
  "features": {
    "ghcr.io/devcontainers/features/docker-in-docker:2": {},
    "ghcr.io/devcontainers/features/github-cli:1": {}
  },
  "postCreateCommand": "pnpm install",
  "forwardPorts": [3000, 5432],
  "customizations": {
    "vscode": {
      "extensions": ["biomejs.biome"]
    }
  }
}
```

**Docker-in-Docker è obbligatorio** — Testcontainers richiede un Docker socket funzionante. Verificare esplicitamente che i test di integrazione girino in Codespaces nella Foundation Story dedicata.

### GitHub Codespaces

Usa il devcontainer automaticamente. Qualsiasi membro del team apre il repo e ottiene un ambiente completo in browser — nessun setup locale richiesto.

Utile anche per OpenHands: il PO può aprire un Codespace invece di un setup locale per `apps/proto`.

### Claude Code — Organization

- **CLAUDE.md** nel root del repo — fonte di verità condivisa per tutti i dev che usano Claude Code
- **Organization license** — tutti i membri del team partono dallo stesso contesto architetturale, nessuno deve re-spiegare i pattern a Claude
- **Claude Code Desktop remote** — via SSH su macchine remote o VPS per sessioni di sviluppo remote

### Cross-Cutting Concerns aggiornati

| Concern | Mechanism |
|---|---|
| Product analytics | `context.app.analytics` — `AnalyticsService` interface, PostHog cloud EU |
| Consent management | `lib/consent/` + vanilla-cookieconsent + Google Consent Mode v2 |
| Analytics gate | `posthog-js` init condizionato a `consent.analytics === 'granted'` |
| Cookie declaration | `preferencesModal.cookieTable` + `revision` bump per ogni nuovo vendor |
| Cookie audit | Playwright test in `deploy.yml` + GH Action nightly quando GTM attivo |
| Advertising tracking | PostHog Data Pipelines server-side — GTM deferred |
| PO prototyping | `apps/proto` + OpenHands — riferimento visivo, mai merge diretto |
| Remote dev | `.devcontainer/` + GitHub Codespaces + Claude Code org |

---

## Starter Template

**Approach:** `create-turbo` minimal scaffold + custom build per architecture decisions
**Rationale:** No community starter matches the opinionated stack. Building from minimal scaffold avoids cleanup debt and mismatched tooling.

**Initialization Command:**
```bash
pnpm create turbo@latest starter --package-manager pnpm
```

**What the scaffold provides:**
- pnpm workspaces configured
- `apps/` + `packages/` structure
- `turbo.json` pipeline scaffold

**Everything else:** implemented as Foundation Stories per architecture decisions below.

**Runtime Decision:**
- **Node.js:** 24 LTS — Active LTS through April 2028. Strip types stable natively (no flags, no external transpiler for scripts). Enforced via `engines` in root `package.json` + `.nvmrc`.
- **Escape hatch:** Bun — drop-in swap if test suite or dev server performance becomes a bottleneck
- **Rejected:** Deno — ecosystem gaps outweigh web standards benefits already covered by architecture discipline

```json
// package.json (root)
{ "engines": { "node": ">=24.0.0" } }
```
```
# .nvmrc
24
```

**Strip types — Node.js 24 native TypeScript execution:**
- Scripts (e.g. `gen-preview-token.ts`) run directly: `node scripts/gen-preview-token.ts` — zero `tsx`/`ts-node`
- Supported: type annotations, interfaces, type aliases, generics
- Not supported: enums, decorators, namespaces, parameter properties — none used in this codebase

**Bundler:**
- **Vite 8** (Rolldown-powered) — React Router v7 was an explicit framework partner in early testing. 10-30x faster builds. Pin explicitly in `package.json` — do not accept scaffold default.

---

## Graceful Shutdown — React Router 7 Fullstack su Uncloud

**Context:**
- App React Router 7 with Node/Express server
- Deploy on Uncloud (Docker + Caddy as reverse proxy)
- Uncloud already does rolling deploys: keeps old container alive until new one is healthy
- Problem to solve: old container must not die abruptly on SIGTERM — it must finish in-flight requests before shutting down

**Solution — SIGTERM handler in server:**
```js
const server = app.listen(3000);

const connections = new Set();
server.on("connection", (conn) => {
  connections.add(conn);
  conn.on("close", () => connections.delete(conn));
});

process.on("SIGTERM", async () => {
  server.close(async () => {
    await db.end();       // close DB pool, Redis, etc.
    process.exit(0);
  });

  // destroy keep-alive connections after 5s to unblock server.close()
  setTimeout(() => connections.forEach((c) => c.destroy()), 5000);

  // force exit after 30s
  setTimeout(() => process.exit(1), 30000);
});
```

**compose.yaml:**
```yaml
services:
  web:
    stop_grace_period: 30s   # Docker waits this long before SIGKILL
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 5s
      retries: 3
```

**What Uncloud does automatically:**
1. Starts the new container
2. Waits for health check to pass
3. Removes old container from Caddy rotation
4. Sends SIGTERM to old container → handler above kicks in

**Timing chain:** SIGTERM → `server.close()` stops accepting new connections → 5s keep-alive drain → `db.end()` cleanup → `process.exit(0)`. Fallback `process.exit(1)` at 30s matches `stop_grace_period`.

**General principle — applies to every long-lived Node process in production:**

| Process type | "Stop accepting" | "Drain in-flight" | "Cleanup" |
|---|---|---|---|
| HTTP server (RR7, Hono) | `server.close()` | destroy keep-alive after 5s | `db.end()`, pool teardown |
| Job worker (pg-boss, Trigger.dev) | `worker.close()` | wait for current job to finish | release DB/queue connections |

The pattern is always: SIGTERM → stop accepting new work → finish current work → cleanup resources → `process.exit(0)`. Each process type has its own API for steps 1-2, but the SIGTERM handler structure and `compose.yaml` config (`stop_grace_period`, healthcheck) remain the same.

---

## Core Architectural Decisions

### Decision Priority Analysis

**Critical (Block Implementation):**
- Postgres only (no Redis) — jobs/caching deferred
- Repository pattern throughout — domain defines interfaces
- `createApp(env)` composition root wired via `getLoadContext` day 1
- Lucia auth (assumption pending auth spec)
- Cookie-based sessions via `SessionRepository` interface

**Important (Shape Architecture):**
- Blue-green + expand-contract migration discipline
- OTP flow via `OtpRepository` + stub `EmailService` in test-utils
- Errore typed errors at all boundaries
- Plain React state, Zustand when shared state gets complex

**Deferred (Post-MVP):**
- Caching layer (Redis) — add when specific bottleneck identified
- Jobs queue (pg-boss/graphile-worker/Trigger.dev) — add when first async job needed
- Rate limiting — add when first public endpoint requires it
- Magic link auth — auth spec story
- Resend OTP + expiry UX — auth spec story

### Data Architecture

- **ORM:** Drizzle ORM + Drizzle Kit migrations
- **Database:** Postgres only — single docker-compose service
- **Pattern:** Repository interfaces in domain, Drizzle implementations in `lib/db/repos/`
- **Error boundary:** `tryAsync()` wraps all Drizzle calls at repository layer
- **Migrations:** Blue-green + expand-contract — CI order: migrate → test → deploy
- **Caching:** Deferred — Redis via `ioredis` when load justifies it
- **Sessions:** `SessionRepository` interface — Postgres default, Redis swap ready

### Authentication & Security

- **Library:** Oslo (primitive crypto/session utilities by the original Lucia author) — full schema ownership, no framework opinions
- **Rationale:** Oslo chosen over Better Auth (which aliases its own schema, preventing pure `SessionRepository`/`OtpRepository` interfaces) and over Lucia v3 (author stepping away from maintenance)
- **Session model:** Cookie-based, stored in Postgres via `SessionRepository` — schema 100% ours in `lib/db/schema/sessions.ts`
- **OTP flow:** `OtpRepository` with discriminated verify result (`valid | expired | invalid | used`) — schema in `lib/db/schema/otp-codes.ts`
- **Email delivery:** Direct Sendgrid API call via `EmailService` interface (`lib/email/`)
- **Email errors:** Typed in `lib/email/errors.ts` — infrastructure concern, not domain
- **Test email:** Stub `EmailService` in `packages/test-utils` — full OTP flow testable without Sendgrid
- **Env security:** `process.env` banned outside `config/env.ts`, type-safe validation at startup
- **Import security:** Biome `noRestrictedImports` — `db` never reachable from frontend

### API & Communication

- **Primary:** RR7 loaders/actions — progressive enhancement, server-rendered
- **Webhooks:** Hono — clean HTTP handlers for external providers (Stripe, GitHub, etc.)
- **External API consumers:** Deferred — evaluate tRPC vs Hono+OpenAPI vs ElysiaJS when the need exists. ElysiaJS offers end-to-end type safety similar to tRPC but with a REST-native API and built-in Typebox validation.
- **Error handling:** errore throughout — `createTaggedError`, `matchError`, `tryAsync`
- **Rate limiting:** Deferred — Hono/ElysiaJS middleware when first public unauthenticated endpoint ships

### Frontend Architecture

- **Framework:** React Router v7 — loader/action pattern, progressive enhancement
- **Future:** Remix 3 on watchlist — migration path clear via domain isolation
- **Styling:** CSS Modules for component styles + Tailwind for utilities
- **Components:** Lightweight `@starter/ui` — prototyping-ready, Storybook optional
- **State:** Plain React state by default, Zustand when shared state gets complex
- **i18n:** Domain module first, extract to `@starter/i18n` when needed

### Infrastructure & Deployment

- **Primary:** Uncloud on VPS
- **Fallback:** Kamal
- **Future:** Cloudflare Workers — web standards + `getLoadContext` pattern ready
- **CI/CD:** GitHub Actions + Turborepo `--filter=...[origin/main]`
  - `ci.yml` (PR): Biome + tsc + Vitest only — fast feedback
  - `deploy.yml` (main push): Playwright (ephemeral CI env) → migrate container → deploy app (exact Uncloud commands TBD)
- **Observability:** OTel instrumentation + Sentry — backend (Grafana Cloud vs self-hosted) TBD
- **Secrets:** GitHub Secrets — single source of truth for CI and prod. Local: per-app `.env` (gitignored), `.env.example` committed
- **Jobs:** pg-boss — Postgres-backed queue + cron scheduler. Add when first async job or schedule needed. Redis not required.
- **Cron:** See Cron Strategy section below.

### Networking & VPS Access

```
VPS system (outside Docker):
  tailscaled (systemd)        ← SSH/admin access for devs via Tailscale. Outside Docker so
                                 it survives Docker failures.

Docker / Uncloud stack:
  cloudflared                 ← Cloudflare Tunnel — outbound only, no ports exposed.
                                 In Docker: lifecycle tied to app (web down = tunnel down = fine).
  caddy                       ← HTTP reverse proxy. No TLS (Cloudflare terminates at edge).
                                 Handles internal routing, health checks, logging.
  app
  postgres
```

**Web traffic flow:** `User → Cloudflare Edge (TLS) → cloudflared tunnel → Caddy (HTTP) → app`
**Admin access:** `Dev → Tailscale → SSH → VPS → uc CLI`

**Zero exposed ports on VPS** — no 22, no 80, no 443 open to the internet.

### Secrets Management

| Context | Mechanism |
|---|---|
| Local dev | `.env` per app (gitignored) — `.env.example` committed as reference |
| CI (GitHub Actions) | GitHub Secrets → env vars in workflow |
| Production VPS | GitHub Secrets injected at deploy time via `uc deploy` |

**Secrets inventory (`apps/web/.env.example`):**
```bash
DATABASE_URL=             # Postgres connection string
SENDGRID_API_KEY=         # Email delivery
FLAG_PREVIEW_SECRET=      # HMAC signing for FF preview cookie
CLOUDFLARE_TUNNEL_TOKEN=  # cloudflared tunnel auth
# Future (placeholder):
# SENTRY_DSN=
# STRIPE_SECRET_KEY=
```

Adding a new secret requires 3 explicit steps: update `.env.example` + add to GitHub Secrets + add to `deploy.yml` env block.

**⚠️ Uncloud `configs` must NOT be used for secrets.** Config content travels via gRPC from the deploy machine to the Uncloud daemon in plaintext. Secrets go exclusively via `environment` + `${VAR}` interpolation, resolved from the GitHub Actions environment at deploy time.

### Cron Strategy

Uncloud has no native cron support. Two patterns depending on the type of task:

#### Application-level cron (business logic)
*"Send weekly digest", "expire OTP codes", "retry failed webhooks"*

**pg-boss** — already the chosen jobs queue. Cron is built-in, Postgres-backed, no daemon needed.

```ts
// workers/index.ts — runs as a separate service in compose
const boss = new PgBoss(env.DATABASE_URL)
await boss.start()

await boss.schedule('expire-otp-codes', '*/15 * * * *', {})
await boss.work('expire-otp-codes', async () => {
  await context.app.useCases.auth.expireOtpCodes()
})
```

```yaml
# infra/uncloud/compose.yaml — worker alongside app
services:
  app:
    image: ${APP_IMAGE}
  worker:
    image: ${APP_IMAGE}        # same image, different command
    command: node workers/index.ts   # Node 24 strip types ✅
    environment:
      DATABASE_URL: ${DATABASE_URL}
    restart: unless-stopped
```

Schedule stored in Postgres → survives restarts, no clock drift, exactly-once delivery.

#### Infrastructure-level cron (ops tasks)
*"Nightly DB vacuum", "cleanup expired sessions", "generate reports"*

**GitHub Actions scheduled workflow** — zero infrastruttura, log in GitHub, retry built-in.

```yaml
# .github/workflows/cron.yml
on:
  schedule:
    - cron: '0 2 * * *'   # nightly at 2am UTC
jobs:
  cleanup:
    steps:
      - run: node scripts/cleanup-expired-sessions.ts
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
```

#### Decision rule

| Task type | Pattern |
|---|---|
| Business logic, needs reliability + retry | pg-boss scheduled job |
| Ops/maintenance, low criticality | GitHub Actions scheduled |
| Both deferred until first need | — |

**Scaling Triggers (when to un-defer):**

| Deferred Item | Signal |
|---|---|
| Caching | p95 response > 500ms on a read-heavy route |
| Jobs queue | First use case needs to run async (email retry, webhook delivery) |
| Rate limiting | First public unauthenticated endpoint ships |

### Decision Impact Analysis

**Implementation Sequence:**
1. Foundation: `create-turbo` scaffold + Biome + Vitest + Lefthook + `turbo.json` pipeline
2. Bootstrap: `createApp(env)` + `getLoadContext` + typed `Env` schema
3. Database: Drizzle + Postgres + `packages/test-utils` (Testcontainers + `withTestDb` + stubs)
4. Auth: Lucia + `SessionRepository` + `OtpRepository` + stub `EmailService`
5. First feature: domain module + repository + use case + route

**Cross-Component Dependencies:**
- All use cases depend on bootstrap wiring
- All repositories depend on Drizzle db instance (injected via bootstrap)
- Auth flow depends on `EmailService` interface (Sendgrid in prod, stub in tests)
- Session validation happens in RR7 loader via `context.app` — no direct Lucia imports in routes

---

## Implementation Patterns & Consistency Rules

### Naming Patterns

**Database (Drizzle → Postgres):**
- Tables: `snake_case` plural — `users`, `otp_codes`, `sessions`
- Columns: `snake_case` — `user_id`, `created_at`, `expires_at`
- Foreign keys: `{table_singular}_id` — `user_id`, `session_id`
- Drizzle maps automatically to `camelCase` in TypeScript

**Files:**
- All files: `kebab-case` — `user-repository.ts`, `register-user.ts`, `make-register-user.ts`
- React components: `PascalCase` — `UserCard.tsx`, `LoginForm.tsx`
- Folders: `kebab-case` always — `test-utils/`, `auth/`, `use-cases/`

**Code:**
- Functions/variables: `camelCase` — `registerUser`, `findByEmail`
- Types/interfaces: `PascalCase` — `UserRepository`, `SessionRepository`
- Errore tagged errors: `PascalCase` — `UserNotFound`, `InvalidOtp`
- Constants: `SCREAMING_SNAKE_CASE` — `MAX_OTP_ATTEMPTS`

### Structure Patterns

**Test co-location:**
```
domain/auth/
  auth-service.ts
  auth-service.spec.ts      ← unit test co-located
  auth-service.test.ts      ← integration test co-located
  otp-repository.ts
  otp-repository.spec.ts
```

**Use case factory pattern:**
```ts
// Standard signature — all use cases follow this shape
export function make{UseCaseName}(deps: {
  // explicit deps only
}): (input: {Input}) => Promise<{Output} | AppError> {
  return async (input) => { ... }
}
```

**`context.app` type pattern:**
```ts
// bootstrap/index.ts
export function createApp(env: Env) {
  const db = createDb(env.DATABASE_URL)
  const otpRepo = createOtpRepository(db)
  const sessionRepo = createSessionRepository(db)
  const flagRepo = createFlagRepository(db)
  const emailService = createSendgridEmailService(env.SENDGRID_API_KEY)
  const flags = createFlags(env, flagRepo)

  return {
    env,  // exposed for middleware/DI patterns — same validated instance, no double-parse
    flags,
    useCases: {
      auth: {
        requestOtp: makeRequestOtp({ otpRepo, emailService }),
        verifyOtp: makeVerifyOtp({ otpRepo, sessionRepo }),
      },
    },
    getSession: (request: Request) => getSession(request, sessionRepo),
  }
}

// Derived type — single source of truth, no manual interface maintenance
export type App = ReturnType<typeof createApp>

// RR7 module augmentation — lives here (has App type, zero circular imports)
declare module 'react-router' {
  interface AppLoadContext {
    app: App
    env: Env  // exposed directly for future middleware/DI patterns
  }
}
```

**`getLoadContext` wiring — `server.ts`:**
```ts
// server.ts (Node.js entry — @react-router/node adapter)
import { createRequestHandler } from '@react-router/node'
import { parseEnv } from './app/config/env'
import { createApp } from './app/bootstrap/index'

const env = parseEnv(process.env)  // single parse point
const app = createApp(env)

export default createRequestHandler({
  build: () => import('./build/server/index.js'),
  getLoadContext(request: Request): AppLoadContext {
    return { app, env }  // portable: Request only, no Express req/res
  }
})
```

Note: `getLoadContext` receives only `Request` (web standard) — no Express `req`/`res` dependencies. This is the Cloudflare Workers-compatible signature.

```ts
// Route — only valid shape for consuming app
export async function loader({ request, context }: LoaderFunctionArgs) {
  const session = await context.app.getSession(request)
  if (!session) return redirect('/auth/login')
  const flags = context.app.flags.forRequest(request)
  const result = await context.app.useCases.auth.verifyOtp({ ... })
  return matchError(result, { ... })
}
```

**Repository interface pattern:**
```ts
// domain/{module}/{module}-repository.ts
export interface {Module}Repository {
  // methods return Promise<T | AppError> — never throw
}

// lib/db/repos/{module}.repo.ts
export function create{Module}Repository(db: Database): {Module}Repository {
  return {
    // tryAsync() wraps all Drizzle calls here
  }
}
```

### Format Patterns

**Date/Time — Temporal API:**
```ts
// lib/temporal.ts — single import point
import { Temporal } from '@js-temporal/polyfill'
export { Temporal }

// Internal: always Temporal types
// API/JSON boundary: always ISO 8601 strings
// Drizzle timestamptz → Temporal.Instant in repositories
```

**API response format:** Deferred — decide when first Hono/ElysiaJS public endpoint is built.

**JSON field naming:** `camelCase` — TypeScript convention, Drizzle maps from snake_case automatically.

### TypeScript Configuration

```json
{
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "exactOptionalPropertyTypes": true,
  "noImplicitReturns": true,
  "moduleResolution": "bundler"
}
```

### Process Patterns

**Error handling — all agents MUST:**
- Use `errore` `createTaggedError` for domain errors
- Use `tryAsync()` at repository layer to wrap Drizzle calls
- Use `matchError()` in route actions for exhaustive handling
- Never `throw` below the use-case layer

**Import rules — all agents MUST:**
- Never import `db` from frontend packages
- Never import `process.env` outside `config/env.ts`
- Never import framework (RR7) in domain packages
- Use `context.app` in routes — never import use cases directly

**Enforcement:**
- Biome `noRestrictedImports` — boundary violations are CI errors
- Architecture tests in `packages/test-utils` — framework imports in domain packages fail tests
- Lefthook pre-commit — Biome check on staged files
- Turbo pipeline — `migrate → test → build` order enforced

### Anti-Patterns

❌ `throw new Error()` — use `errore` instead
❌ `process.env.X` outside `config/env.ts` — inject via `createApp(env)`
❌ `new Date()` — use `Temporal` instead
❌ Direct Drizzle calls in domain — use repository interface
❌ Business logic in RR7 route actions — use use cases
❌ Framework imports in domain packages — domain must stay pure
❌ `vi.mock` on database/repository in `.test.ts` — use `withTestDb` + transaction rollback instead
❌ `tsx` / `ts-node` for scripts — use `node` directly (Node.js 24 strip types, erasable syntax only)

---

## Project Structure & Boundaries

### Complete Project Directory Structure

```
starter/
├── .github/
│   └── workflows/
│       ├── ci.yml                    # test + lint on PR
│       └── deploy.yml                # migrate → deploy on main
├── apps/
│   └── web/                          # React Router v7 app
│       ├── app/
│       │   ├── bootstrap/
│       │   │   ├── index.ts          # createApp(env) — composition root
│       │   │   ├── db.ts             # drizzle instance
│       │   │   ├── auth.ts           # lucia + session repo
│       │   │   └── use-cases.ts      # all use cases wired
│       │   ├── config/
│       │   │   └── env.ts            # type-safe env validation
│       │   ├── domain/
│       │   │   ├── core/             # shared interfaces, value objects
│       │   │   └── auth/
│       │   │       ├── auth-service.ts
│       │   │       ├── auth-service.spec.ts
│       │   │       ├── otp-repository.ts
│       │   │       ├── session-repository.ts
│       │   │       └── errors.ts
│       │   ├── use-cases/
│       │   │   └── auth/
│       │   │       ├── make-request-otp.ts
│       │   │       ├── make-request-otp.spec.ts
│       │   │       ├── make-verify-otp.ts
│       │   │       └── make-verify-otp.spec.ts
│       │   ├── lib/
│       │   │   ├── db/
│       │   │   │   ├── schema/
│       │   │   │   │   ├── users.ts
│       │   │   │   │   ├── sessions.ts
│       │   │   │   │   └── otp-codes.ts
│       │   │   │   └── repos/
│       │   │   │       ├── otp.repo.ts
│       │   │   │       ├── otp.repo.test.ts
│       │   │   │       └── session.repo.ts
│       │   │   ├── email/
│       │   │   │   ├── sendgrid.ts       # EmailService implementation
│       │   │   │   └── errors.ts
│       │   │   ├── flags/
│       │   │   │   ├── index.ts          # createFlags(env)
│       │   │   │   └── flags.json        # feature flag config
│       │   │   └── temporal.ts           # Temporal re-export
│       │   └── routes/
│       │       ├── _layout.tsx
│       │       ├── _index.tsx
│       │       └── auth/
│       │           ├── login.tsx
│       │           └── verify.tsx
│       ├── drizzle/                  # migration files
│       ├── public/
│       ├── .env
│       ├── .env.example
│       ├── package.json
│       ├── tsconfig.json
│       ├── vite.config.ts
│       └── react-router.config.ts
├── packages/
│   ├── tsconfig/
│   │   ├── base.json                 # strict + noUncheckedIndexedAccess + etc.
│   │   ├── node.json
│   │   └── browser.json
│   ├── biome/
│   │   └── biome.json                # shared baseline rules
│   ├── ui/                           # @starter/ui
│   │   ├── src/
│   │   │   └── components/
│   │   └── package.json
│   └── test-utils/                   # @starter/test-utils
│       ├── src/
│       │   ├── db.ts                 # withTestDb + Testcontainers
│       │   ├── fixtures.ts           # fixture builders
│       │   └── email.ts              # stub EmailService
│       └── package.json
├── infra/
│   ├── docker/
│   │   └── compose.yaml             # local dev — Postgres only
│   ├── uncloud/
│   │   └── compose.yaml             # production — cloudflared + caddy + app + postgres
│   ├── cloudflare/
│   │   └── config.yml               # cloudflared tunnel config (no secrets — token via env)
│   ├── tailscale/
│   │   └── README.md                # setup instructions — tailscaled installed on VPS as systemd daemon
│   ├── kamal/
│   │   └── deploy.yml               # fallback VPS deploy
│   ├── iac/                          # placeholder for Terraform/Pulumi
│   │   └── .gitkeep
│   └── scripts/
│       ├── setup.sh                  # bootstrap local env
│       └── migrate.sh                # run migrations
├── docs/
│   └── adr/                          # Architecture Decision Records
├── compose.yaml                      # symlink → infra/docker/compose.yaml
├── turbo.json
├── pnpm-workspace.yaml
├── lefthook.yml
├── biome.json                        # extends packages/biome/biome.json
├── package.json                      # root scripts + lefthook + commitlint
└── .gitignore
```

### Root Scripts

```json
{
  "scripts": {
    "dev": "docker compose up -d && turbo run dev",
    "infra:up": "docker compose up -d",
    "infra:down": "docker compose down",
    "setup": "pnpm install && pnpm infra:up && pnpm db:migrate && pnpm db:seed"
  }
}
```

### Architectural Boundaries

**Layer boundaries (enforced by Biome `noRestrictedImports`):**
```
routes/        → imports from bootstrap (context.app) only
use-cases/     → imports from domain + lib (via injected deps)
domain/        → imports from domain/core only — no lib, no framework
lib/db/repos/  → imports from drizzle + domain interfaces
lib/email/     → imports from errore only
bootstrap/     → imports everything, wires it together
config/        → imports from zod only
```

**Package boundaries:**
```
apps/web        → can import packages/*
packages/ui     → no imports from apps/
packages/test-utils → no imports from apps/ — test helpers only
```

### Integration Points

**Data flow:**
```
Request → RR7 route → context.app.useCase(input)
        → use-case → domain service → repository interface
        → lib/db/repos → Drizzle → Postgres
        → Response flows back up, errors matched at route layer
```

**External integrations:**
- Sendgrid: `lib/email/sendgrid.ts` — single integration point
- Sentry: OTel SDK — instrumented at bootstrap
- Uncloud: `infra/uncloud/compose.yaml` + `uc deploy`

### Development Workflow

```
pnpm setup          # first time — install + infra + migrate + seed
pnpm dev            # daily — infra up + all apps in watch mode
docker compose up   # alternative — infra only via root symlink
pnpm test           # all tests affected
pnpm build          # production build via turbo
```

---

## Architecture Validation Results

### Coherence Validation ✅

**Decision Compatibility:**
All technology choices are compatible with clear non-overlapping concerns. RR7 → primary server rendering; Hono → webhooks and external HTTP endpoints; errore + tryAsync() + matchError() form a coherent chain from repository to route. Drizzle + Postgres + Lucia + Temporal form a well-integrated stack with no version conflicts.

**Pattern Consistency:**
`errore` typed errors, repository interfaces, `createApp(env)` composition root, `makeX(deps)` use case factory, and `tryAsync()` at boundary applied consistently across all layers. `ReturnType<typeof createApp>` is the single source of truth for the `App` type — no manual interface maintenance.

**Structure Alignment:**
`lib/` tree corrected — `email/`, `flags/`, `temporal.ts` nest inside `lib/` as referenced throughout this document. All architectural decisions have corresponding structural homes.

### Requirements Coverage Validation ✅

**Functional Requirements Coverage:**

| Requirement | Status | Path |
|---|---|---|
| TypeScript monorepo | ✅ | pnpm workspaces + Turborepo |
| Full-stack SSR | ✅ | RR7 loaders/actions |
| Auth | ✅ | Lucia assumption documented |
| Webhooks | ✅ | Hono |
| i18n | ✅ | domain-first, extract when needed |
| Infrastructure | ✅ | docker-compose + Uncloud + Kamal |
| Background jobs | Deferred | pg-boss/graphile-worker when first job needed |
| Payments (Stripe) | Deferred | No architecture needed until Stripe story |
| Realtime (SSE) | Deferred | RR7 supports SSE natively via Response streaming — design when needed |
| External API consumers | Deferred | Evaluate tRPC vs Hono+OpenAPI vs ElysiaJS when the need exists |

**Non-Functional Requirements Coverage:**
- Portability: `getLoadContext` + `createApp(env)` wired day 1 — Cloudflare Workers migration path clear
- Testability: Testcontainers + transaction rollback + stub EmailService — full isolation, no mocking shortcuts
- Maintainability: Biome `noRestrictedImports` + domain isolation enforced by CI
- Security: `process.env` banned outside config boundary, type-safe env validation at startup
- DX: `pnpm setup` → single command from zero to running

### Implementation Readiness Validation ✅

**Decision Completeness:** All critical decisions documented with rationale. Previously open "tRPC or Hono RPC" resolved: tRPC removed from current scope — RR7 for app, Hono for webhooks, external consumers deferred. ElysiaJS added as candidate for evaluation alongside tRPC and Hono+OpenAPI.

**Structure Completeness:** Complete directory tree with every file named. `lib/` nesting corrected. All boundaries explicit.

**Pattern Completeness:** All patterns include code examples including the concrete `context.app` / `App` type shape. Anti-patterns enumerated with the DB mock anti-pattern added.

### Gap Analysis Results

**Resolved during validation:**
- `lib/` tree inconsistency → corrected, `lib/email/`, `lib/flags/`, `lib/temporal.ts` authoritative
- tRPC vs Hono RPC ambiguity → resolved (tRPC out of current scope)
- `context.app` type → `ReturnType<typeof createApp>` + RR7 module augmentation documented
- Injectable clock for Temporal → `vi.mock` sufficient, not required as a pattern
- Playwright gate → main push only, gates deploy before production
- Scaling triggers → defined per deferred item

**Deferred (documented with paths):**
- Stripe, SSE, external API consumers, caching, jobs, rate limiting — all have explicit "when to un-defer" signals

### Architecture Completeness Checklist

**✅ Requirements Analysis**
- [x] Project context thoroughly analyzed
- [x] Scale and complexity assessed
- [x] Technical constraints identified
- [x] Cross-cutting concerns mapped

**✅ Architectural Decisions**
- [x] Critical decisions documented with versions
- [x] Technology stack fully specified
- [x] Integration patterns defined
- [x] Performance and portability considerations addressed

**✅ Implementation Patterns**
- [x] Naming conventions established (DB, files, code)
- [x] Structure patterns defined with code examples
- [x] `context.app` type and route consumption pattern documented
- [x] Process patterns documented (error handling, import rules, anti-patterns)

**✅ Project Structure**
- [x] Complete directory structure defined
- [x] Component boundaries established and enforced
- [x] Integration points mapped
- [x] Development workflow documented

### Architecture Readiness Assessment

**Overall Status:** READY FOR IMPLEMENTATION

**Confidence Level:** High — all critical decisions made, patterns enforced by tooling, deferred decisions have explicit triggers.

**Key Strengths:**
- `ReturnType<typeof createApp>` — type always accurate, zero drift
- Domain isolation enforced by static analysis — not convention-dependent
- Testcontainers + transaction rollback — no DB state leakage between tests
- Errore typed errors prevent silent failures at all layer boundaries
- Trunk-based + feature flags — continuous merging without coordination overhead
- Playwright gates deploy, not PRs — fast review cycles, safe production deploys

**Areas for Future Enhancement:**
- Caching (p95 trigger defined)
- Jobs queue (first async use case trigger defined)
- Rate limiting (first public endpoint trigger defined)
- External API consumers (tRPC vs Hono+OpenAPI vs ElysiaJS evaluated when needed)
- Grafana observability backend (TBD when OTel pipeline is live)

### Implementation Handoff

**AI Agent Rules:**
- `context.app` in routes — never import use-cases, domain, or bootstrap directly
- `tryAsync()` at repository boundary, `matchError()` at route layer
- Never `throw`, never `new Date()`, never `process.env` outside `config/env.ts`
- Never `vi.mock` the database in `.test.ts` — use `withTestDb` + transaction rollback
- Playwright tests: main push pipeline only, add new tests only for new critical flows

**First Implementation Priority:**
```bash
pnpm create turbo@latest starter --package-manager pnpm
```
Foundation Stories in sequence:
1. Biome + Vitest + Lefthook + `turbo.json` pipeline
2. `createApp(env)` + `getLoadContext` + typed `Env` + `App` type
3. Drizzle + Postgres + `packages/test-utils` (Testcontainers + `withTestDb` + stubs)
4. Lucia + `SessionRepository` + `OtpRepository` + stub `EmailService`
5. First feature domain module + use case + route
