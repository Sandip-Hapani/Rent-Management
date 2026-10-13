import type { Role } from "@prisma/client";
import type { Db } from "../db";
import { forbidden } from "../errors";

/**
 * Authenticated request context. Every service function takes a Ctx and scopes all queries
 * to ctx.apartmentId (and to ctx.membershipId for resident-private data).
 */
export interface Ctx {
  userId: string;
  email: string;
  name: string;
  sessionId: string | null;
  apartmentId: string;
  apartmentName: string;
  timezone: string;
  membershipId: string;
  displayName: string;
  role: Role;
  isAdmin: boolean;
  /** false when the resident has moved out (read-only access to own history). */
  membershipActive: boolean;
}

/** Build a context for a user. Prefers the active membership, else the most recent one. */
export async function loadContextForUser(db: Db, userId: string, sessionId: string | null = null): Promise<Ctx | null> {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user || user.status !== "ACTIVE") return null;
  const membership = await db.membership.findFirst({
    where: { userId },
    orderBy: [{ status: "asc" }, { moveInDate: "desc" }], // ACTIVE sorts before LEFT
    include: { apartment: true },
  });
  if (!membership) return null;
  const active = membership.status === "ACTIVE";
  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    sessionId,
    apartmentId: membership.apartmentId,
    apartmentName: membership.apartment.name,
    timezone: membership.apartment.timezone,
    membershipId: membership.id,
    displayName: membership.displayName,
    role: membership.role,
    isAdmin: active && membership.role === "ADMIN",
    membershipActive: active,
  };
}

export function assertAdmin(ctx: Ctx): void {
  if (!ctx.isAdmin) throw forbidden();
}

export function assertActive(ctx: Ctx): void {
  if (!ctx.membershipActive) throw forbidden("Your membership has ended; your account is read-only.");
}
