import { prisma } from "../db";
import { randomToken, sha256 } from "./crypto";

export const SESSION_TTL_DAYS = 30;
const RENEW_AFTER_MS = 24 * 3_600_000; // extend expiry at most once a day

export async function createSession(userId: string, userAgent?: string | null): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);
  await prisma.session.create({ data: { tokenHash: sha256(token), userId, expiresAt, userAgent: userAgent?.slice(0, 200) ?? null } });
  return { token, expiresAt };
}

/** Resolve a raw session token to an active user, sliding the expiry. Returns null if invalid. */
export async function validateSessionToken(token: string) {
  const session = await prisma.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now() || session.user.status !== "ACTIVE") {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  if (Date.now() - session.lastSeenAt.getTime() > RENEW_AFTER_MS) {
    await prisma.session.update({
      where: { id: session.id },
      data: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000) },
    });
  }
  return { sessionId: session.id, user: session.user };
}

export async function deleteSessionToken(token: string): Promise<void> {
  await prisma.session.deleteMany({ where: { tokenHash: sha256(token) } });
}

export async function revokeAllSessions(userId: string, exceptSessionId?: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) } });
}
