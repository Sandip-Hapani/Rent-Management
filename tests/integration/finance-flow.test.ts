import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { applyDeposit, createAdjustment, createManualCharge, createPayout, finalizePeriod, generatePeriod, getPeriodReview, previewRule, publishRule, reverseAdjustment, saveDraftRule, voidCharge } from "@/server/finance/admin";
import { getApartmentOverview, getCollectionSeries, getMemberSummary, loadLedgerInput } from "@/server/finance/queries";
import { reconcile } from "@/server/finance/ledger";
import { createPayment, reallocatePayment, rejectPayment, reversePayment, verifyPayment } from "@/server/payments/service";
import { updateMembership } from "@/server/auth/service";
import { buildReport, buildStatement } from "@/server/reports/service";
import { chargeOf, createWorld, openMonth, resetDb, standardPricing, type World } from "./fixtures";

let w: World;

beforeEach(async () => {
  await resetDb();
  w = await createWorld();
  await standardPricing(w); // rent 1000.00 split 5 ways = 200.00 each; electricity 35.00 each
});

const summaryOf = (i: number) => getMemberSummary(w.admin, w.all[i]!.membershipId);

describe("monthly obligations", () => {
  it("generates drafts for review, then finalises them exactly once", async () => {
    const gen = await generatePeriod(w.admin, "2026-01");
    expect(gen.created).toBe(10);
    const review = await getPeriodReview(w.admin, "2026-01");
    expect(review.ruleChecks.every((r) => r.ok)).toBe(true);
    expect((await getMemberSummary(w.admin, w.residents[0]!.membershipId)).months).toHaveLength(0); // drafts don't count
    await finalizePeriod(w.admin, "2026-01");
    const again = await generatePeriod(w.admin, "2026-01");
    expect(again.created).toBe(0); // final charges are never duplicated or replaced
    expect(await prisma.charge.count({ where: { status: "FINAL" } })).toBe(10);
  });
});

