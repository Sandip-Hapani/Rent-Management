/**
 * DEVELOPMENT DEMO DATA ONLY — refuses to run when NODE_ENV=production.
 *
 *   npm run db:seed            (only if the database is empty)
 *   npm run db:seed -- --reset (wipes all data first)
 *
 * Creates a demo apartment with five fictional residents, prices, five months of obligations and a
 * mix of verified, pending and missing payments. All residents share DEMO_PASSWORD (prisma/demo.ts).
 */
import "dotenv/config";
import { prisma } from "../src/server/db";
import { hashPassword } from "../src/server/auth/crypto";
import { loadContextForUser } from "../src/server/auth/ctx";
import { createAdjustment, createManualCharge, finalizePeriod, generatePeriod, publishRule, saveDraftRule } from "../src/server/finance/admin";
import { addMonths, currentPeriod, dueDateFor } from "../src/server/finance/period";
import { createPayment, verifyPayment } from "../src/server/payments/service";
import { createAnnouncement } from "../src/server/documents/service";
import { DEMO_PASSWORD } from "./demo";


const PEOPLE = [
  { name: "Alex Admin", display: "Alex", email: "alex@demo.test", role: "ADMIN" as const, moveIn: "2024-06-01" },
  { name: "Bea Becker", display: "Bea", email: "bea@demo.test", role: "RESIDENT" as const, moveIn: "2024-06-01" },
  { name: "Chris Cole", display: "Chris", email: "chris@demo.test", role: "RESIDENT" as const, moveIn: "2024-06-01" },
  { name: "Dana Diaz", display: "Dana", email: "dana@demo.test", role: "RESIDENT" as const, moveIn: "2024-06-01" },
  { name: "Eli Evans", display: "Eli", email: "eli@demo.test", role: "RESIDENT" as const, moveIn: "2025-11-05" },
];

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed demo data in production.");
  if (process.argv.includes("--reset")) {
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
    await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`);
  } else if (await prisma.apartment.count()) {
    console.log("Database already has data; run with --reset to replace it.");
    return;
  }

  const apartment = await prisma.apartment.create({ data: { name: "Demo Flat, Chemnitz", rentDueDay: 1, graceDays: 3 } });
  await prisma.reminderSchedule.create({ data: { apartmentId: apartment.id } });
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const ids: string[] = [];
  for (const p of PEOPLE) {
    const u = await prisma.user.create({ data: { email: p.email, name: p.name, status: "ACTIVE", passwordHash, emailVerifiedAt: new Date() } });
    const moveIn = new Date(`${p.moveIn}T00:00:00Z`);
    await prisma.membership.create({ data: { apartmentId: apartment.id, userId: u.id, role: p.role, displayName: p.display, moveInDate: moveIn, billingStart: p.moveIn.slice(0, 7) } });
    ids.push(u.id);
  }
  const ctxs = await Promise.all(ids.map((id) => loadContextForUser(prisma, id)));
  const admin = ctxs[0]!;
  const residents = ctxs.map((c) => c!);

  const now = currentPeriod();
  const first = addMonths(now, -4);
  const rent = await saveDraftRule(admin, { name: "Rent", category: "RENT", method: "EQUAL_SPLIT", totalAmountCents: 88_000, perMemberAmountCents: null, effectiveFrom: first, shares: [], reason: "Rent per lease" });
  await publishRule(admin, rent.id, { reason: "Rent per lease", notifyResidents: false });
  const elec = await saveDraftRule(admin, { name: "Electricity", category: "ELECTRICITY", method: "FIXED_PER_MEMBER", totalAmountCents: null, perMemberAmountCents: 2_360, effectiveFrom: first, shares: [], reason: "Supplier advance payment" });
  await publishRule(admin, elec.id, { reason: "Supplier advance payment", notifyResidents: false });
  const elec2 = await saveDraftRule(admin, { name: "Electricity", category: "ELECTRICITY", method: "FIXED_PER_MEMBER", totalAmountCents: null, perMemberAmountCents: 2_560, effectiveFrom: addMonths(now, -1), previousRuleId: elec.id, shares: [], reason: "New tariff from the supplier" });
  await publishRule(admin, elec2.id, { reason: "New tariff from the supplier (letter in Documents)", notifyResidents: true });

  for (let i = 0; i <= 4; i++) {
    const p = addMonths(first, i);
    await generatePeriod(admin, p);
    await finalizePeriod(admin, p);
  }
  await createManualCharge(admin, { membershipId: residents[4]!.membershipId, period: first, category: "SECURITY_DEPOSIT", amountCents: 20_680, description: "Security deposit" });
  await createAdjustment(admin, { membershipId: residents[2]!.membershipId, period: addMonths(now, -2), category: "RENT", kind: "SETTLEMENT", amountCents: -709, reason: "Settled via Splitwise" });

  // Payments: most months verified, some pending, Chris behind, Dana overpaid once.
  for (const [idx, r] of residents.entries()) {
    for (let i = 0; i <= 4; i++) {
      const p = addMonths(first, i);
      if (idx === 2 && i >= 3) continue; // Chris hasn't paid the last two months
      if (idx === 1 && i === 4) continue; // Bea hasn't paid this month yet
      const charges = await prisma.charge.findMany({ where: { membershipId: r.membershipId, period: { period: p }, status: "FINAL", category: { in: ["RENT", "ELECTRICITY"] } } });
      const total = charges.reduce((a, c) => a + c.amountCents, 0) + (idx === 3 && i === 1 ? 1_000 : 0);
      const d = dueDateFor(p, 1);
      const transfer = new Date(d.getTime() - 3 * 86_400_000).toISOString().slice(0, 10);
      const pay = await createPayment(r, { amountCents: total, transferDate: transfer, bank: ["Sparkasse", "Deutsche Bank", "Wise", "N26", "Sparkasse"][idx], description: `Rent + electricity ${p}`, intendedPeriods: [p], includesElectricity: true });
      const pendingDemo = (idx === 4 && i === 4) || (idx === 3 && i === 4);
      if (!pendingDemo && r.membershipId !== admin.membershipId) {
        const prop = await prisma.allocation.findMany({ where: { paymentId: pay.id } });
        await verifyPayment(admin, pay.id, prop.map((a) => ({ chargeId: a.chargeId, amountCents: a.amountCents })));
      } else if (r.membershipId === admin.membershipId) {
        await prisma.payment.update({ where: { id: pay.id }, data: { source: "SELF_SETTLED" } });
        const prop = await prisma.allocation.findMany({ where: { paymentId: pay.id } });
        await verifyPayment(admin, pay.id, prop.map((a) => ({ chargeId: a.chargeId, amountCents: a.amountCents })), "Administrator's own share");
      }
    }
  }
  const dep = await prisma.charge.findFirstOrThrow({ where: { membershipId: residents[4]!.membershipId, category: "SECURITY_DEPOSIT" } });
  const depPay = await createPayment(residents[4]!, { amountCents: 20_680, transferDate: new Date().toISOString().slice(0, 10), bank: "N26", description: "Deposit", includesDeposit: true });
  await verifyPayment(admin, depPay.id, [{ chargeId: dep.id, amountCents: 20_680 }]);
  await createAnnouncement(admin, "Welcome to the new rent app", "From now on, please record every transfer here instead of the Google Form. Contracts and price letters are in Documents.");
  await prisma.emailDelivery.updateMany({ where: { status: "PENDING" }, data: { status: "SKIPPED", skipReason: "Seed data" } });

  console.log(`Seeded "${apartment.name}" with ${PEOPLE.length} residents. Sign in as alex@demo.test (admin) or bea@demo.test with the DEMO_PASSWORD from prisma/demo.ts.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
