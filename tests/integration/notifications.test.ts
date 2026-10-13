import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { runReminders, reminderKindForOffset } from "@/server/notifications/reminders";
import { processOutbox } from "@/server/notifications/email";
import { publishRule, saveDraftRule } from "@/server/finance/admin";
import { createDocument, addVersion, acknowledgeDocument, getDocument } from "@/server/documents/service";
import { createPayment, verifyPayment } from "@/server/payments/service";
import { setPreferences } from "@/server/notifications/queries";
import { chargeOf, createWorld, fakeFile, openMonth, PDF_BYTES, resetDb, standardPricing, type World } from "./fixtures";

let w: World;

/** 09:30 Berlin time on a given day (after the default send hour). */
const at = (isoDay: string) => new Date(`${isoDay}T08:30:00Z`);

beforeEach(async () => {
  await resetDb();
  w = await createWorld();
  await standardPricing(w);
  await prisma.reminderSchedule.create({ data: { apartmentId: w.apartmentId, daysBeforeDue: [3], onDueDate: true, daysAfterDue: [5], repeatEveryDays: null } });
});

describe("reminder schedule", () => {
  it("maps offsets to reminder kinds", () => {
    const s = { daysBeforeDue: [3], onDueDate: true, daysAfterDue: [3, 7], repeatEveryDays: 7 };
    expect(reminderKindForOffset(s, -3)).toBe("upcoming");
    expect(reminderKindForOffset(s, -2)).toBeNull();
    expect(reminderKindForOffset(s, 0)).toBe("due");
    expect(reminderKindForOffset(s, 3)).toBe("overdue");
    expect(reminderKindForOffset(s, 14)).toBe("overdue");
    expect(reminderKindForOffset(s, 15)).toBeNull();
  });
});

describe("rent reminders", () => {
  it("sends to the right residents only, skips fully paid, and never duplicates", async () => {
    await openMonth(w, "2026-03"); // due 2026-03-01
    const payer = w.residents[0]!;
    const charges = await prisma.charge.findMany({ where: { membershipId: payer.membershipId } });
    const p = await createPayment(payer, { amountCents: 23_500, transferDate: "2026-02-25" });
    await verifyPayment(w.admin, p.id, charges.map((c) => ({ chargeId: c.id, amountCents: c.amountCents })));

    const first = await runReminders(at("2026-02-26")); // 3 days before
    expect(first.queued).toBe(4);
    const mails = await prisma.emailDelivery.findMany({ where: { kind: "REMINDER" } });
    expect(mails.map((m) => m.toEmail).sort()).toEqual(["hanna@example.test", "lena@example.test", "mia@example.test", "omar@example.test"]);
    expect(mails.some((m) => m.toEmail === payer.email)).toBe(false);
    const skipped = await prisma.reminderRun.findFirstOrThrow({ where: { membershipId: payer.membershipId } });
    expect(skipped.outcome).toBe("SKIPPED");

    const again = await runReminders(at("2026-02-26"));
    expect(again.queued).toBe(0);
    expect(again.duplicates).toBeGreaterThan(0);
    expect(await prisma.emailDelivery.count({ where: { kind: "REMINDER" } })).toBe(4);
    expect(await runReminders(new Date("2026-02-26T05:00:00Z"))).toMatchObject({ evaluated: 0 }); // before send hour
  });

  it("includes the correct overdue amount with a month-by-month breakdown and no other residents' data", async () => {
    await openMonth(w, "2026-01");
    await openMonth(w, "2026-02");
    const r = w.residents[1]!;
    const rent = await chargeOf(r.membershipId, "2026-01", "RENT");
    const p = await createPayment(r, { amountCents: 15_000, transferDate: "2026-01-02" });
    await verifyPayment(w.admin, p.id, [{ chargeId: rent.id, amountCents: 15_000 }]);
    await runReminders(at("2026-02-06")); // 5 days after the Feb due date
    const mail = await prisma.emailDelivery.findFirstOrThrow({ where: { kind: "REMINDER", toEmail: r.email } });
    mail.text = mail.text.replace(/ /g, " "); // Intl uses a no-break space before "€"
    expect(mail.subject).toMatch(/Overdue balance: 320,00/); // Jan 85.00 + Feb 235.00
    expect(mail.text).toContain("January 2026: due 235,00 €, confirmed 150,00 €, outstanding 85,00 €");
    expect(mail.text).toContain("February 2026");
    for (const other of w.all.filter((c) => c.membershipId !== r.membershipId)) expect(mail.html).not.toContain(other.displayName);
    const inApp = await prisma.notification.findFirst({ where: { userId: r.userId, type: "RENT_OVERDUE" } });
    expect(inApp).not.toBeNull();
  });

  it("records SENT / FAILED delivery outcomes", async () => {
    await openMonth(w, "2026-03");
    await runReminders(at("2026-02-26"));
    let calls = 0;
    const res = await processOutbox({ sender: async () => { if (calls++ === 0) throw new Error("smtp down"); } });
    expect(res.failed).toBe(1);
    expect(res.sent).toBeGreaterThan(0);
    const failed = await prisma.emailDelivery.findFirstOrThrow({ where: { lastError: "smtp down" } });
    expect(failed.status).toBe("PENDING"); // will be retried with backoff
  });

  it("respects email preferences but keeps the in-app notification", async () => {
    await openMonth(w, "2026-03");
    const r = w.residents[2]!;
    await setPreferences(r, { RENT_DUE_SOON: false, ACCOUNT_SECURITY: false });
    await runReminders(at("2026-02-26"));
    const mail = await prisma.emailDelivery.findFirstOrThrow({ where: { toEmail: r.email, kind: "REMINDER" } });
    expect(mail.status).toBe("SKIPPED");
    expect(await prisma.notification.count({ where: { userId: r.userId, type: "RENT_DUE_SOON" } })).toBeGreaterThan(0);
    // Essential security notifications cannot be disabled.
    expect(await prisma.notificationPreference.findFirst({ where: { userId: r.userId, type: "ACCOUNT_SECURITY" } })).toBeNull();
  });
});