describe("payments", () => {
  beforeEach(async () => {
    await openMonth(w, "2026-01");
    await openMonth(w, "2026-02");
  });

  it("full rent + electricity payment in one transfer clears the month after verification only", async () => {
    const r = w.residents[0]!;
    const p = await createPayment(r, { amountCents: 23_500, transferDate: "2026-01-02", bank: "Sparkasse", intendedPeriods: ["2026-01"] });
    let s = await getMemberSummary(r, r.membershipId);
    expect(s.months[0]!.outstanding).toBe(23_500);
    expect(s.months[0]!.pending).toBe(23_500);
    const proposed = await prisma.allocation.findMany({ where: { paymentId: p.id } });
    await verifyPayment(w.admin, p.id, proposed.map((a) => ({ chargeId: a.chargeId, amountCents: a.amountCents })));
    s = await getMemberSummary(r, r.membershipId);
    expect(s.months[0]!.outstanding).toBe(0);
    expect(s.paidByCategory.RENT).toBe(20_000);
    expect(s.paidByCategory.ELECTRICITY).toBe(3_500);
  });

  it("partial payment, then a second transfer for the same obligation", async () => {
    const r = w.residents[1]!;
    const rent = await chargeOf(r.membershipId, "2026-01", "RENT");
    const p1 = await createPayment(r, { amountCents: 15_000, transferDate: "2026-01-02" });
    await verifyPayment(w.admin, p1.id, [{ chargeId: rent.id, amountCents: 15_000 }]);
    expect((await getMemberSummary(r, r.membershipId)).months[0]!.outstanding).toBe(8_500);
    const p2 = await createPayment(r, { amountCents: 5_000, transferDate: "2026-01-10" });
    await verifyPayment(w.admin, p2.id, [{ chargeId: rent.id, amountCents: 5_000 }]);
    const s = await getMemberSummary(r, r.membershipId);
    expect(s.months[0]!.byCategory.RENT!.outstanding).toBe(0);
    expect(s.months[0]!.byCategory.ELECTRICITY!.outstanding).toBe(3_500);
  });

  it("one transfer across two months, with overpayment kept as credit", async () => {
    const r = w.residents[2]!;
    const p = await createPayment(r, { amountCents: 50_000, transferDate: "2026-01-02", intendedPeriods: ["2026-01", "2026-02"] });
    const proposed = await prisma.allocation.findMany({ where: { paymentId: p.id } });
    expect(proposed.reduce((a, x) => a + x.amountCents, 0)).toBe(47_000);
    await verifyPayment(w.admin, p.id, proposed.map((a) => ({ chargeId: a.chargeId, amountCents: a.amountCents })));
    const s = await getMemberSummary(r, r.membershipId);
    expect(s.months.map((m) => m.outstanding)).toEqual([0, 0]);
    expect(s.unallocatedCredit).toBe(3_000);
    const series = await getCollectionSeries(w.admin, 2);
    // Counted once per month, never twice.
    const jan = series.series.find((x) => x.period === "2026-01");
    expect(jan?.confirmed ?? 0).toBeLessThanOrEqual(5 * 23_500);
  });

  it("rejects over-allocation and allocation to another resident's charge", async () => {
    const [a, b] = w.residents;
    const p = await createPayment(a!, { amountCents: 30_000, transferDate: "2026-01-02" });
    const rentA = await chargeOf(a!.membershipId, "2026-01", "RENT");
    const rentB = await chargeOf(b!.membershipId, "2026-01", "RENT");
    await expect(verifyPayment(w.admin, p.id, [{ chargeId: rentA.id, amountCents: 20_001 }])).rejects.toThrow(/exceeds the open amount/);
    await expect(verifyPayment(w.admin, p.id, [{ chargeId: rentB.id, amountCents: 1_000 }])).rejects.toThrow(/unknown charge/);
  });

  it("rejection and reversal keep history and never reduce balances", async () => {
    const r = w.residents[3]!;
    const rent = await chargeOf(r.membershipId, "2026-01", "RENT");
    const p1 = await createPayment(r, { amountCents: 20_000, transferDate: "2026-01-02" });
    await rejectPayment(w.admin, p1.id, "Receipt shows a different account");
    const p2 = await createPayment(r, { amountCents: 20_000, transferDate: "2026-01-03" });
    await verifyPayment(w.admin, p2.id, [{ chargeId: rent.id, amountCents: 20_000 }]);
    await reversePayment(w.admin, p2.id, "Bank returned the transfer");
    const s = await getMemberSummary(r, r.membershipId);
    expect(s.months[0]!.byCategory.RENT!.outstanding).toBe(20_000);
    expect(await prisma.payment.count({ where: { membershipId: r.membershipId } })).toBe(2);
    const events = await prisma.auditEvent.findMany({ where: { entityId: p2.id }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.action)).toEqual(["payment.submitted", "payment.verified", "payment.reversed"]);
  });

  it("reallocation reverses old allocations and records new ones with an audit trail", async () => {
    const r = w.residents[0]!;
    const jan = await chargeOf(r.membershipId, "2026-01", "RENT");
    const feb = await chargeOf(r.membershipId, "2026-02", "RENT");
    const p = await createPayment(r, { amountCents: 20_000, transferDate: "2026-01-02" });
    await verifyPayment(w.admin, p.id, [{ chargeId: feb.id, amountCents: 20_000 }]);
    await reallocatePayment(w.admin, p.id, [{ chargeId: jan.id, amountCents: 20_000 }], "Was meant for January");
    const allocs = await prisma.allocation.findMany({ where: { paymentId: p.id }, orderBy: { createdAt: "asc" } });
    expect(allocs.map((a) => a.state)).toEqual(["REVERSED", "ACTIVE"]);
    const s = await getMemberSummary(r, r.membershipId);
    expect(s.months.find((m) => m.period === "2026-01")!.byCategory.RENT!.outstanding).toBe(0);
    expect(s.months.find((m) => m.period === "2026-02")!.byCategory.RENT!.outstanding).toBe(20_000);
  });

  it("apartment-wide totals reconcile with resident records, report and statement", async () => {
    for (const [i, r] of w.residents.entries()) {
      if (i === 3) continue;
      const p = await createPayment(r, { amountCents: 23_500, transferDate: "2026-01-02", intendedPeriods: ["2026-01"] });
      const prop = await prisma.allocation.findMany({ where: { paymentId: p.id } });
      if (i < 2) await verifyPayment(w.admin, p.id, prop.map((a) => ({ chargeId: a.chargeId, amountCents: a.amountCents })));
    }
    const overview = await getApartmentOverview(w.admin, "2026-01");
    expect(overview.expected).toBe(5 * 23_500);
    expect(overview.confirmed).toBe(2 * 23_500);
    expect(overview.pending).toBe(23_500); // resident 3 submitted but is not verified yet
    expect(overview.members.reduce((a, m) => a + m.confirmed, 0)).toBe(overview.confirmed);
    expect(overview.fullyPaid).toBe(2);
    const report = await buildReport(w.admin, "collection", { from: "2026-01", to: "2026-01" });
    expect(report.rows[0]).toMatchObject({ expected: overview.expected, confirmed: overview.confirmed, pending: overview.pending });
    const stmt = await buildStatement(w.admin, w.residents[0]!.membershipId, { from: "2026-01", to: "2026-02" });
    const janRows = stmt.tables[0]!.rows.filter((r) => r.month === "2026-01");
    expect(janRows.reduce((a, r) => a + Number(r.outstanding), 0)).toBe(0);
    expect(reconcile(await loadLedgerInput(prisma, w.apartmentId)).ok).toBe(true);
  });
});

