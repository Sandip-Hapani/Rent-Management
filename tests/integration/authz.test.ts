import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { createManualCharge, generatePeriod, publishRule, saveDraftRule, updateApartmentSettings } from "@/server/finance/admin";
import { getMemberSummary, getMonthDetail, getApartmentOverview } from "@/server/finance/queries";
import { attachEvidence, createPayment, getPaymentForCtx, listPayments, updatePayment, verifyPayment } from "@/server/payments/service";
import { authorizeFileAccess } from "@/server/storage/access";
import { createDocument, getDocument, listDocuments } from "@/server/documents/service";
import { buildReport, buildStatement } from "@/server/reports/service";
import { acceptInvite, inviteResident, login, requestPasswordReset, resetPassword, setAccountActive } from "@/server/auth/service";
import { validateSessionToken, createSession } from "@/server/auth/session";
import { hashPassword, sha256 } from "@/server/auth/crypto";
import { getBatch } from "@/server/imports/service";
import { createWorld, fakeFile, openMonth, PDF_BYTES, PNG_BYTES, resetDb, standardPricing, type World } from "./fixtures";

let w: World;

beforeEach(async () => {
  await resetDb();
  w = await createWorld();
  await standardPricing(w);
  await openMonth(w, "2026-01");
});

describe("resident data isolation", () => {
  it("a resident cannot view another resident's statement, summary or month detail", async () => {
    const [a, b] = w.residents;
    await expect(getMemberSummary(a!, b!.membershipId)).rejects.toThrow(/Not found/);
    await expect(getMonthDetail(a!, b!.membershipId, "2026-01")).rejects.toThrow(/Not found/);
    await expect(buildStatement(a!, b!.membershipId, {})).rejects.toThrow(/Not found/);
    await expect(getMemberSummary(a!, a!.membershipId)).resolves.toBeTruthy();
    await expect(getMemberSummary(w.admin, b!.membershipId)).resolves.toBeTruthy();
  });

  it("residents see apartment totals but no per-resident rows", async () => {
    const o = await getApartmentOverview(w.residents[0]!);
    expect(o.members).toEqual([]);
    expect((await getApartmentOverview(w.admin)).members.length).toBe(5);
  });

  it("a resident cannot read or edit another resident's payment", async () => {
    const [a, b] = w.residents;
    const p = await createPayment(a!, { amountCents: 1_000, transferDate: "2026-01-02" }, { submit: false });
    await expect(getPaymentForCtx(b!, p.id)).rejects.toThrow(/Not found/);
    await expect(updatePayment(b!, p.id, { amountCents: 1, transferDate: "2026-01-02" }, { submit: true })).rejects.toThrow(/Not found/);
    expect((await listPayments(b!)).length).toBe(0);
    expect((await listPayments(w.admin)).length).toBe(1);
  });

  it("a resident cannot submit a payment on behalf of someone else", async () => {
    const [a, b] = w.residents;
    await expect(createPayment(a!, { amountCents: 1_000, transferDate: "2026-01-02" }, { submit: true, membershipId: b!.membershipId })).rejects.toThrow(/permission/);
  });
});

describe("verification rights", () => {
  it("a resident cannot verify any payment, including their own", async () => {
    const r = w.residents[0]!;
    const p = await createPayment(r, { amountCents: 1_000, transferDate: "2026-01-02" });
    await expect(verifyPayment(r, p.id, [])).rejects.toThrow();
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("SUBMITTED");
  });

  it("an admin cannot verify their own payment while another admin exists", async () => {
    await prisma.membership.update({ where: { id: w.residents[0]!.membershipId }, data: { role: "ADMIN" } });
    const p = await createPayment(w.admin, { amountCents: 1_000, transferDate: "2026-01-02" });
    await expect(verifyPayment(w.admin, p.id, [])).rejects.toThrow(/Another administrator/);
  });
});

