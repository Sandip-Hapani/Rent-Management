import type { Prisma } from "@prisma/client";
import type { Db } from "./db";

export interface AuditInput {
  apartmentId: string | null;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  membershipId?: string | null;
  isPublic?: boolean;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

/** Strip anything that should never be persisted in audit history. */
function scrub(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  return JSON.parse(
    JSON.stringify(value, (k, v) => (/(password|token|hash|secret)/i.test(k) ? "[redacted]" : typeof v === "bigint" ? v.toString() : v)),
  );
}

/** Write an audit event. Pass the transaction client so the event commits atomically with the change. */
export async function audit(db: Db, e: AuditInput): Promise<void> {
  await db.auditEvent.create({
    data: {
      apartmentId: e.apartmentId,
      actorUserId: e.actorUserId,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId,
      summary: e.summary,
      membershipId: e.membershipId ?? null,
      isPublic: e.isPublic ?? false,
      before: scrub(e.before),
      after: scrub(e.after),
      reason: e.reason ?? null,
    },
  });
}
