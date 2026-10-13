import nodemailer, { type Transporter } from "nodemailer";
import type { NotificationType } from "@prisma/client";
import { prisma, type Db } from "../db";
import { env } from "../env";
import type { EmailContent } from "./templates";

const MAX_ATTEMPTS = 5;

/** Notification types that users cannot opt out of. */
export const ESSENTIAL_TYPES: readonly NotificationType[] = ["ACCOUNT_SECURITY"];

export interface QueueEmailInput {
  apartmentId?: string | null;
  userId?: string | null;
  toEmail: string;
  kind: string;
  dedupeKey: string;
  content: EmailContent;
  /** When set, the user's email preference for this type is honoured (unless essential). */
  preferenceType?: NotificationType;
}

/**
 * Put an email in the outbox. Idempotent on dedupeKey: queueing the same logical email twice
 * returns the existing row and never sends twice.
 */
export async function queueEmail(db: Db, input: QueueEmailInput): Promise<{ id: string; deduplicated: boolean; skipped: boolean }> {
  const existing = await db.emailDelivery.findUnique({ where: { dedupeKey: input.dedupeKey } });
  if (existing) return { id: existing.id, deduplicated: true, skipped: existing.status === "SKIPPED" };

  let skipReason: string | null = null;
  if (input.userId && input.preferenceType && !ESSENTIAL_TYPES.includes(input.preferenceType)) {
    const pref = await db.notificationPreference.findUnique({ where: { userId_type: { userId: input.userId, type: input.preferenceType } } });
    if (pref && !pref.email) skipReason = "Recipient turned off email for this notification type";
  }
  if (input.userId) {
    const user = await db.user.findUnique({ where: { id: input.userId }, select: { status: true } });
    if (user?.status === "DEACTIVATED") skipReason = "Recipient account is deactivated";
  }

  const row = await db.emailDelivery.create({
    data: {
      apartmentId: input.apartmentId ?? null,
      userId: input.userId ?? null,
      toEmail: input.toEmail,
      kind: input.kind,
      subject: input.content.subject,
      html: input.content.html,
      text: input.content.text,
      dedupeKey: input.dedupeKey,
      status: skipReason ? "SKIPPED" : "PENDING",
      skipReason,
    },
  });
  return { id: row.id, deduplicated: false, skipped: !!skipReason };
}

let transporter: Transporter | null = null;
export type MailSender = (msg: { to: string; subject: string; html: string; text: string }) => Promise<void>;

function defaultSender(): MailSender | null {
  const e = env();
  if (!e.SMTP_HOST) return null;
  transporter ??= nodemailer.createTransport({
    host: e.SMTP_HOST,
    port: e.SMTP_PORT,
    secure: e.SMTP_SECURE,
    auth: e.SMTP_USER ? { user: e.SMTP_USER, pass: e.SMTP_PASSWORD } : undefined,
  });
  return async (msg) => {
    await transporter!.sendMail({ from: e.EMAIL_FROM, ...msg });
  };
}

/** Send due outbox emails. Safe to run concurrently: each row is claimed atomically. */
export async function processOutbox(opts: { limit?: number; sender?: MailSender } = {}): Promise<{ sent: number; failed: number }> {
  const sender = opts.sender ?? defaultSender();
  const due = await prisma.emailDelivery.findMany({
    where: { status: "PENDING", nextAttemptAt: { lte: new Date() } },
    orderBy: { createdAt: "asc" },
    take: opts.limit ?? 50,
  });
  let sent = 0;
  let failed = 0;
  for (const row of due) {
    const claimed = await prisma.emailDelivery.updateMany({
      where: { id: row.id, status: "PENDING", attempts: row.attempts },
      data: { attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + 10 * 60_000) },
    });
    if (claimed.count === 0) continue;
    if (!sender) {
      await prisma.emailDelivery.update({ where: { id: row.id }, data: { status: "FAILED", lastError: "SMTP is not configured" } });
      failed++;
      continue;
    }
    try {
      await sender({ to: row.toEmail, subject: row.subject, html: row.html, text: row.text });
      await prisma.emailDelivery.update({ where: { id: row.id }, data: { status: "SENT", sentAt: new Date(), lastError: null } });
      sent++;
    } catch (e) {
      const attempts = row.attempts + 1;
      const message = e instanceof Error ? e.message.slice(0, 500) : "send failed";
      await prisma.emailDelivery.update({
        where: { id: row.id },
        data: attempts >= MAX_ATTEMPTS ? { status: "FAILED", lastError: message } : { lastError: message, nextAttemptAt: new Date(Date.now() + 2 ** attempts * 60_000) },
      });
      failed++;
    }
  }
  return { sent, failed };
}
