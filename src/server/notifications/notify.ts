import type { NotificationType } from "@prisma/client";
import type { Db } from "../db";
import { env } from "../env";
import { queueEmail } from "./email";
import type { EmailContent } from "./templates";

export interface NotifyInput {
  apartmentId: string;
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  /** App-relative path, e.g. /payments/abc */
  link?: string;
  /** Unique key for this logical event; prevents duplicates in-app and by email. */
  dedupeKey: string;
  /** Build the email for this user, or omit to send in-app only. */
  email?: (user: { name: string; email: string }) => EmailContent;
}

export const absoluteUrl = (path: string) => `${env().APP_URL}${path.startsWith("/") ? path : `/${path}`}`;

/** Create an in-app notification and (optionally) queue an email, idempotently. */
export async function notify(db: Db, n: NotifyInput): Promise<void> {
  const user = await db.user.findUnique({ where: { id: n.userId }, select: { id: true, name: true, email: true, status: true } });
  if (!user || user.status === "DEACTIVATED") return;
  const existing = await db.notification.findUnique({ where: { dedupeKey: `inapp:${n.dedupeKey}` } });
  if (!existing) {
    await db.notification.create({
      data: { userId: n.userId, type: n.type, title: n.title, body: n.body, link: n.link ?? null, dedupeKey: `inapp:${n.dedupeKey}` },
    });
  }
  if (n.email) {
    await queueEmail(db, {
      apartmentId: n.apartmentId,
      userId: user.id,
      toEmail: user.email,
      kind: n.type,
      dedupeKey: `email:${n.dedupeKey}`,
      content: n.email(user),
      preferenceType: n.type,
    });
  }
}

/** Active admins of an apartment (recipients of admin notifications). */
export async function apartmentAdmins(db: Db, apartmentId: string) {
  return db.membership.findMany({
    where: { apartmentId, role: "ADMIN", status: "ACTIVE", user: { status: "ACTIVE" } },
    select: { id: true, userId: true, displayName: true },
  });
}

/** Active residents (incl. admins) with active user accounts. */
export async function activeResidents(db: Db, apartmentId: string) {
  return db.membership.findMany({
    where: { apartmentId, status: "ACTIVE", user: { status: "ACTIVE" } },
    select: { id: true, userId: true, displayName: true },
  });
}
