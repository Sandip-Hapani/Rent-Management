# Deployment guide (free tier)

This guide takes the app from the GitHub repository to a live HTTPS site for **€0/month**. Follow Part A once; Parts B–E are reference for later, including moving to another host.

**Recommended free stack**

| Piece | Service (free plan) | Why |
|---|---|---|
| App + daily scheduler | **Vercel** (Hobby) | Built for Next.js, automatic HTTPS and deploys on every push. It has a built-in daily cron job. |
| Database + uploaded files | **Neon** (Free) | Serverless Postgres in Frankfurt, 0.5 GB. Receipts and contracts are stored in the database too (`STORAGE_DRIVER=db`), so no extra file service is needed. |
| Email | **Gmail app password** or **Brevo** (300/day) | Plain SMTP, no domain needed. |

Free-tier limits to know about:

- **Uploads ≤ 4 MB per file.** Vercel caps request size at 4.5 MB; the app sets this limit automatically.
- **Reminders run once a day.** Vercel Hobby cron runs daily, around 09:00–10:00 Berlin time.
- **First page load after idle time takes ~1 s longer.** Neon sleeps after 5 minutes without queries.
- **Vercel Hobby is for personal, non-commercial use.** A private flat app fits that.
- **Storage.** 0.5 GB of database is plenty: a flat's receipts take a few MB per month.

Invitations, password resets and payment notifications are emailed **immediately** after the action. Only the scheduled rent reminders depend on the daily cron.

---

## Part A: Step by step (Vercel + Neon)

Time needed: about 30 minutes. You need a GitHub account with access to the repository, a Google account (for Gmail SMTP) and a browser.

### Step 1: Create the database (Neon)

1. Sign up at **https://neon.tech** (you can sign in with GitHub).
2. **Create project**: name `rent-management`, Postgres version 16 or newer, region **AWS Europe Central 1 (Frankfurt)**.
3. On the project dashboard, click **Connect**. You need **two** connection strings:
   - **Pooled connection**: the toggle "Connection pooling" is **on**, and the host contains `-pooler`. Add `&pgbouncer=true&connect_timeout=15` to the end. This becomes `DATABASE_URL`:
     ```
     postgresql://neondb_owner:XXXX@ep-cool-name-123456-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require&pgbouncer=true&connect_timeout=15
     ```
   - **Direct connection**: the pooling toggle is **off**, and there's no `-pooler` in the host. This becomes `DIRECT_URL`:
     ```
     postgresql://neondb_owner:XXXX@ep-cool-name-123456.eu-central-1.aws.neon.tech/neondb?sslmode=require
     ```
4. Keep both strings somewhere safe for Step 4. You don't need to create any tables: the deployment does that.

### Step 2: Set up email sending

**Option 1: Gmail (quickest).**
1. Your Google account needs **2-Step Verification** turned on: https://myaccount.google.com/security
2. Open **https://myaccount.google.com/apppasswords**, create an app password named `Rent app`, and copy the 16-character password (no spaces).
3. You'll use these values:
   `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_SECURE=true`, `SMTP_USER=<your gmail address>`, `SMTP_PASSWORD=<app password>`, `EMAIL_FROM=Apartment Rent <your gmail address>`

**Option 2: Brevo** (separate sender, 300 emails/day).
1. Sign up at https://www.brevo.com. Go to **Senders, domains & dedicated IPs → Senders** and add and verify your sender email.
2. Go to **SMTP & API → SMTP**, generate an SMTP key, and note the SMTP login.
3. Values: `SMTP_HOST=smtp-relay.brevo.com`, `SMTP_PORT=587`, `SMTP_SECURE=false`, `SMTP_USER=<SMTP login>`, `SMTP_PASSWORD=<SMTP key>`, `EMAIL_FROM=Apartment Rent <verified sender email>`

### Step 3: Generate the cron secret

Any random string of at least 32 characters. For example, in a terminal:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

(or `openssl rand -hex 32`). Copy the result. This is `CRON_SECRET`.

### Step 4: Deploy on Vercel