describe("price changes", () => {
  it("future electricity change leaves earlier months and rent untouched", async () => {
    await openMonth(w, "2026-01");
    await openMonth(w, "2026-02");
    const current = await prisma.chargeRule.findFirstOrThrow({ where: { category: "ELECTRICITY", status: "PUBLISHED" } });
    const draft = await saveDraftRule(w.admin, { name: "Electricity 2026-04", category: "ELECTRICITY", method: "FIXED_PER_MEMBER", totalAmountCents: null, perMemberAmountCents: 4_000, effectiveFrom: "2026-04", previousRuleId: current.id, shares: [] });
    const preview = await previewRule(w.admin, draft.id);
    expect(preview.rows.every((r) => r.previousCents === 3_500 && r.newCents === 4_000)).toBe(true);
    await publishRule(w.admin, draft.id, { reason: "New supplier tariff", notifyResidents: true });
    await openMonth(w, "2026-03");
    await openMonth(w, "2026-04");
    const elec = async (p: string) => (await chargeOf(w.residents[0]!.membershipId, p, "ELECTRICITY")).amountCents;
    expect([await elec("2026-01"), await elec("2026-02"), await elec("2026-03"), await elec("2026-04")]).toEqual([3_500, 3_500, 3_500, 4_000]);
    expect((await chargeOf(w.residents[0]!.membershipId, "2026-04", "RENT")).amountCents).toBe(20_000);
    expect(await prisma.priceChange.count()).toBe(1);
    const notes = await prisma.notification.findMany({ where: { type: "ELECTRICITY_PRICE_UPDATED" } });
    expect(notes).toHaveLength(5); // every active resident, including the administrator (who also pays)
  });

  it("rent change effective after an already finalised month does not rewrite it", async () => {
    await openMonth(w, "2026-01");
    await openMonth(w, "2026-02");
    const rent = await prisma.chargeRule.findFirstOrThrow({ where: { category: "RENT", status: "PUBLISHED" } });
    const draft = await saveDraftRule(w.admin, { name: "Rent increase", category: "RENT", method: "EQUAL_SPLIT", totalAmountCents: 105_000, perMemberAmountCents: null, effectiveFrom: "2026-02", previousRuleId: rent.id, shares: [] });
    const preview = await previewRule(w.admin, draft.id);
    expect(preview.warnings.join(" ")).toMatch(/already finalised/);
    await publishRule(w.admin, draft.id, { reason: "Landlord increase", notifyResidents: false });
    await generatePeriod(w.admin, "2026-02");
    expect((await chargeOf(w.residents[0]!.membershipId, "2026-02", "RENT")).amountCents).toBe(20_000); // old final stays
    await openMonth(w, "2026-03");
    expect((await chargeOf(w.residents[0]!.membershipId, "2026-03", "RENT")).amountCents).toBe(21_000);
    const charges = await prisma.charge.findMany({ where: { category: "RENT", period: { period: "2026-03" } } });
    expect(charges.every((c) => c.ruleVersion === 2)).toBe(true);
  });
});

