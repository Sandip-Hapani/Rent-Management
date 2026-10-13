import type { NotificationType } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db";
import { assertAdmin, type Ctx } from "../auth/ctx";
import { ESSENTIAL_TYPES } from "./email";

export const NOTIFICATION_TYPE_LABELS: Record<NotificationType, string> = {
  RENT_DUE_SOON: "Upcoming rent due",
  RENT_OVERDUE: "Rent overdue",
  PAYMENT_SUBMITTED: "Payment submitted (admins)",
  PAYMENT_VERIFIED: "Payment verified",
  PAYMENT_REJECTED: "Payment rejected",
  CLARIFICATION_REQUESTED: "Clarification requested",
  RENT_PRICE_UPDATED: "Rent price updated",
  ELECTRICITY_PRICE_UPDATED: "Electricity price updated",
  PRICE_UPDATED: "Other price updated",
  DOCUMENT_PUBLISHED: "New document published",
  ANNOUNCEMENT: "Apartment announcement",
  ACCOUNT_SECURITY: "Account security",
};

export async function unreadCount(ctx: Ctx) {
  return prisma.notification.count({ where: { userId: ctx.userId, readAt: null } });
}

export async function listNotifications(ctx: Ctx, onlyUnread = false) {
  return prisma.notification.findMany({ where: { userId: ctx.userId, ...(onlyUnread ? { readAt: null } : {}) }, orderBy: { createdAt: "desc" }, take: 200 });
}

export async function markRead(ctx: Ctx, ids: string[] | "all") {
  await prisma.notification.updateMany({ where: { userId: ctx.userId, readAt: null, ...(ids === "all" ? {} : { id: { in: ids } }) }, data: { readAt: new Date() } });
}

export async function getPreferences(ctx: Ctx) {
  const prefs = await prisma.notificationPreference.findMany({ where: { userId: ctx.userId } });
  const byType = new Map(prefs.map((p) => [p.type, p.email]));
  return (Object.keys(NOTIFICATION_TYPE_LABELS) as NotificationType[])
    .filter((t) => ctx.isAdmin || t !== "PAYMENT_SUBMITTED")
    .map((type) => ({ type, label: NOTIFICATION_TYPE_LABELS[type], email: ESSENTIAL_TYPES.includes(type) ? true : (byType.get(type) ?? true), locked: ESSENTIAL_TYPES.includes(type) }));
}

export async function setPreferences(ctx: Ctx, raw: Record<string, boolean>) {
  const input = z.record(z.string(), z.boolean()).parse(raw);
  for (const [type, email] of Object.entries(input)) {
    if (!(type in NOTIFICATION_TYPE_LABELS) || ESSENTIAL_TYPES.includes(type as NotificationType)) continue;
    await prisma.notificationPreference.upsert({
      where: { userId_type: { userId: ctx.userId, type: type as NotificationType } },
      create: { userId: ctx.userId, type: type as NotificationType, email },
      update: { email },
    });
  }
}

/** Recent activity: public apartment events plus events about the viewer (admins see everything). */
export async function recentActivity(ctx: Ctx, take = 12) {
  return prisma.auditEvent.findMany({
    where: {
      apartmentId: ctx.apartmentId,
      ...(ctx.isAdmin ? {} : { OR: [{ isPublic: true }, { membershipId: ctx.membershipId }] }),
      action: { notIn: ["import.row_resolved", "payment.drafted", "payment.updated"] },
    },
    orderBy: { createdAt: "desc" },
    take,
    select: { id: true, action: true, summary: true, createdAt: true },
  });
}

export async function auditLog(ctx: Ctx, filter: { q?: string; entityType?: string; take?: number } = {}) {
  assertAdmin(ctx);
  return prisma.auditEvent.findMany({
    where: {
      apartmentId: ctx.apartmentId,
      ...(filter.entityType ? { entityType: filter.entityType } : {}),
      ...(filter.q ? { OR: [{ summary: { contains: filter.q, mode: "insensitive" } }, { action: { contains: filter.q, mode: "insensitive" } }] } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: filter.take ?? 300,
  });
}

export async function emailHistory(ctx: Ctx) {
  assertAdmin(ctx);
  return prisma.emailDelivery.findMany({
    where: { apartmentId: ctx.apartmentId },
    orderBy: { createdAt: "desc" },
    take: 300,
    select: { id: true, toEmail: true, kind: true, subject: true, status: true, attempts: true, lastError: true, skipReason: true, sentAt: true, createdAt: true },
  });
}

export const reminderScheduleSchema = z.object({
  enabled: z.boolean(),
  daysBeforeDue: z.array(z.number().int().min(1).max(28)).max(5),
  onDueDate: z.boolean(),
  daysAfterDue: z.array(z.number().int().min(1).max(90)).max(6),
  repeatEveryDays: z.number().int().min(1).max(60).nullable(),
  maxReminders: z.number().int().min(1).max(20),
  excludeFullyPaid: z.boolean(),
  mentionPending: z.boolean(),
  stopWhenVerified: z.boolean(),
  sendHourLocal: z.number().int().min(0).max(23),
});

export async function getReminderSchedule(ctx: Ctx) {
  assertAdmin(ctx);
  return prisma.reminderSchedule.upsert({ where: { apartmentId: ctx.apartmentId }, create: { apartmentId: ctx.apartmentId }, update: {} });
}

export async function saveReminderSchedule(ctx: Ctx, raw: z.input<typeof reminderScheduleSchema>) {
  assertAdmin(ctx);
  const input = reminderScheduleSchema.parse(raw);
  const uniq = (a: number[]) => [...new Set(a)].sort((x, y) => x - y);
  await prisma.reminderSchedule.upsert({
    where: { apartmentId: ctx.apartmentId },
    create: { apartmentId: ctx.apartmentId, ...input, daysBeforeDue: uniq(input.daysBeforeDue), daysAfterDue: uniq(input.daysAfterDue) },
    update: { ...input, daysBeforeDue: uniq(input.daysBeforeDue), daysAfterDue: uniq(input.daysAfterDue) },
  });
  await prisma.auditEvent.create({ data: { apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: "reminders.updated", entityType: "ReminderSchedule", entityId: ctx.apartmentId, summary: `${ctx.displayName} updated the reminder schedule`, after: input } });
}
