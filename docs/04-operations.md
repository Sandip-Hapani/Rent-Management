# Operations: deployment, backups, monitoring, privacy

## 1. Production deployment (Docker Compose, single VPS)

Recommended: a small EU server (e.g. Hetzner CX22 in Falkenstein or Nuremberg) with Docker installed and a DNS A record (e.g. `rent.example.de`) pointing to it.

```bash
git clone <repo> rent && cd rent
cp .env.example .env.production
# edit .env.production:
#   APP_URL=https://rent.example.de
#   DOMAIN=rent.example.de
#   POSTGRES_PASSWORD=<long random>
#   CRON_SECRET=<64 hex chars>
#   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD / EMAIL_FROM  (e.g. Brevo, Postmark, Mailjet, SES)
#   STORAGE_DRIVER=local            (files live in the "files" Docker volume)
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml exec app npm run create-admin -- --email you@example.de --name "Your Name" --apartment "Our flat"
```

Services:

| Service | Role |
|---|---|
| `app` | Next.js server. Applies pending migrations on start (`prisma migrate deploy`). |
| `worker` | Runs reminders and the email outbox every 5 minutes, plus daily housekeeping. |
| `postgres` | Database (volume `pgdata`). |
| `caddy` | HTTPS via Let's Encrypt, HSTS, reverse proxy. |
| `backup` | Nightly `pg_dump` and uploaded-files tarball into volume `backups`, kept 30 days. |

**Updating:** `git pull && docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build`. Migrations run automatically, and they only ever move forward.

**Alternative hosting** (no long-running worker): deploy the app on Vercel or Render, use Neon or Supabase for Postgres and an S3-compatible bucket (`STORAGE_DRIVER=s3`). Then call `POST https://…/api/cron/tick` with `Authorization: Bearer $CRON_SECRET` every 5–15 minutes from any scheduler (cron-job.org, GitHub Actions, a hosting cron). The job is idempotent.

## 2. Backups and restore

Backups are written to the `backups` volume as `db-<timestamp>.dump` + `files-<timestamp>.tar.gz`. **Copy them off the server**: a backup on the same disk doesn't protect against losing the server. One example with restic to a Hetzner Storage Box or S3 bucket, run nightly from the host's crontab:

```bash
restic -r s3:https://<bucket-endpoint>/rent-backups backup /var/lib/docker/volumes/rent_backups/_data
```

**Restore procedure** (practise this once):

```bash
docker compose -f docker-compose.prod.yml stop app worker
# database
docker compose -f docker-compose.prod.yml exec -T postgres sh -c 'dropdb -U $POSTGRES_USER $POSTGRES_DB && createdb -U $POSTGRES_USER $POSTGRES_DB'
docker compose -f docker-compose.prod.yml exec -T postgres pg_restore -U rent -d rent --no-owner < db-YYYYMMDDTHHMMSSZ.dump
# files
docker compose -f docker-compose.prod.yml run --rm -v $PWD:/restore app sh -c 'cd /app/storage && tar -xzf /restore/files-YYYYMMDDTHHMMSSZ.tar.gz'
docker compose -f docker-compose.prod.yml start app worker
```

Then sign in and check that the dashboard totals match the last report you exported.

## 3. Monitoring and error handling

- **Uptime:** monitor `GET /api/health` (returns `{ok:true}` when the database is reachable) with a free service such as UptimeRobot or Better Stack.
- **Logs:** `docker compose -f docker-compose.prod.yml logs -f app worker`. The app logs error ids, never request bodies, passwords, tokens, bank details or file contents.
- **Email delivery:** Apartment Settings → Reminders & email shows every outgoing email (sent / failed / skipped, with the error). Failed sends are retried with backoff up to 5 times.
- **Error tracking (optional):** to add Sentry, wrap `instrumentation.ts` with `@sentry/nextjs`. Configure it to scrub request bodies before enabling it.

## 4. Security checklist

- HTTPS only (Caddy + HSTS). In production, cookies are `__Host-` prefixed, `Secure`, `HttpOnly` and `SameSite=Lax`.
- Passwords are hashed with Argon2id. Sessions are stored only as SHA-256 hashes, and logout, password reset and deactivation revoke them.
- Rate limits apply to sign-in (per IP and per email), password reset, invitation acceptance, uploads and payment creation.
- Every server action and route handler checks the session and scopes queries to the caller's apartment and membership. Other residents' records return "not found".
- Uploads are type-checked by content (magic bytes), size-limited, stored under random keys outside the web root, and downloaded only through `/api/files/:id` after an authorization check. ClamAV scanning is optional (`CLAMAV_HOST`).
- Security headers: CSP, `nosniff`, `Referrer-Policy`, frame restrictions, and no `X-Powered-By`.
- Keep `.env.production` readable only by root (`chmod 600`). Rotate `CRON_SECRET` and SMTP credentials if they leak.

## 5. Privacy and GDPR (design notes, not legal advice)

This app processes residents' personal and financial data. The design supports GDPR principles, but **compliance depends on how you deploy and run it**: hosting contract and DPA, where the data is stored, who has admin access, and so on. Review that before going live.

- **Data minimisation:** only name, email, stay dates, transfer records and uploaded receipts are stored. Bank account numbers are not required. Ask residents to crop IBANs out of screenshots.
- **Access control:** residents see only their own finances. Apartment-wide totals are shown without per-person figures.
- **Data export (Art. 15/20):** each resident can download their full statement (CSV/Excel) from My Account → Statement. The admin can export any resident's statement and the ledger.
- **Retention:** financial records should be kept as long as you may need them for disputes with the landlord or between residents (suggested: 3 years after a resident moves out, the regular German limitation period). Uploaded receipts can be removed earlier. The audit log is append-only.
- **Deletion:** deactivate the account when a resident moves out. To erase personal data after the retention period, run an anonymisation (replace name and email, delete evidence files) rather than deleting ledger rows, so apartment totals stay correct. This is a documented manual SQL step; ask the maintainer.
- **Processors:** your hosting provider, email provider and (if used) object storage provider. Choose EU-hosted options.
