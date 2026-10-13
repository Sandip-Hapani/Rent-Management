/**
 * Automated rent reminders. Run by the worker (hourly) or POST /api/cron/tick.
 *
 * - Each (period, member, day-offset) is a reminder event with a unique dedupe key, so running the
 *   job any number of times never sends a duplicate.
 * - A member gets at most one reminder email per day; overdue months are listed month by month.
 * - Emails only ever contain the recipient's own figures.
 * - Every decision (sent / skipped / failed) is recorded in ReminderRun for the admin history view.
 */
import type { ReminderSchedule } from "@prisma/client";
import { prisma } from "../db";
import { summarizeMember } from "../finance/ledger";
import { currentPeriod, daysBetween, isoDate, todayInZone, zonedDateParts } from "../finance/period";
import { loadLedgerInput } from "../finance/queries";
import { queueEmail } from "./email";
import { absoluteUrl } from "./notify";
import { reminderEmail } from "./templates";

export type ReminderKind = "upcoming" | "due" | "overdue";

/** Is `offset` (days from due date; negative = before) a reminder day under this schedule? */
export function reminderKindForOffset(s: Pick<ReminderSchedule, "daysBeforeDue" | "onDueDate" | "daysAfterDue" | "repeatEveryDays">, offset: number): ReminderKind | null {
  if (offset < 0) return s.daysBeforeDue.includes(-offset) ? "upcoming" : null;
  if (offset === 0) return s.onDueDate ? "due" : null;
  if (s.daysAfterDue.includes(offset)) return "overdue";
  const lastFollowUp = Math.max(0, ...s.daysAfterDue);
  if (s.repeatEveryDays && s.repeatEveryDays > 0 && offset > lastFollowUp && (offset - lastFollowUp) % s.repeatEveryDays === 0) return "overdue";
  return null;
}

export interface ReminderStats {
  evaluated: number;
  queued: number;
  skipped: number;
  duplicates: number;
}

export async function runReminders(now = new Date()): Promise<ReminderStats> {
  const stats: ReminderStats = { evaluated: 0, queued: 0, skipped: 0, duplicates: 0 };
  const schedules = await prisma.reminderSchedule.findMany({ where: { enabled: true }, include: { apartment: true } });
  for (const schedule of schedules) {
    const tz = schedule.apartment.timezone;
    if (zonedDateParts(now, tz).hour < schedule.sendHourLocal) continue;
    await runForApartment(schedule, now, stats);
  }
  return stats;
}