describe("membership changes", () => {
  it("resident leaving mid-period stops being charged and the split re-balances", async () => {
    const leaving = w.residents[3]!;
    await updateMembership(w.admin, leaving.membershipId, { displayName: "Omar", role: "RESIDENT", moveInDate: "2025-01-04", moveOutDate: "2026-02-10", billingStart: "2026-01" }, "Moved out");
    const m = await prisma.membership.findUniqueOrThrow({ where: { id: leaving.membershipId } });
    expect(m.billingEnd).toBe("2026-01");
    await openMonth(w, "2026-01");
    await openMonth(w, "2026-02");
    const feb = await prisma.charge.findMany({ where: { category: "RENT", period: { period: "2026-02" } } });
    expect(feb).toHaveLength(4);
    expect(feb.reduce((a, c) => a + c.amountCents, 0)).toBe(100_000);
    expect(feb.every((c) => c.amountCents === 25_000)).toBe(true);
  });
});

describe("deposits, adjustments and payouts", () => {
  it("deposit is tracked separately, refunded and never counted as rent", async () => {
    await openMonth(w, "2026-01");
    const r = w.residents[0]!;
    const dep = await createManualCharge(w.admin, { membershipId: r.membershipId, period: "2026-01", category: "SECURITY_DEPOSIT", amountCents: 20_680, description: "Security deposit" });
    const p = await createPayment(r, { amountCents: 20_680, transferDate: "2026-01-05", includesDeposit: true });
    await verifyPayment(w.admin, p.id, [{ chargeId: dep.id, amountCents: 20_680 }]);
    let s = await getMemberSummary(r, r.membershipId);
    expect(s.depositHeld).toBe(20_680);
    expect(s.months[0]!.confirmed).toBe(0); // income view unaffected
    const overview = await getApartmentOverview(w.admin, "2026-01");
    expect(overview.confirmed).toBe(0);
    await expect(createPayout(w.admin, { membershipId: r.membershipId, kind: "DEPOSIT_REFUND", category: "SECURITY_DEPOSIT", amountCents: 30_000, date: "2026-03-01", description: "Too much" })).rejects.toThrow(/larger/);
    await applyDeposit(w.admin, { membershipId: r.membershipId, depositCategory: "SECURITY_DEPOSIT", amountCents: 680, targetPeriod: "2026-01", targetCategory: "RENT", reason: "Agreed to use part of deposit" });
    await createPayout(w.admin, { membershipId: r.membershipId, kind: "DEPOSIT_REFUND", category: "SECURITY_DEPOSIT", amountCents: 20_000, date: "2026-03-01", description: "Move-out refund" });
    s = await getMemberSummary(r, r.membershipId);
    expect(s.depositHeld).toBe(0);
    expect(s.months[0]!.byCategory.RENT!.outstanding).toBe(19_320);
  });

  it("adjustments change balances explicitly and can be reversed", async () => {
    await openMonth(w, "2026-01");
    const r = w.residents[1]!;
    const adj = await createAdjustment(w.admin, { membershipId: r.membershipId, period: "2026-01", category: "RENT", kind: "SETTLEMENT", amountCents: -709, reason: "Splitwise settlement" });
    expect((await getMemberSummary(r, r.membershipId)).months[0]!.byCategory.RENT!.outstanding).toBe(19_291);
    await reverseAdjustment(w.admin, adj.id, "Entered twice");
    expect((await getMemberSummary(r, r.membershipId)).months[0]!.byCategory.RENT!.outstanding).toBe(20_000);
    await expect(reverseAdjustment(w.admin, adj.id, "again")).rejects.toThrow(/already/);
  });

  it("voiding a paid charge turns its allocations into credit", async () => {
    await openMonth(w, "2026-01");
    const r = w.residents[2]!;
    const elec = await chargeOf(r.membershipId, "2026-01", "ELECTRICITY");
    const p = await createPayment(r, { amountCents: 3_500, transferDate: "2026-01-02" });
    await verifyPayment(w.admin, p.id, [{ chargeId: elec.id, amountCents: 3_500 }]);
    await voidCharge(w.admin, elec.id, "Electricity included in rent this month");
    const s = await getMemberSummary(r, r.membershipId);
    expect(s.unallocatedCredit).toBe(3_500);
    expect(s.months[0]!.byCategory.ELECTRICITY).toBeUndefined();
  });
});
