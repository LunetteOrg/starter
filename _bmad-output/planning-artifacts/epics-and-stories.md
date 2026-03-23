---
status: 'draft'
createdAt: '2026-03-23'
project_name: 'starter'
user_name: 'Ilmeskio'
sourceDocument: 'architecture.md'
---

# Epics & Stories — Starter Template

_Backlog fondazionale per il template starter Lunette. Ogni progetto clonato da questo repo parte con queste epic già implementate._

> **Nota:** Epic 3 (API Layer — Hono/ElysiaJS) è **deferred** — verrà creata quando il primo endpoint esterno sarà necessario.

---

## Epic 0 — Monorepo Foundation

**Goal:** Da zero a `pnpm dev` funzionante con tooling completo.

### Story 0.1 — Scaffold Turbo monorepo

**As a** developer cloning the starter
**I want** a working monorepo with pnpm workspaces
**So that** I can immediately start developing

**Acceptance Criteria:**
- [ ] `pnpm create turbo@latest` scaffold con pnpm
- [ ] `pnpm-workspace.yaml` con `apps/*` e `packages/*`
- [ ] `turbo.json` con pipeline completa (lint, typecheck, test, build, dev, db:migrate, db:generate, test:e2e)
- [ ] `test` non dipende da `build` (Vitest su sorgenti TS via Vite)
- [ ] `test:e2e` dipende da `build` (Playwright su bundle di produzione)
- [ ] Root `package.json` con `engines: { node: ">=24.0.0" }` + `.nvmrc` con `24`
- [ ] pnpm come package manager

### Story 0.2 — Biome + Lefthook + Commitlint

**As a** developer
**I want** linting, formatting e commit conventions automatizzati
**So that** il codice è consistente senza effort manuale

**Acceptance Criteria:**
- [ ] `biome.json` root che estende `packages/biome/biome.json`
- [ ] `packages/biome/biome.json` con regole condivise baseline
- [ ] Biome `noRestrictedImports` Strategy B — overrides per layer (`domain/`, `routes/`)
- [ ] `lefthook.yml` con pre-commit: `biome check --filter=...[origin/main]`
- [ ] `commitlint` con conventional commits
- [ ] Lefthook esegue commitlint su commit-msg

### Story 0.3 — TypeScript Configuration

**As a** developer
**I want** TypeScript configurato con massimo rigore
**So that** i bug vengono catturati a compile time