describe("administrator-only operations", () => {
  it("a resident cannot change prices, generate months, add charges, change settings or read reports", async () => {
    const r = w.residents[0]!;
    await expect(saveDraftRule(r, { name: "x", category: "RENT", method: "FIXED_PER_MEMBER", totalAmountCents: null, perMemberAmountCents: 1, effectiveFrom: "2026-05", shares: [] })).rejects.toThrow(/permission/);
    const rule = await prisma.chargeRule.findFirstOrThrow();
    await expect(publishRule(r, rule.id, { reason: "x", notifyResidents: false })).rejects.toThrow(/permission/);
    await expect(generatePeriod(r, "2026-02")).rejects.toThrow(/permission/);
    await expect(createManualCharge(r, { membershipId: r.membershipId, period: "2026-01", category: "OTHER", amountCents: 1, description: "x" })).rejects.toThrow(/permission/);
    await expect(updateApartmentSettings(r, { name: "x", rentDueDay: 1, graceDays: 1, maxUploadMb: 5 })).rejects.toThrow(/permission/);
    await expect(buildReport(r, "ledger", {})).rejects.toThrow(/permission/);
    await expect(inviteResident(r, { email: "x@example.test", name: "X", displayName: "X", role: "ADMIN", moveInDate: "2026-01-01" })).rejects.toThrow(/permission/);
    await expect(getBatch(r, "anything")).rejects.toThrow(/permission/);
  });

  it("only administrators can upload and publish documents; residents only see published, visible ones", async () => {
    const r = w.residents[0]!;
    await expect(createDocument(r, { title: "Lease", category: "RENTAL_AGREEMENT", visibility: "ALL_RESIDENTS" }, {}, fakeFile(PDF_BYTES, "lease.pdf"), true)).rejects.toThrow(/permission/);
    const draft = await createDocument(w.admin, { title: "Draft lease", category: "RENTAL_AGREEMENT", visibility: "ALL_RESIDENTS" }, {}, fakeFile(PDF_BYTES, "lease.pdf"), false);
    const secret = await createDocument(w.admin, { title: "Admin notes", category: "OTHER", visibility: "ADMINS_ONLY" }, {}, fakeFile(PDF_BYTES, "n.pdf"), true);
    const selected = await createDocument(w.admin, { title: "Only Ravi", category: "OTHER", visibility: "SELECTED", selectedMembershipIds: [w.residents[0]!.membershipId] }, {}, fakeFile(PDF_BYTES, "s.pdf"), true);
    const pub = await createDocument(w.admin, { title: "House rules", category: "OTHER", visibility: "ALL_RESIDENTS" }, {}, fakeFile(PDF_BYTES, "rules.pdf"), true);
    expect((await listDocuments(r)).map((d) => d.title).sort()).toEqual(["House rules", "Only Ravi"]);
    expect((await listDocuments(w.residents[1]!)).map((d) => d.title)).toEqual(["House rules"]);
    await expect(getDocument(r, draft.id)).rejects.toThrow(/Not found/);
    await expect(getDocument(r, secret.id)).rejects.toThrow(/Not found/);
    await expect(getDocument(w.residents[1]!, selected.id)).rejects.toThrow(/Not found/);
    const file = (await getDocument(r, pub.id)).versions[0]!.file;
    await expect(authorizeFileAccess(r, file.id)).resolves.toBeTruthy();
    const draftFile = await prisma.documentVersion.findFirstOrThrow({ where: { documentId: draft.id } });
    await expect(authorizeFileAccess(r, draftFile.fileId)).rejects.toThrow(/Not found/);
  });
});

describe("files", () => {
  it("a resident cannot download another resident's receipt; admin can", async () => {
    const [a, b] = w.residents;
    const p = await createPayment(a!, { amountCents: 1_000, transferDate: "2026-01-02" });
    const stored = await attachEvidence(a!, p.id, fakeFile(PNG_BYTES, "receipt.png", "image/png"));
    await expect(authorizeFileAccess(a!, stored.id)).resolves.toBeTruthy();
    await expect(authorizeFileAccess(b!, stored.id)).rejects.toThrow(/Not found/);
    await expect(authorizeFileAccess(w.admin, stored.id)).resolves.toBeTruthy();
    await expect(attachEvidence(b!, p.id, fakeFile(PNG_BYTES, "x.png"))).rejects.toThrow(/Not found/);
  });

  it("rejects files whose content is not an allowed type, regardless of name", async () => {
    const a = w.residents[0]!;
    const p = await createPayment(a, { amountCents: 1_000, transferDate: "2026-01-02" });
    await expect(attachEvidence(a, p.id, fakeFile(Buffer.from("<script>alert(1)</script>"), "receipt.pdf", "application/pdf"))).rejects.toThrow(/Only PDF/);
    await prisma.apartment.update({ where: { id: w.apartmentId }, data: { maxUploadBytes: 10 } });
    await expect(attachEvidence(a, p.id, fakeFile(PDF_BYTES, "big.pdf"))).rejects.toThrow(/too large/);
  });

  it("files of another apartment are invisible", async () => {
    const other = await prisma.apartment.create({ data: { name: "Other" } });
    const f = await prisma.fileObject.create({ data: { apartmentId: other.id, purpose: "DOCUMENT", storageKey: "document/x/y", originalName: "x.pdf", mimeType: "application/pdf", sizeBytes: 1, sha256: "x", scanStatus: "SKIPPED", uploadedById: "u" } });
    await expect(authorizeFileAccess(w.admin, f.id)).rejects.toThrow(/Not found/);
  });
});

