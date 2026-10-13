/**
 * First-run setup for hosted deployments: create the apartment and a default administrator from
 * environment variables. Idempotent — it only ever creates, never modifies existing accounts, so
 * a password changed later in the app is kept even though INITIAL_ADMIN_PASSWORD stays set.
 */
import type { PrismaClient } from "@prisma/client";
import { hashPassword, normalizeEmail, passwordProblems } from "./auth/crypto";
import { defaultBillingStart, parseIsoDate, todayInZone } from "./finance/period";

export interface BootstrapInput {
  email?: string;
  name?: string;
  password?: string;
  apartmentName?: string;
  moveInDate?: string; // YYYY-MM-DD
  /** Max upload size for new apartments, e.g. 4 MB on Vercel (request body limit 4.5 MB). */
  maxUploadBytes?: number;
}

export type BootstrapResult =
  | { status: "skipped"; reason: string }
  | { status: "created"; apartmentCreated: boolean; email: string };

export async function ensureInitialAdmin(db: PrismaClient, input: BootstrapInput): Promise<BootstrapResult> {
  if (!input.email) return { status: "skipped", reason: "INITIAL_ADMIN_EMAIL is not set" };
  const email = normalizeEmail(input.email);
  const existingAdmin = await db.membership.findFirst({ where: { role: "ADMIN" } });
  if (existingAdmin) return { status: "skipped", reason: "an administrator already exists" };
  if (await db.user.findUnique({ where: { email } })) return { status: "skipped", reason: `a user with ${email} already exists` };

  const name = input.name?.trim() || email.split("@")[0]!;
  const password = input.password ?? "";
  const problems = passwordProblems(password, [name, email.split("@")[0]!]);
  if (problems.length) throw new Error(`INITIAL_ADMIN_PASSWORD is not acceptable: ${problems.join(" ")}`);
  const moveIn = (input.moveInDate && parseIsoDate(input.moveInDate)) || todayInZone();

  return db.$transaction(async (tx) => {
    let apartment = await tx.apartment.findFirst();
    const apartmentCreated = !apartment;
    apartment ??= await tx.apartment.create({
      data: { name: input.apartmentName?.trim() || "Our apartment", ...(input.maxUploadBytes ? { maxUploadBytes: input.maxUploadBytes } : {}) },
    });
    await tx.reminderSchedule.upsert({ where: { apartmentId: apartment.id }, create: { apartmentId: apartment.id }, update: {} });
    const user = await tx.user.create({ data: { email, name, status: "ACTIVE", emailVerifiedAt: new Date(), passwordHash: await hashPassword(password) } });
    const m = await tx.membership.create({
      data: { apartmentId: apartment.id, userId: user.id, role: "ADMIN", displayName: name.split(" ")[0]!, moveInDate: moveIn, billingStart: defaultBillingStart(moveIn) },
    });
    await tx.auditEvent.create({
      data: { apartmentId: apartment.id, action: "admin.bootstrapped", entityType: "Membership", entityId: m.id, membershipId: m.id, summary: `Default administrator ${m.displayName} created at deployment` },
    });
    return { status: "created" as const, apartmentCreated, email };
  });
}