**Acceptance Criteria:**
- [ ] `packages/tsconfig/base.json` con `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `moduleResolution: bundler`
- [ ] `packages/tsconfig/node.json` estende base
- [ ] `packages/tsconfig/browser.json` estende base
- [ ] Ogni app e package referenzia il tsconfig condiviso

### Story 0.4 — Vitest Setup

**As a** developer
**I want** Vitest configurato per unit e integration test
**So that** posso scrivere test dal primo giorno

**Acceptance Criteria:**
- [ ] `vitest.config.ts` in `apps/web` con workspace support
- [ ] Convenzione: `.spec.ts` = unit test, `.test.ts` = integration test
- [ ] Coverage output configurato
- [ ] Turbo task `test` esegue Vitest

### Story 0.5 — Docker Compose per sviluppo locale

**As a** developer
**I want** infrastruttura locale con un comando
**So that** non devo installare Postgres manualmente

**Acceptance Criteria:**
- [ ] `infra/docker/compose.yaml` con servizio Postgres
- [ ] `compose.yaml` in root come symlink a `infra/docker/compose.yaml`
- [ ] Root script `infra:up` e `infra:down`
- [ ] Root script `dev` che esegue `docker compose up -d && turbo run dev`
- [ ] Root script `setup` che esegue `pnpm install && pnpm infra:up && pnpm db:migrate`

### Story 0.6 — DevContainer + GitHub Codespaces

**As a** developer remoto
**I want** aprire il repo in Codespaces e avere un ambiente completo
**So that** nessun setup locale è richiesto

**Acceptance Criteria:**
- [ ] `.devcontainer/devcontainer.json` con image `mcr.microsoft.com/devcontainers/typescript-node:24`
- [ ] Docker-in-Docker feature abilitata (per Testcontainers)
- [ ] GitHub CLI feature
- [ ] `postCreateCommand: pnpm install`
- [ ] `forwardPorts: [3000, 5432]`
- [ ] Estensione Biome per VS Code

### Story 0.7 — CI Pipeline (GitHub Actions)

**As a** developer
**I want** CI che valida ogni PR automaticamente
**So that** i problemi vengono catturati prima del merge

**Acceptance Criteria:**
- [ ] `.github/workflows/ci.yml` — trigger su PR
- [ ] Steps: `pnpm install` → `turbo lint` → `turbo typecheck` → `turbo test`
- [ ] Filter `--filter=...[origin/main]` per eseguire solo pacchetti modificati
- [ ] `apps/proto` escluso da lint/typecheck/test

### Story 0.8 — .gitignore + .env.example

**As a** developer
**I want** file sensibili esclusi e variabili d'ambiente documentate
**So that** non committo secrets e so cosa configurare

**Acceptance Criteria:**
- [ ] `.gitignore` completo (node_modules, dist, build, .env, .react-router, coverage, etc.)
- [ ] `apps/web/.env.example` con tutte le variabili documentate nell'architettura
- [ ] Nessun `.env` reale committato

---

## Epic 1 — Core App Shell

**Goal:** React Router v7 app funzionante con SSR, composition root e typed config.

### Story 1.1 — React Router v7 App con Vite 8

**As a** developer
**I want** un'app RR7 funzionante con SSR
**So that** ho la base su cui costruire le feature

**Acceptance Criteria:**
- [ ] `apps/web` con React Router v7 e Vite 8 (Rolldown)
- [ ] `react-router.config.ts` configurato
- [ ] SSR funzionante — la pagina viene renderizzata server-side
- [ ] Route base `_layout.tsx` e `_index.tsx`
- [ ] `pnpm dev` avvia l'app su `localhost:3000`

### Story 1.2 — Type-safe Config (`env.ts`)

**As a** developer
**I want** variabili d'ambiente validate e tipizzate a startup
**So that** errori di configurazione falliscono subito, non a runtime

**Acceptance Criteria:**
- [ ] `apps/web/app/config/env.ts` con validazione Zod
- [ ] Parse unico di `process.env` — nessun altro file lo legge
- [ ] Export `Env` type derivato dallo schema
- [ ] `parseEnv(process.env)` chiamato una volta in `server.ts`
- [ ] Import di `process.env` bannato altrove (enforced da Biome)

### Story 1.3 — Composition Root (`createApp`)

**As a** developer
**I want** un composition root che assembla tutti i servizi
**So that** dependency injection è centralizzata e testabile

**Acceptance Criteria:**
- [ ] `apps/web/app/bootstrap/index.ts` con `createApp(env: Env)`
- [ ] `App` type derivato da `ReturnType<typeof createApp>` — zero interface manuale
- [ ] Module augmentation di RR7: `AppLoadContext { app: App, env: Env }`
- [ ] `server.ts` con `getLoadContext` che passa `{ app, env }`
- [ ] `getLoadContext` riceve solo `Request` (web standard, no Express)

### Story 1.4 — Graceful Shutdown

**As a** developer deploying to production
**I want** il server che chiude graziosamente le connessioni
**So that** le richieste in-flight non vengono interrotte durante il deploy

**Acceptance Criteria:**
- [ ] SIGTERM handler in `server.ts`
- [ ] `server.close()` smette di accettare nuove connessioni
- [ ] Keep-alive connections distrutte dopo 5s
- [ ] DB pool chiuso dopo `server.close()`
- [ ] Force exit dopo 30s
- [ ] `stop_grace_period: 30s` in `compose.yaml`
- [ ] Healthcheck endpoint `/health`

### Story 1.5 — Error Handling con `errore`

**As a** developer
**I want** un sistema di errori tipizzati consistente
**So that** gli errori sono espliciti e gestiti exhaustivamente

**Acceptance Criteria:**
- [ ] `errore` installato e configurato
- [ ] Esempio di `createTaggedError` in `domain/`
- [ ] Esempio di `tryAsync()` in un repository
- [ ] Esempio di `matchError()` in una route
- [ ] Anti-pattern `throw new Error()` documentato

### Story 1.6 — Temporal API Setup

**As a** developer
**I want** usare Temporal API per date e orari
**So that** non uso mai `new Date()` e ho precisione timezone-aware

**Acceptance Criteria:**
- [ ] `@js-temporal/polyfill` installato
- [ ] `apps/web/app/lib/temporal.ts` come single import point
- [ ] Anti-pattern `new Date()` documentato

---

## Epic 2 — Database Layer

**Goal:** Drizzle + PostgreSQL funzionante con migration, repository pattern e test infrastructure.

### Story 2.1 — Drizzle ORM + Prima Migration

**As a** developer
**I want** Drizzle configurato con la prima migration
**So that** posso definire schema e migrare il database

**Acceptance Criteria:**
- [ ] `drizzle.config.ts` in `apps/web`
- [ ] Drizzle Kit configurato per generare migration
- [ ] `apps/web/app/bootstrap/db.ts` — crea istanza Drizzle
- [ ] Prima migration con tabella `users` (id UUID, email, created_at, updated_at)
- [ ] Script `db:migrate` e `db:generate` funzionanti via Turbo
- [ ] Naming: tabelle `snake_case` plurale, colonne `snake_case`

### Story 2.2 — Repository Pattern

**As a** developer
**I want** repository interfaces nel domain con implementazioni Drizzle
**So that** il domain è isolato dal database

**Acceptance Criteria:**
- [ ] Esempio di interface repository in `domain/` (es. `UserRepository`)
- [ ] Implementazione Drizzle in `lib/db/repos/user.repo.ts`
- [ ] `tryAsync()` wrappa tutte le chiamate Drizzle nel repository
- [ ] Factory `createUserRepository(db)` restituisce l'implementazione
- [ ] Repository wired in `createApp(env)`

### Story 2.3 — Test Utils Package (`@starter/test-utils`)

**As a** developer
**I want** utilities di test condivise per database e fixture
**So that** ogni test ha isolamento completo senza mock del DB

**Acceptance Criteria:**
- [ ] `packages/test-utils` con `package.json` come `@starter/test-utils`
- [ ] `withTestDb` — Testcontainers + transaction rollback per isolamento test
- [ ] Fixture builders per creare dati di test
- [ ] Stub `EmailService` (noop)
- [ ] Stub `AnalyticsService` (noop)
- [ ] Anti-pattern `vi.mock` su database documentato

### Story 2.4 — Architecture Tests

**As a** developer
**I want** test automatici che verificano i boundary architetturali
**So that** le violazioni di import vengono catturate in CI

**Acceptance Criteria:**
- [ ] `packages/test-utils/src/arch.test.ts`
- [ ] Test: domain files non importano `react-router`
- [ ] Test: routes non importano `use-cases` direttamente
- [ ] Test: nessun file fuori da `config/env.ts` importa `process.env`
- [ ] Test passano in CI

---

## Epic 3 — API Layer ⏸️ DEFERRED

> Verrà creata quando il primo endpoint per consumer esterni sarà necessario.
> Candidati da valutare: tRPC vs Hono+OpenAPI vs ElysiaJS.

---

## Epic 4 — Auth

**Goal:** Autenticazione OTP funzionante con session cookie e schema 100% nostro.

### Story 4.1 — Oslo + Session Management

**As a** developer
**I want** session management basato su Oslo con schema nostro
**So that** ho pieno controllo su sessioni e storage

**Acceptance Criteria:**
- [ ] Oslo installato (crypto/session primitives)
- [ ] Schema `sessions` in `lib/db/schema/sessions.ts`
- [ ] `SessionRepository` interface in `domain/auth/`
- [ ] Implementazione Drizzle in `lib/db/repos/session.repo.ts`
- [ ] Cookie-based sessions, stored in Postgres
- [ ] `getSession(request, sessionRepo)` utility
- [ ] Wired in `createApp(env)` come `app.getSession`

### Story 4.2 — OTP Flow

**As a** developer
**I want** un flusso OTP completo per l'autenticazione
**So that** gli utenti possono autenticarsi via email

**Acceptance Criteria:**
- [ ] Schema `otp_codes` in `lib/db/schema/otp-codes.ts`
- [ ] `OtpRepository` interface con `verify` che restituisce `valid | expired | invalid | used`
- [ ] Implementazione Drizzle in `lib/db/repos/otp.repo.ts`
- [ ] Use case `makeRequestOtp({ otpRepo, emailService })`
- [ ] Use case `makeVerifyOtp({ otpRepo, sessionRepo })`
- [ ] Route `auth/login.tsx` e `auth/verify.tsx`
- [ ] Errori tipizzati con `errore`

### Story 4.3 — Email Service

**As a** developer
**I want** un'interfaccia per l'invio email con implementazione Sendgrid
**So that** l'OTP viene inviato via email e il servizio è testabile

**Acceptance Criteria:**
- [ ] `EmailService` interface in `lib/email/`
- [ ] Implementazione Sendgrid in `lib/email/sendgrid.ts`
- [ ] Errori tipizzati in `lib/email/errors.ts` (infrastruttura, non domain)
- [ ] Stub `EmailService` in `@starter/test-utils`
- [ ] `SENDGRID_API_KEY` in `env.ts`
- [ ] Test completo del flusso OTP con stub email

---

## Epic 5 — Cross-cutting Concerns

**Goal:** Feature flags, analytics e GDPR compliance pronti all'uso.

### Story 5.1 — Feature Flags

**As a** developer
**I want** un sistema di feature flags multi-layer
**So that** posso rilasciare feature in modo graduale

**Acceptance Criteria:**
- [ ] `lib/flags/flags.json` con flag di default
- [ ] `lib/flags/types.ts` con `FlagName`, `FlagRepository`, `FlagEvaluator`
- [ ] `createFlags(env, flagRepo)` factory con resolution order: DB → cookie → env → json
- [ ] Preview cookie con HMAC-SHA256 + Temporal per expiry
- [ ] Route `/preview` per settare il cookie da token
- [ ] `scripts/gen-preview-token.ts` per generare link preview
- [ ] Schema `feature_flag_overrides` in DB
- [ ] `forRequest(request)` per cookie-aware flag evaluation
- [ ] `FLAG_PREVIEW_SECRET` in `env.ts`

### Story 5.2 — PostHog Analytics

**As a** developer
**I want** analytics integrati con PostHog
**So that** posso tracciare eventi di business e comportamento utente

**Acceptance Criteria:**
- [ ] `AnalyticsService` interface in `lib/analytics/types.ts`
- [ ] Implementazione PostHog in `lib/analytics/posthog.ts` (PostHog Cloud EU)
- [ ] Noop analytics in `@starter/test-utils`
- [ ] Server-side: `context.app.analytics.capture()` per eventi business
- [ ] Client-side: `posthog-js` inizializzato solo dopo consenso cookie
- [ ] `POSTHOG_API_KEY` e `VITE_POSTHOG_API_KEY` in `env.ts`

### Story 5.3 — Cookie Consent & GDPR

**As a** developer targeting EU users
**I want** cookie consent GDPR-compliant con Google Consent Mode v2
**So that** rispetto il Garante Privacy italiano dal giorno 1

**Acceptance Criteria:**
- [ ] `vanilla-cookieconsent` installato e configurato
- [ ] `lib/consent/config.ts` con categorie: necessary, analytics, monitoring
- [ ] Cookie table con durata e descrizione per ogni cookie
- [ ] `revision` field — incrementato per ogni nuovo vendor
- [ ] Google Consent Mode v2 integrato (`gtag consent update`)
- [ ] `posthog-js` gated da `consent.analytics`
- [ ] Lingua default: italiano
- [ ] Layout: barra in basso

### Story 5.4 — Cookie Audit (Playwright)

**As a** developer
**I want** test automatici che verificano i cookie non dichiarati
**So that** la compliance viene validata ad ogni deploy

**Acceptance Criteria:**
- [ ] `tests/cookie-audit.spec.ts` — nessun tracking cookie senza consenso
- [ ] Test: solo cookie dichiarati dopo consenso
- [ ] Integrato in `deploy.yml`
- [ ] GH Action nightly (predisposto per quando GTM sarà attivo)

---

## Epic 6 — Test Infrastructure

**Goal:** Pipeline di test completa con Playwright per E2E.

### Story 6.1 — Playwright Setup

**As a** developer
**I want** Playwright configurato per E2E test
**So that** posso testare flussi critici sul bundle di produzione

**Acceptance Criteria:**
- [ ] Playwright installato in `apps/web`
- [ ] `playwright.config.ts` con `storageState: { cookies: [], origins: [] }` per isolamento
- [ ] Turbo task `test:e2e` dipende da `build`
- [ ] E2E gira solo in `deploy.yml` (main push), non in `ci.yml` (PR)
- [ ] Ephemeral docker compose per CI

### Story 6.2 — Deploy Pipeline

**As a** developer
**I want** una pipeline di deploy completa
**So that** il codice arriva in produzione in modo sicuro

**Acceptance Criteria:**
- [ ] `.github/workflows/deploy.yml` — trigger su push a main
- [ ] Steps: build → docker compose up (CI) → db:migrate → test:e2e → docker compose down
- [ ] Deploy: migrate container → deploy app (Uncloud commands placeholder)
- [ ] Secrets da GitHub Secrets
- [ ] E2E è il gate — se fallisce, niente deploy

---

## Epic 7 — UI Package

**Goal:** Component library condivisa pronta per le app.

### Story 7.1 — `@starter/ui` Package

**As a** developer
**I want** un package UI condiviso nel monorepo
**So that** componenti sono riutilizzabili tra app

**Acceptance Criteria:**
- [ ] `packages/ui` con `package.json` come `@starter/ui`
- [ ] CSS Modules + Tailwind per styling
- [ ] Almeno un componente base (es. Button) come esempio del pattern
- [ ] Importabile da `apps/web`
- [ ] Build via Turbo pipeline

---

## Epic 8 — Proto App

**Goal:** Ambiente di prototyping per il PO.

### Story 8.1 — `apps/proto` Setup

**As a** PO
**I want** un'app di prototyping che usa i componenti reali
**So that** posso visualizzare flussi senza toccare il codice di produzione

**Acceptance Criteria:**
- [ ] `apps/proto` con React Router v7 minimal setup
- [ ] Importa componenti da `@starter/ui`
- [ ] `biome.json` locale con `noRestrictedImports: off`
- [ ] Escluso da CI lint/typecheck/test (`--filter=!apps/proto`)
- [ ] Incluso in `build` Turbo (rileva breaking changes ai componenti UI)
- [ ] `README.md` con avviso: "PROTOTYPE ONLY — visual reference, never merge"
- [ ] Dati hardcodati, zero API call, zero auth reale

---

## Epic 9 — `create-lunette` CLI

**Goal:** Scaffolding tool per creare nuovi progetti dal template.

### Story 9.1 — CLI Scaffolding Tool

**As a** developer starting a new project
**I want** un comando che genera un nuovo progetto dal template
**So that** parto con tutte le decisioni architetturali già implementate

**Acceptance Criteria:**
- [ ] Comando: `pnpm create lunette` o `npx create-lunette`
- [ ] Chiede il nome del progetto
- [ ] Clona/copia il template
- [ ] Rinomina `@starter/*` → `@{project-name}/*` in tutti i package.json
- [ ] Pulisce git history (fresh `git init`)
- [ ] Rimuove `_bmad/` e `_bmad-output/` (specifici del template)
- [ ] Genera `.env` da `.env.example` con placeholder
- [ ] Esegue `pnpm install`
- [ ] Output: istruzioni per i prossimi passi

### Story 9.2 — Template Cleanup & Documentation

**As a** developer maintaining the starter
**I want** il template pulito e documentato
**So that** `create-lunette` genera progetti utilizzabili

**Acceptance Criteria:**
- [ ] `CLAUDE.md` nel root con tutte le regole architetturali per AI-assisted dev
- [ ] Tutti i placeholder nel codice sono chiaramente marcati per la personalizzazione
- [ ] Template testato: `create-lunette test-project` → `pnpm dev` funziona

---

## Implementation Order

```
Epic 0 (Foundation) → Epic 1 (App Shell) → Epic 2 (Database) → Epic 4 (Auth) → Epic 5 (Cross-cutting) → Epic 6 (Test Infra) → Epic 7 (UI) → Epic 8 (Proto) → Epic 9 (CLI)
```

Ogni epic è implementabile in sequenza. All'interno di ogni epic, le stories sono ordinate per dipendenza.

**Dipendenze cross-epic:**
- Epic 1 richiede Epic 0 completata
- Epic 2 richiede Story 1.3 (createApp)
- Epic 4 richiede Epic 2 (database layer)
- Epic 5 richiede Epic 2 (feature flag overrides) + Epic 1 (composition root)
- Epic 6 richiede Epic 1 (app funzionante)
- Epic 7 è indipendente dopo Epic 0
- Epic 8 richiede Epic 7 (UI package)
- Epic 9 richiede tutte le altre epic completate