describe("authentication", () => {
  it("invite → accept sets a password, verifies email and allows login; wrong password fails", async () => {
    const m = await inviteResident(w.admin, { email: "New.Person@Example.test", name: "New Person", displayName: "Newbie", role: "RESIDENT", moveInDate: "2026-02-01" });
    expect(m.billingStart).toBe("2026-02");
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "new.person@example.test" } });
    expect(user.status).toBe("INVITED");
    const email = await prisma.emailDelivery.findFirstOrThrow({ where: { kind: "INVITE", toEmail: user.email } });
    const token = /\/invite\/([A-Za-z0-9_-]+)/.exec(email.text)![1]!;
    await expect(acceptInvite(token, "short", "127.0.0.1")).rejects.toThrow(/at least/);
    await acceptInvite(token, "correct horse battery staple", "127.0.0.1");
    await expect(acceptInvite(token, "correct horse battery staple", "127.0.0.1")).rejects.toThrow(/invalid or has expired/);
    const active = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(active.status).toBe("ACTIVE");
    expect(active.emailVerifiedAt).not.toBeNull();
    expect(active.passwordHash).not.toContain("correct horse");
    await expect(login("new.person@example.test", "wrong password!!", "127.0.0.2")).rejects.toThrow(/Incorrect/);
    await expect(login("NEW.PERSON@example.test", "correct horse battery staple", "127.0.0.2")).resolves.toBe(user.id);
  });

  it("password reset never reveals whether an email exists and revokes sessions", async () => {
    const r = w.residents[0]!;
    await prisma.user.update({ where: { id: r.userId }, data: { passwordHash: await hashPassword("old password 123") } });
    const { token: sessionToken } = await createSession(r.userId);
    await expect(requestPasswordReset("nobody@example.test", "1.1.1.1")).resolves.toBeUndefined();
    await requestPasswordReset(r.email, "1.1.1.1");
    const mail = await prisma.emailDelivery.findFirstOrThrow({ where: { kind: "PASSWORD_RESET" } });
    const token = /\/reset-password\/([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
    await resetPassword(token, "brand new password 456", "1.1.1.1");
    expect(await validateSessionToken(sessionToken)).toBeNull();
    await expect(login(r.email, "old password 123", "1.1.1.1")).rejects.toThrow();
    await expect(login(r.email, "brand new password 456", "1.1.1.1")).resolves.toBe(r.userId);
  });

  it("deactivated accounts cannot sign in and lose their sessions; the last admin can't be removed", async () => {
    const r = w.residents[1]!;
    await prisma.user.update({ where: { id: r.userId }, data: { passwordHash: await hashPassword("resident pass 789") } });
    const { token } = await createSession(r.userId);
    await setAccountActive(w.admin, r.membershipId, false, "Moved out");
    expect(await validateSessionToken(token)).toBeNull();
    await expect(login(r.email, "resident pass 789", "2.2.2.2")).rejects.toThrow(/not active/);
    await expect(setAccountActive(w.admin, w.admin.membershipId, false, "x")).rejects.toThrow(/own account/);
  });

  it("stores only hashes of session tokens and rate-limits login attempts", async () => {
    const { token } = await createSession(w.admin.userId);
    expect(await prisma.session.findFirst({ where: { tokenHash: token } })).toBeNull();
    expect(await prisma.session.findFirst({ where: { tokenHash: sha256(token) } })).not.toBeNull();
    for (let i = 0; i < 8; i++) await login("hanna@example.test", "bad", "3.3.3.3").catch(() => undefined);
    await expect(login("hanna@example.test", "bad", "3.3.3.3")).rejects.toThrow(/Too many attempts/);
  });
});
