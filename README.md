# Rent-Management

Sharing an apartment with people can make rent management confusing. Keeping track of who has paid each month's rent, who still owes money, and who needs an extra time to pay can be overwhelming. This platform is an all-in-one rent management solution built for friends. It covers payment records, rent reminders and apartment contracts.

A private web app for a shared apartment. It tracks rent, electricity, deposits and shared costs per resident. It also handles payment verification, reminders and the contract/document library. It replaces the Google Form, the shared spreadsheet and documents sent over WhatsApp.

> The app **records** transfers that residents make from their own bank. It never moves money.

| | |
|---|---|
| Stack | Next.js 16 (App Router, TypeScript) · Tailwind CSS 4 · PostgreSQL 16 · Prisma 6 · Recharts · Nodemailer · node-cron |
| Docs | [Data analysis & open questions](docs/01-data-analysis.md) · [Architecture](docs/02-architecture.md) · [Financial spec](docs/03-financial-spec.md) · [Operations](docs/04-operations.md) · [Administrator guide](docs/05-admin-guide.md) · **[Deployment guide (free tier)](docs/06-deployment-guide.md)** |

## Quick start (development)

Requirements: Node 22+, Docker.

```bash
npm install
cp .env.example .env              # defaults work with docker-compose
docker compose up -d              # Postgres on :5433 (+ rent_test DB), Mailpit on :1025 / UI :8025
npx prisma migrate deploy
npm run db:seed                   # optional demo data — see below
npm run dev                       # http://localhost:3000
npm run worker                    # second terminal: reminders + email outbox
```

**Demo data:** `npm run db:seed` creates five fictional residents (`alex@demo.test` is the admin; `bea@`, `chris@`, `dana@`, `eli@demo.test` are residents). The shared development password is `DEMO_PASSWORD` in [prisma/demo.ts](prisma/demo.ts). Use `npm run db:seed -- --reset` to wipe and recreate the data. Seeding refuses to run when `NODE_ENV=production`.

All outgoing email in development is captured by Mailpit at http://localhost:8025.

## First administrator (real use)

No account is created automatically. On a fresh database:

```bash
npm run create-admin -- --email you@example.com --name "Your Name" --display You --apartment "Our flat, Chemnitz" --move-in 2024-06-01
```

This prints a one-time invitation link (valid 72 hours) and also emails it if SMTP is configured. Open the link, choose a password, and invite the other residents under **Apartment Settings → Residents**. Passwords never appear on the command line or in logs.

## Environment variables

See [.env.example](.env.example). The important ones:

| Variable | Purpose |
|---|---|
| `APP_URL` | Public base URL. Used in email links. |
| `DATABASE_URL` | PostgreSQL connection string. |
| `TEST_DATABASE_URL` | A **separate** database used only by the integration tests. It is truncated on every run. |
| `CRON_SECRET` | Bearer secret for `POST /api/cron/tick` (≥ 32 characters). Only needed when an external scheduler is used. |
| `SMTP_*`, `EMAIL_FROM` | Transactional email (any SMTP provider). |
| `STORAGE_DRIVER` | `local` (private directory `STORAGE_LOCAL_DIR`) or `s3` (`S3_*` for any S3-compatible bucket). |
| `CLAMAV_HOST`/`PORT` | Optional clamd for malware scanning of uploads. |
| `WORKER_ENABLED` | Set to `false` to disable the worker's own scheduler. |

## Tests

```bash
npm test                    # unit + integration (needs docker compose up; uses TEST_DATABASE_URL)
npm run test:unit           # pure finance + import-parser tests, no database
npm run test:integration    # services against a real Postgres: finance flows, authorization, notifications, import
npm run db:seed -- --reset && PW_CHANNEL=msedge npm run test:e2e   # browser smoke tests (or `npx playwright install chromium` once)
npm run typecheck
```

What they cover: the full financial rule set (§3 of the spec), every authorization rule in the requirements, reminder targeting/de-duplication, price-change and document notifications, and the historical import (duplicates, aliases, re-import guard). Fixtures use five residents and several months.

## Project layout

```
prisma/            schema, migrations, demo seed
src/server/        all business logic (framework-independent, tested)
  finance/         money, periods, rules, ledger (single source of truth), admin mutations
  payments/        submission → verification → allocation → reversal
  auth/            sessions, invitations, password reset, rate limiting
  documents/ notifications/ imports/ reports/ storage/
src/app/           Next.js pages, server actions (thin), route handlers
src/worker/        background scheduler
tests/             unit, integration, e2e
docs/              design, operations, admin guide
```

## Deployment

- **Free hosting (Vercel + Neon + Gmail/Brevo SMTP):** follow [docs/06-deployment-guide.md](docs/06-deployment-guide.md). It covers every secret to set, how the default administrator is created on first deploy, and how to invite residents. It also has notes for Render, Netlify and moving hosts.
- **Own server:** Docker Compose with Caddy HTTPS and nightly backups, in [docs/04-operations.md](docs/04-operations.md).

## License

MIT, see [LICENSE](LICENSE).