describe("price change and document notifications", () => {
  it("notifies every resident with previous and new amounts", async () => {
    const rule = await prisma.chargeRule.findFirstOrThrow({ where: { category: "RENT", status: "PUBLISHED" } });
    const d = await saveDraftRule(w.admin, { name: "Rent 2026-06", category: "RENT", method: "EQUAL_SPLIT", totalAmountCents: 110_000, perMemberAmountCents: null, effectiveFrom: "2026-06", previousRuleId: rule.id, shares: [] });
    await publishRule(w.admin, d.id, { reason: "Landlord's rent increase letter", notifyResidents: true });
    const mails = await prisma.emailDelivery.findMany({ where: { kind: "RENT_PRICE_UPDATED" } });
    expect(mails).toHaveLength(5);
    expect(mails[0]!.text).toContain("Previous amount: 200,00");
    expect(mails[0]!.text).toContain("New amount: 220,00");
    expect(mails[0]!.text).toContain("Landlord's rent increase letter");
    expect(await prisma.notification.count({ where: { type: "RENT_PRICE_UPDATED" } })).toBe(5);
  });

  it("notifies residents of a new contract, keeps versions and records acknowledgements", async () => {
    const doc = await createDocument(w.admin, { title: "Rental agreement", category: "RENTAL_AGREEMENT", visibility: "ALL_RESIDENTS", requiresAck: true }, { effectiveDate: "2024-06-01" }, fakeFile(PDF_BYTES, "lease-v1.pdf"), true);
    expect(await prisma.notification.count({ where: { type: "DOCUMENT_PUBLISHED" } })).toBe(4); // not the publishing admin
    await acknowledgeDocument(w.residents[0]!, doc.id);
    await addVersion(w.admin, doc.id, { effectiveDate: "2026-07-01", changeSummary: "Rent increased; new house rules" }, fakeFile(PDF_BYTES, "lease-v2.pdf"), true);
    const full = await getDocument(w.admin, doc.id);
    expect(full.versions.map((v) => v.versionNumber)).toEqual([2, 1]);
    expect(full.currentVersionId).toBe(full.versions[0]!.id);
    expect(full.versions[1]!.acknowledgements).toHaveLength(1); // ack belongs to v1, v2 needs a new one
    expect(await prisma.notification.count({ where: { type: "DOCUMENT_PUBLISHED" } })).toBe(8);
  });
});
