/**
 * Scheduled work shared by the worker process and the /api/cron/tick endpoint.
 * Every step is idempotent, so overlapping or repeated runs are safe.
 */
import { prisma } from "./db";
import { pruneRateLimits } from "./auth/rate-limit";
import { processOutbox } from "./notifications/email";
import { runReminders, syncReminderOutcomes } from "./notifications/reminders";

export async function tick(now = new Date()) {
  const reminders = await runReminders(now);
  const outbox = await processOutbox();
  await syncReminderOutcomes();
  return { reminders, outbox };
}

export async function dailyMaintenance() {
  await pruneRateLimits();
  await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  await prisma.authToken.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 30 * 86_400_000) } } });
}
