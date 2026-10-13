# Architecture proposal

The repository started empty, so there was no existing stack to keep. The choices below aim for low maintenance: one deployable app, one database and one worker process.

## Stack

| Concern | Choice | Why |
|---|---|---|
| App | **Next.js 16 (App Router) + TypeScript** | One codebase for UI and server. Server Components read data directly and Server Actions handle mutations. |
| UI | **Tailwind CSS v4**, small in-repo component set (`src/components/ui`) | No component-library lock-in, and the bundle stays small. |
| Charts | **Recharts** | Accessible SVG charts and simple React API. |
| DB | **PostgreSQL 16** | Relational integrity, transactions and check constraints. |
| ORM | **Prisma 6** | Mature, typed, with versioned SQL migrations. |
| Auth | **In-house session auth**: Argon2id (`@node-rs/argon2`) + opaque DB-backed session tokens (SHA‑256 hashed at rest) in an `HttpOnly; Secure; SameSite=Lax` cookie | Invite-only email accounts need invitation, verification, reset and deactivation. A small, auditable module covers that more simply than an adapter-based library. |
| Files | `StorageDriver` interface: **local private directory** (dev / single VPS) or **S3-compatible** (MinIO, Hetzner, AWS) | Files are never under `public/`. Downloads go only through an authorised route handler. |
| Email | **Nodemailer (SMTP)**. Dev uses **Mailpit** (docker-compose). Prod uses any SMTP provider (Brevo, Postmark, SES…). | Provider-agnostic. |
| Jobs | **Worker process** (`npm run worker`, node-cron) **plus** an authenticated `POST /api/cron/tick` endpoint for hosts without long-running processes | Doesn't depend on someone keeping a browser open. Every job is idempotent, using unique dedupe keys in the DB. |
| Excel | **ExcelJS** (import + export) | Reads formulas and cached results, and writes .xlsx. |
| Validation | **Zod** at every server boundary | |
| Tests | **Vitest** (unit + DB integration against a real Postgres test DB), **Playwright** (e2e smoke) | |

## Module layout

```
src/
  app/                    Next.js routes (UI + route handlers only — thin)
  server/
    auth/                 passwords, sessions, invitations, reset, rate limit, guards
    authz/                permission checks (requireAdmin, canViewMembership, …)
    finance/
      money.ts            integer-cent helpers, formatting, largest-remainder split
      period.ts           'YYYY-MM' period maths
      rules.ts            charge-rule resolution & obligation generation (pure)
      ledger.ts           balance computation (pure) — single source of truth
      service.ts          DB-backed queries/mutations that use ledger.ts
    payments/             submission, verification, allocation, reversal
    imports/              Excel parsing, normalisation, issue detection, commit
    documents/            library, versions, acknowledgements
    notifications/        in-app notifications, email outbox, reminders, templates
    storage/              local + S3 drivers, file validation, (optional) ClamAV scan
    reports/              report queries + CSV/XLSX writers + statements
    audit/                audit-event writer
  components/             UI components
  worker/                 scheduler entry point
prisma/                   schema + migrations + seed
tests/                    unit, integration, e2e
```

Rules:
- **All money logic lives in `server/finance`.** Dashboards, statements, charts, reminders and exports call the same functions.
- **Every Server Action and route handler** starts with `requireUser()` / `requireAdmin()`, and loads records **scoped to the caller's apartment and membership**. That prevents IDOR.
- Mutations that touch money run in a `prisma.$transaction` and write an `AuditEvent` in the same transaction.

## Security model

- Sessions are random 32-byte tokens, and only their SHA‑256 hash is stored. A session lasts 30 days with sliding renewal. Logout, password change and deactivation revoke all sessions.
- CSRF: Server Actions are POST-only, and Next.js checks their Origin. Custom mutating route handlers check `Origin` against `APP_URL`. The cookie is `SameSite=Lax`.
- Rate limits (DB-backed sliding window) cover login, password reset, invitation acceptance and uploads.
- Uploads: server-side magic-byte sniffing (PDF/PNG/JPEG/WebP), a size limit from settings, a random storage key, and an optional ClamAV scan. Files whose scan is pending or failed can't be downloaded by residents.
- Security headers: CSP, `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors 'none'`.
- Logging is privacy-conscious. Errors log ids, not bodies. No passwords, tokens, IBANs or file contents are logged.

## Deployment target (recommended)

A single small VPS (e.g. Hetzner CX22, EU) running Docker Compose: `app`, `worker`, `postgres`, `caddy` (automatic HTTPS), and nightly `pg_dump` to off-site object storage.
Alternatives: Vercel + Neon + R2 + an external cron hitting `/api/cron/tick`. See `docs/04-operations.md`.

## Phases & dependencies

| Phase | Contents | Depends on |
|---|---|---|
| 1 Foundation | schema, auth, invitations, roles, layout/nav, admin bootstrap | — |
| 2 Financial core | charge rules, obligation generation & review, payments + evidence, verification & allocation, reversals/adjustments, balances, Excel import & reconciliation | 1 |
| 3 Dashboards & reports | apartment + personal dashboards, chart, statements, CSV/XLSX exports | 2 |
| 4 Documents & notifications | library + versions + acknowledgements, price-change workflow, in-app notifications, email outbox, reminder scheduler | 1, 2 |
| 5 Production readiness | authz/finance test suites, e2e, Docker/Caddy, backups, monitoring hooks, docs | all |