async function runForApartment(schedule: ReminderSchedule & { apartment: { id: string; timezone: string; graceDays: number } }, now: Date, stats: ReminderStats) {
  const apartmentId = schedule.apartment.id;
  const today = todayInZone(schedule.apartment.timezone, now);
  const asOf = currentPeriod(schedule.apartment.timezone, now);
  const maxBefore = Math.max(0, ...schedule.daysBeforeDue);
  const periods = await prisma.financialPeriod.findMany({
    where: { apartmentId, status: "FINALIZED", dueDate: { lte: new Date(today.getTime() + maxBefore * 86_400_000), gte: new Date(today.getTime() - 400 * 86_400_000) } },
    orderBy: { dueDate: "asc" },
  });
  if (periods.length === 0) return;

  const members = await prisma.membership.findMany({ where: { apartmentId }, include: { user: true } });
  const ledger = await loadLedgerInput(prisma, apartmentId);

  for (const member of members) {
    const summary = summarizeMember(ledger, member.id, { asOf, today, graceDays: schedule.apartment.graceDays });
    const triggered: { periodId: string; period: string; offset: number; kind: ReminderKind; dueDate: Date }[] = [];

    for (const fp of periods) {
      const offset = daysBetween(fp.dueDate, today);
      const kind = reminderKindForOffset(schedule, offset);
      if (!kind) continue;
      const month = summary.months.find((m) => m.period === fp.period);
      if (!month || month.due <= 0) continue; // member has no obligation this month
      stats.evaluated++;
      const dedupeKey = `reminder:${fp.id}:${member.id}:${offset}`;
      if (await prisma.reminderRun.findUnique({ where: { dedupeKey } })) {
        stats.duplicates++;
        continue;
      }
      const skip = async (reason: string) => {
        await prisma.reminderRun.create({ data: { dedupeKey, periodId: fp.id, membershipId: member.id, offsetDays: offset, outcome: "SKIPPED", reason, amountDueCents: month.outstanding } }).catch(() => undefined);
        stats.skipped++;
      };
      if (member.user.status !== "ACTIVE") { await skip("Account not active"); continue; }
      if (month.outstanding <= 0 && (kind === "overdue" ? schedule.stopWhenVerified : schedule.excludeFullyPaid)) { await skip("Fully paid (verified)"); continue; }
      const sentBefore = await prisma.reminderRun.count({ where: { periodId: fp.id, membershipId: member.id, outcome: { in: ["SENT", "QUEUED"] } } });
      if (sentBefore >= schedule.maxReminders) { await skip("Maximum number of reminders reached"); continue; }
      triggered.push({ periodId: fp.id, period: fp.period, offset, kind, dueDate: fp.dueDate });
    }
    if (triggered.length === 0) continue;

    // One email per member per day, focused on the most recent triggered month.
    const focus = triggered[triggered.length - 1]!;
    const focusMonth = summary.months.find((m) => m.period === focus.period)!;
    const overdueMonths = summary.months.filter((m) => m.period < focus.period && m.outstanding > 0);
    const totalOutstanding = summary.months.filter((m) => m.period <= (focus.period > asOf ? focus.period : asOf)).reduce((a, m) => a + Math.max(0, m.outstanding), 0);
    const kind: ReminderKind = overdueMonths.length > 0 || focus.kind === "overdue" ? "overdue" : focus.kind;
    const content = reminderEmail({
      name: member.user.name,
      period: focus.period,
      dueDate: focus.dueDate,
      kind,
      current: focusMonth,
      overdueMonths,
      totalOutstanding,
      pendingCents: schedule.mentionPending ? summary.pendingSubmissionCents : null,
      url: absoluteUrl("/account"),
    });
    const delivery = await queueEmail(prisma, {
      apartmentId, userId: member.userId, toEmail: member.user.email, kind: "REMINDER", content,
      dedupeKey: `reminder-email:${member.id}:${isoDate(today)}`, preferenceType: kind === "overdue" ? "RENT_OVERDUE" : "RENT_DUE_SOON",
    });
    // In-app copy so residents who miss the email still see it.
    await prisma.notification.upsert({
      where: { dedupeKey: `inapp:reminder:${member.id}:${isoDate(today)}` },
      create: { userId: member.userId, type: kind === "overdue" ? "RENT_OVERDUE" : "RENT_DUE_SOON", title: content.subject, body: `Outstanding: ${(totalOutstanding / 100).toFixed(2)} €`, link: "/account", dedupeKey: `inapp:reminder:${member.id}:${isoDate(today)}` },
      update: {},
    });
    for (const t of triggered) {
      await prisma.reminderRun.create({
        data: {
          dedupeKey: `reminder:${t.periodId}:${member.id}:${t.offset}`, periodId: t.periodId, membershipId: member.id, offsetDays: t.offset,
          outcome: delivery.skipped ? "SKIPPED" : "QUEUED", reason: delivery.skipped ? "Email preference or account status" : delivery.deduplicated ? "Combined with today's reminder" : null,
          amountDueCents: summary.months.find((m) => m.period === t.period)?.outstanding ?? null, deliveryId: delivery.id,
        },
      }).catch(() => undefined); // unique key: another worker already recorded it
    }
    if (delivery.skipped) stats.skipped++;
    else if (!delivery.deduplicated) {
      stats.queued++;
      await prisma.auditEvent.create({
        data: {
          apartmentId, action: "reminder.sent", entityType: "ReminderRun", entityId: delivery.id, membershipId: member.id,
          summary: `${kind === "overdue" ? "Overdue" : "Rent"} reminder sent to ${member.displayName} for ${focus.period}`,
        },
      });
    }
  }
}

/** Reflect final email delivery status back onto reminder runs (QUEUED → SENT / FAILED). */
export async function syncReminderOutcomes(): Promise<void> {
  const queued = await prisma.reminderRun.findMany({ where: { outcome: "QUEUED", deliveryId: { not: null } }, take: 500 });
  if (!queued.length) return;
  const deliveries = await prisma.emailDelivery.findMany({ where: { id: { in: queued.map((q) => q.deliveryId!) } } });
  const byId = new Map(deliveries.map((d) => [d.id, d]));
  for (const run of queued) {
    const d = byId.get(run.deliveryId!);
    if (d?.status === "SENT") await prisma.reminderRun.update({ where: { id: run.id }, data: { outcome: "SENT" } });
    else if (d?.status === "FAILED") await prisma.reminderRun.update({ where: { id: run.id }, data: { outcome: "FAILED", reason: d.lastError } });
  }
}