1. Sign up at **https://vercel.com** with GitHub.
2. **Add New… → Project → Import** the `Rent-Management` repository. (If it isn't listed, use "Adjust GitHub App Permissions" to give Vercel access to it.)
3. Vercel detects **Next.js**. Leave the build and install commands at their defaults: the repository has a `vercel-build` script that applies database migrations, creates the default admin and builds the app.
4. Open **Environment Variables** and add the following. The full list is in [Part B](#part-b-secrets-and-settings-reference).

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | pooled Neon string from Step 1 |
   | `DIRECT_URL` | direct Neon string from Step 1 |
   | `CRON_SECRET` | value from Step 3 |
   | `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASSWORD` / `EMAIL_FROM` | from Step 2 |
   | `INITIAL_ADMIN_EMAIL` | your email (the default administrator's login) |
   | `INITIAL_ADMIN_NAME` | your full name, e.g. `Sandip H.` |
   | `INITIAL_ADMIN_PASSWORD` | a temporary password, **at least 10 characters** |
   | `INITIAL_APARTMENT_NAME` | e.g. `Our flat, Chemnitz` |

5. Click **Deploy**. The build log should show:
   ```
   All migrations have been successfully applied.
   [bootstrap] Default administrator you@example.com created (with a new apartment).
   ```
6. When it finishes, open the URL Vercel shows (e.g. `https://rent-management-xyz.vercel.app`).

### Step 5: Two settings right after the first deploy

1. **Function region near the database:** Vercel → Project → **Settings → Functions → Function Region**, choose **Frankfurt (fra1)**. Then use **Deployments → ⋯ → Redeploy**. This makes every page noticeably faster, because the default region is in the US.
2. **Your public URL** (only if you add a custom domain): set `APP_URL=https://your-domain` in the environment variables and redeploy. Without a custom domain the app uses Vercel's production URL automatically for links in emails.

### Step 6: First sign-in as the default administrator

1. Open the site and sign in with `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD`.
2. Go to **your name (bottom left) → Profile & security → Change password** and choose your real password.
   - The deployment never changes an existing account. Your new password stays even though `INITIAL_ADMIN_PASSWORD` is still set.
   - Optionally delete `INITIAL_ADMIN_PASSWORD` from Vercel afterwards. Nothing breaks.
3. Go to **Apartment Settings → General** and check the rent due day (default 1), the grace days (default 3) and the upload size (4 MB on Vercel).

### Step 7: Add the other residents (invitation process)

1. Go to **Apartment Settings → Residents → Invite a resident** and enter:
   - full name and a short display name;
   - email;
   - move-in date (and optionally the first billed month);
   - role: **Resident**, or **Administrator** for a co-admin.
2. The resident receives an email: "You're invited to …". The link is valid for **72 hours**.
3. They open the link and choose a password. Their account is active and their email is verified at the same time.
4. If the email doesn't arrive (spam folder?), open the resident in **Residents** and click **Resend invitation**.
5. People who forget their password use **Forgot your password?** on the sign-in page.
6. When someone moves out: Residents → resident → set the **move-out date** (billing stops automatically). Later, **Deactivate account** if they should no longer sign in. Their history is kept either way.

There is no public sign-up page: only administrators can create accounts.

### Step 8: Configure the money side

Follow [docs/05-admin-guide.md](05-admin-guide.md):

1. **Prices & rules:** rent (e.g. equal split of the total) and electricity.
2. **Monthly obligations:** generate the current month, review it, then **Finalise**.
3. **Reminders & email:** check the schedule. Use **Run reminder job** once to test.
4. Optionally, **Historical import** of the old spreadsheet.

### Step 9: Verify everything works

| Check | How |
|---|---|
| App is up | Open `https://<your-app>/api/health`, which should show `{"ok":true}` |
| Email works | Invite yourself on a second address, or use "Forgot your password?" |
| Scheduler works | Vercel → Project → **Settings → Cron Jobs → Run** next to `/api/cron/tick`, then check Apartment Settings → Reminders & email → Email log |
| Uploads work | Record a payment with a small screenshot and open it again |

From now on, **every push to `main` redeploys automatically**, and new database migrations are applied during the build.

---

## Part B: Secrets and settings reference

| Variable | Required | Example / how to get it | Notes |
|---|---|---|---|
| `DATABASE_URL` | **yes** | Neon pooled string + `&pgbouncer=true&connect_timeout=15` | Used by the running app |
| `DIRECT_URL` | **yes** | Neon direct string | Used for migrations during the build |
| `CRON_SECRET` | **yes** | 64 random hex characters | Protects `/api/cron/tick`. Vercel Cron sends it automatically. |
| `SMTP_HOST` | **yes** | `smtp.gmail.com` | Without SMTP, no emails are sent; the email log shows "SMTP is not configured" |
| `SMTP_PORT` | **yes** | `465` (Gmail) / `587` (Brevo) | |
| `SMTP_SECURE` | **yes** | `true` for 465, `false` for 587 | |
| `SMTP_USER` | **yes** | Gmail address / Brevo SMTP login | |
| `SMTP_PASSWORD` | **yes** | Gmail app password / Brevo SMTP key | Secret |
| `EMAIL_FROM` | **yes** | `Apartment Rent <you@gmail.com>` | Must be the Gmail address or a verified Brevo sender |
| `INITIAL_ADMIN_EMAIL` | first deploy | `you@example.com` | Default admin login |
| `INITIAL_ADMIN_NAME` | first deploy | `Your Name` | |
| `INITIAL_ADMIN_PASSWORD` | first deploy | ≥ 10 characters | Secret. Change it after first sign-in. Safe to delete later. |
| `INITIAL_APARTMENT_NAME` | optional | `Our flat, Chemnitz` | Default: "Our apartment" |
| `INITIAL_ADMIN_MOVE_IN` | optional | `2024-06-01` | Your move-in date. Default: deployment day. |
| `APP_URL` | optional | `https://rent.example.com` | Auto-detected on Vercel, Render and Netlify. Set it when you use a custom domain. |
| `STORAGE_DRIVER` | optional | `db` | Default `db` on Vercel/Netlify/Render. `s3` for an external bucket (see Part D). |
| `APP_TIMEZONE` | optional | `Europe/Berlin` | |

Mark the secret ones as **Sensitive** in Vercel. Never commit real values: `.env` is git-ignored, and only `.env.example` (with no values) is in the repository.

---

## Part C: How the default administrator works

- The build command `npm run build:deploy` runs `prisma migrate deploy` and then `scripts/bootstrap.ts`.
- `bootstrap.ts` creates the **apartment** (if none exists) and an **active administrator** from `INITIAL_ADMIN_*`, but **only if there is no administrator yet**.
- On every later deploy it prints `[bootstrap] Skipped: an administrator already exists.` and changes nothing. It never resets passwords and never creates duplicates.
- It refuses weak passwords (shorter than 10 characters, or containing your name), which fails the build with a clear message. Fix the variable and redeploy.
- **Locked out?** Use "Forgot your password?" (needs working SMTP). If email isn't working, create a second admin from a computer with the repository:
  ```bash
  DATABASE_URL="<DIRECT_URL value>" DIRECT_URL="<DIRECT_URL value>" APP_URL="https://<your-app>" npm run create-admin -- --email other@example.com --name "Other Admin"
  ```
  It prints a one-time invitation link.

---

## Part D: Other hosts

The app is a standard Node.js server. Any host works if it provides the following:

| Requirement | Value |
|---|---|
| Node.js | 22 or newer (`engines` in package.json) |
| Install command | `npm install --include=dev` (dev tools are needed for the build) |
| Build command | `npm run build:deploy` |
| Start command | `npm start` |
| Database | PostgreSQL 14+ (`DATABASE_URL` + `DIRECT_URL`; the same value if there's no pooler) |
| Environment | the variables from Part B |
| Scheduler | something that calls `POST /api/cron/tick` with `Authorization: Bearer $CRON_SECRET`, ideally hourly (at least daily) |
| Files | `STORAGE_DRIVER=db` (simplest), `local` with a persistent disk, or `s3` |

### Render (free web service)

1. https://render.com → **New → Web Service** → connect the GitHub repository.
2. Settings: Runtime **Node**, Region **Frankfurt**, Instance type **Free**.
   - Build command: `npm install --include=dev && npm run build:deploy`
   - Start command: `npm start`
   - Health check path: `/api/health`
3. Environment: everything from Part B, plus `NODE_VERSION=22`. `APP_URL` is detected from `RENDER_EXTERNAL_URL`.
4. **Scheduler:** Render's free plan has no cron. Use the included GitHub Action ([.github/workflows/scheduled-jobs.yml](../.github/workflows/scheduled-jobs.yml)): GitHub repo → **Settings → Secrets and variables → Actions** → add `APP_URL` (your Render URL) and `CRON_SECRET`. It runs hourly and also wakes the sleeping service.
5. Notes:
   - Free instances sleep after 15 minutes idle, so the first request takes 30–60 seconds.
   - With 512 MB RAM the build can occasionally run out of memory. Add `NODE_OPTIONS=--max-old-space-size=450` if that happens.

### Netlify

1. https://app.netlify.com → **Add new site → Import from Git**.
2. Build command `npm run build:deploy`. Netlify's Next.js runtime handles the rest.
3. Environment variables from Part B. `APP_URL` is detected from Netlify's `URL`.
4. Scheduler: the GitHub Action, exactly as for Render.
5. Keep uploads ≤ 4 MB: function request bodies are limited to about 6 MB.

### Own server / VPS (Docker)

See [docs/04-operations.md](04-operations.md): Docker Compose with Postgres, a worker, Caddy HTTPS and nightly backups. This is the most capable setup (always-on worker, larger uploads) and costs about €4/month.

### Using S3-compatible storage instead of the database

Set `STORAGE_DRIVER=s3`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. Keep `S3_FORCE_PATH_STYLE=true` for most non-AWS providers, and set `S3_SSE=true` only if the provider supports server-side encryption headers. Free options include Backblaze B2 (10 GB) and Cloudflare R2 (10 GB, needs a card on file). Files stored in the database are not moved automatically when you switch, so decide before you upload real documents.

---

## Part E: Operating it

**Backups.** Neon's free plan keeps only a short restore window. Take your own copy, for example monthly:

```bash
pg_dump "<DIRECT_URL>" --format=custom --no-owner --file=rent-$(date +%Y-%m).dump
```

With `STORAGE_DRIVER=db` this one file also contains every uploaded receipt and contract. To restore into a new database: `pg_restore --no-owner -d "<new DIRECT_URL>" rent-YYYY-MM.dump`.

**Moving to another host or database:**

1. Back up with `pg_dump` (above).
2. Create the new database and restore into it.
3. Deploy the app on the new host with the same environment variables, pointing at the new database. Migrations apply automatically, and the bootstrap skips because an administrator already exists.
4. Update `APP_URL` and the scheduler (Vercel cron or the GitHub Action secrets).

**Troubleshooting:**

| Symptom | Fix |
|---|---|
| Build fails: `Environment variable not found: DIRECT_URL` | Add `DIRECT_URL` (Part B) |
| Build fails: `INITIAL_ADMIN_PASSWORD is not acceptable` | Use ≥ 10 characters, without your name or email |
| `P1001: Can't reach database server` | Check the Neon strings (`sslmode=require`) and that the Neon project isn't deleted or suspended |
| `Invalid environment configuration` in logs | The message lists the variable. `CRON_SECRET` must be ≥ 32 characters. |
| No emails arrive | Apartment Settings → Reminders & email → **Email log** shows the error. Gmail needs an app password (not your normal password). Check spam. |
| Cron job shows 401 | `CRON_SECRET` differs between Vercel and the caller. Redeploy after changing environment variables. |
| Upload fails "too large" | Free hosts limit request size. Keep files ≤ 4 MB (photos of receipts are usually < 1 MB). |
| Pages slow on first open | Normal after idle time: the Neon database or Render instance is waking up |
