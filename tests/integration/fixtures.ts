import { prisma } from "@/server/db";
import { loadContextForUser, type Ctx } from "@/server/auth/ctx";
import { finalizePeriod, generatePeriod, publishRule, saveDraftRule } from "@/server/finance/admin";
import { parseIsoDate } from "@/server/finance/period";

const TABLES = [
  "StoredBlob",
  "Allocation", "PaymentEvidence", "Payment", "Charge", "Adjustment", "Payout", "ChargeRuleShare", "ChargeRule", "ReminderRun", "FinancialPeriod",
  "DocumentAcknowledgement", "DocumentAccess", "DocumentVersion", "Document", "FileObject", "Announcement", "PriceChange", "Notification",
  "NotificationPreference", "EmailDelivery", "ReminderSchedule", "AuditEvent", "ImportRow", "ImportBatch", "ResidentAlias", "Membership",
  "Session", "AuthToken", "RateLimitBucket", "User", "Apartment",
];

export async function resetDb() {
  await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} CASCADE`);
}

export interface World {
  apartmentId: string;
  admin: Ctx;
  residents: Ctx[]; // 4 non-admin residents
  all: Ctx[]; // admin first
}

/**
 * Five residents (one administrator). Names are fixture data only — the app never hardcodes them.
 */
export async function createWorld(opts: { billingStart?: string } = {}): Promise<World> {
  const apartment = await prisma.apartment.create({ data: { name: "Test Flat", rentDueDay: 1, graceDays: 3 } });
  const people = [
    { name: "Hanna Admin", display: "Hanna", role: "ADMIN" as const },
    { name: "Ravi Resident", display: "Ravi", role: "RESIDENT" as const },
    { name: "Lena Resident", display: "Lena", role: "RESIDENT" as const },
    { name: "Omar Resident", display: "Omar", role: "RESIDENT" as const },
    { name: "Mia Resident", display: "Mia", role: "RESIDENT" as const },
  ];
  const ctxs: Ctx[] = [];
  let i = 0;
  for (const p of people) {
    const user = await prisma.user.create({ data: { email: `${p.display.toLowerCase()}@example.test`, name: p.name, status: "ACTIVE", emailVerifiedAt: new Date() } });
    await prisma.membership.create({
      data: { apartmentId: apartment.id, userId: user.id, role: p.role, displayName: p.display, moveInDate: new Date(Date.UTC(2025, 0, 1 + i++)), billingStart: opts.billingStart ?? "2026-01" },
    });
    ctxs.push((await loadContextForUser(prisma, user.id))!);
  }
  return { apartmentId: apartment.id, admin: ctxs[0]!, residents: ctxs.slice(1), all: ctxs };
}

/** Publish an equal-split rent rule and a fixed electricity rule, effective from `from`. */
export async function standardPricing(w: World, from = "2026-01", rentTotal = 100_000, elecEach = 3_500) {
  const rent = await saveDraftRule(w.admin, { name: "Rent", category: "RENT", method: "EQUAL_SPLIT", totalAmountCents: rentTotal, perMemberAmountCents: null, effectiveFrom: from, shares: [] });
  await publishRule(w.admin, rent.id, { reason: "Initial rent", notifyResidents: false });
  const elec = await saveDraftRule(w.admin, { name: "Electricity", category: "ELECTRICITY", method: "FIXED_PER_MEMBER", totalAmountCents: null, perMemberAmountCents: elecEach, effectiveFrom: from, shares: [] });
  await publishRule(w.admin, elec.id, { reason: "Initial electricity", notifyResidents: false });
  return { rentRuleId: rent.id, elecRuleId: elec.id };
}

export async function openMonth(w: World, period: string) {
  await generatePeriod(w.admin, period);
  await finalizePeriod(w.admin, period);
}

export async function chargeOf(membershipId: string, period: string, category: "RENT" | "ELECTRICITY" | "SECURITY_DEPOSIT" | "RENT_BUFFER" | "OPERATING_COSTS") {
  return prisma.charge.findFirstOrThrow({ where: { membershipId, category, period: { period }, status: "FINAL" } });
}

export const day = (s: string) => parseIsoDate(s)!;

export function fakeFile(bytes: Uint8Array | Buffer, name: string, type = "application/octet-stream"): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

/** Minimal valid PDF / PNG byte signatures for upload tests. */
export const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
export const PNG_BYTES = Buffer.from("89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D4944415478DA63F8FFFF3F0005FE02FEA7D5A2B10000000049454E44AE426082", "hex");
