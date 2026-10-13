/**
 * Background worker: `npm run worker`. Runs independently of any browser session.
 *  - every 5 minutes: reminders + email outbox
 *  - daily 03:30: housekeeping
 */
import "dotenv/config";
import cron from "node-cron";
import { dailyMaintenance, tick } from "../server/jobs";
import { prisma } from "../server/db";

let running = false;

async function safeTick() {
  if (running) return; // never overlap within one process (DB keys also prevent duplicates across processes)
  running = true;
  try {
    const r = await tick();
    if (r.reminders.queued || r.outbox.sent || r.outbox.failed) {
      console.log(`[worker] reminders queued=${r.reminders.queued} skipped=${r.reminders.skipped}; emails sent=${r.outbox.sent} failed=${r.outbox.failed}`);
    }
  } catch (e) {
    console.error("[worker] tick failed:", e instanceof Error ? e.message : e);
  } finally {
    running = false;
  }
}

if (process.env.WORKER_ENABLED === "false") {
  console.log("[worker] WORKER_ENABLED=false — exiting");
  process.exit(0);
}

const tz = process.env.APP_TIMEZONE || "Europe/Berlin";
cron.schedule("*/5 * * * *", safeTick, { timezone: tz });
cron.schedule("30 3 * * *", () => dailyMaintenance().catch((e) => console.error("[worker] maintenance failed:", e)), { timezone: tz });
console.log(`[worker] started (timezone ${tz})`);
void safeTick();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}
