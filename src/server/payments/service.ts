/**
 * Payment workflow: residents record transfers they made externally; the administrator verifies
 * them and allocates the money to obligations. No money is moved by this application.
 */
import type { PaymentStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { moneyTransaction, prisma, type Tx } from "../db";
import { audit } from "../audit";
import { assertActive, assertAdmin, type Ctx } from "../auth/ctx";
import { rateLimit } from "../auth/rate-limit";
import { badRequest, conflict, forbidden, notFound } from "../errors";
import { suggestAllocations, validateAllocations, type AllocationRequest, type OpenCharge } from "../finance/allocation";
import { formatCents } from "../finance/money";
import { formatPeriod, isPeriod, parseIsoDate } from "../finance/period";
import type { Category } from "../finance/types";
import { absoluteUrl, apartmentAdmins, notify } from "../notifications/notify";
import { simpleEmail } from "../notifications/templates";
import { storeUpload } from "../storage/upload";

const EDITABLE: PaymentStatus[] = ["DRAFT", "CLARIFICATION_REQUESTED"];
const REVIEWABLE: PaymentStatus[] = ["SUBMITTED", "UNDER_REVIEW", "CLARIFICATION_REQUESTED"];

export const paymentInputSchema = z.object({
  amountCents: z.number().int().positive().max(10_000_000),
  transferDate: z.string().refine((s) => parseIsoDate(s) !== null, "Enter a valid date"),
  bank: z.string().trim().max(60).optional(),
  description: z.string().trim().max(500).optional(),
  intendedPeriods: z.array(z.string().refine(isPeriod)).max(24).default([]),
  includesDeposit: z.boolean().default(false),
  includesElectricity: z.boolean().default(false),
  residentNote: z.string().trim().max(1000).optional(),
});
export type PaymentInput = z.input<typeof paymentInputSchema>;

/** Load a payment the caller may see (admin: any in apartment; resident: own). */
export async function getPaymentForCtx(ctx: Ctx, paymentId: string, db: Tx | typeof prisma = prisma) {
  const p = await db.payment.findFirst({
    where: { id: paymentId, apartmentId: ctx.apartmentId, ...(ctx.isAdmin ? {} : { membershipId: ctx.membershipId }) },
    include: {
      membership: { select: { id: true, displayName: true, userId: true } },
      allocations: { include: { charge: { include: { period: { select: { period: true } } } } }, orderBy: { createdAt: "asc" } },
      evidence: { include: { file: { select: { id: true, originalName: true, mimeType: true, sizeBytes: true, scanStatus: true, createdAt: true } } } },
    },
  });
  if (!p) throw notFound();
  return p;
}

/** Open FINAL charges of a member, with what is already covered by verified payments. */
export async function openChargesFor(db: Tx | typeof prisma, membershipId: string, excludePaymentId?: string): Promise<OpenCharge[]> {
  const charges = await db.charge.findMany({
    where: { membershipId, status: "FINAL" },
    include: {
      period: { select: { period: true } },
      allocations: { where: { state: "ACTIVE", payment: { status: "VERIFIED" }, ...(excludePaymentId ? { paymentId: { not: excludePaymentId } } : {}) }, select: { amountCents: true } },
    },
  });
  return charges.map((c) => ({
    id: c.id, membershipId: c.membershipId, period: c.period.period, category: c.category as Category, amountCents: c.amountCents, status: c.status,
    alreadyAllocatedCents: c.allocations.reduce((a, x) => a + x.amountCents, 0),
  }));
}

async function replaceProposedAllocations(tx: Tx, ctx: Ctx, payment: { id: string; membershipId: string; amountCents: number; intendedPeriods: string[]; includesDeposit: boolean }, requested?: AllocationRequest[]) {
  await tx.allocation.deleteMany({ where: { paymentId: payment.id, state: "PROPOSED" } });
  const open = await openChargesFor(tx, payment.membershipId, payment.id);
  const allocations = requested ?? suggestAllocations(payment.amountCents, open, { periods: payment.intendedPeriods, includeDeposit: payment.includesDeposit }).allocations;
  const errors = validateAllocations(payment, allocations, open);
  if (errors.length) throw badRequest(errors[0]!);
  if (allocations.length) {
    await tx.allocation.createMany({ data: allocations.map((a) => ({ paymentId: payment.id, chargeId: a.chargeId, amountCents: a.amountCents, state: "PROPOSED" as const, createdById: ctx.userId })) });
  }
}

/** Resident records a transfer (draft or straight to submitted). Admins may record for any member. */
export async function createPayment(ctx: Ctx, raw: PaymentInput, opts: { submit: boolean; membershipId?: string; allocations?: AllocationRequest[] } = { submit: true }) {
  assertActive(ctx);
  await rateLimit(`payment-create:${ctx.userId}`, 30, 3600);
  const input = paymentInputSchema.parse(raw);
  let membershipId = ctx.membershipId;
  let source: "APP" | "ADMIN_ENTRY" = "APP";
  if (opts.membershipId && opts.membershipId !== ctx.membershipId) {
    assertAdmin(ctx);
    const m = await prisma.membership.findFirst({ where: { id: opts.membershipId, apartmentId: ctx.apartmentId } });
    if (!m) throw notFound();
    membershipId = m.id;
    source = "ADMIN_ENTRY";
  }
  const payment = await moneyTransaction(async (tx) => {
    const p = await tx.payment.create({
      data: {
        apartmentId: ctx.apartmentId, membershipId, amountCents: input.amountCents, transferDate: parseIsoDate(input.transferDate)!, bank: input.bank || null,
        description: input.description || null, intendedPeriods: input.intendedPeriods, includesDeposit: input.includesDeposit, includesElectricity: input.includesElectricity,
        residentNote: input.residentNote || null, status: opts.submit ? "SUBMITTED" : "DRAFT", submittedAt: opts.submit ? new Date() : null, source, createdById: ctx.userId,
      },
    });
    await replaceProposedAllocations(tx, ctx, p, opts.allocations);
    await audit(tx, {
      apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: opts.submit ? "payment.submitted" : "payment.drafted", entityType: "Payment", entityId: p.id, membershipId,
      summary: `${ctx.displayName} ${opts.submit ? "submitted" : "drafted"} a payment of ${formatCents(input.amountCents)}${source === "ADMIN_ENTRY" ? " on behalf of a resident" : ""}`,
      after: { amountCents: input.amountCents, transferDate: input.transferDate, intendedPeriods: input.intendedPeriods },
    });
    return p;
  });
  if (opts.submit) await notifyAdminsOfSubmission(ctx, payment.id);
  return payment;
}

export async function updatePayment(ctx: Ctx, paymentId: string, raw: PaymentInput, opts: { submit: boolean; allocations?: AllocationRequest[] }) {
  const input = paymentInputSchema.parse(raw);
  const existing = await getPaymentForCtx(ctx, paymentId);
  if (existing.membershipId !== ctx.membershipId && !ctx.isAdmin) throw notFound();
  if (!EDITABLE.includes(existing.status)) throw conflict("This payment can no longer be edited.");
  await moneyTransaction(async (tx) => {
    const p = await tx.payment.update({
      where: { id: paymentId },
      data: {
        amountCents: input.amountCents, transferDate: parseIsoDate(input.transferDate)!, bank: input.bank || null, description: input.description || null,
        intendedPeriods: input.intendedPeriods, includesDeposit: input.includesDeposit, includesElectricity: input.includesElectricity, residentNote: input.residentNote || null,
        ...(opts.submit ? { status: "SUBMITTED", submittedAt: new Date() } : {}),
      },
    });
    await replaceProposedAllocations(tx, ctx, p, opts.allocations);
    await audit(tx, {
      apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: opts.submit ? "payment.resubmitted" : "payment.updated", entityType: "Payment", entityId: p.id, membershipId: p.membershipId,
      summary: `${ctx.displayName} ${opts.submit ? (existing.status === "CLARIFICATION_REQUESTED" ? "answered a clarification request on" : "submitted") : "updated"} a payment of ${formatCents(p.amountCents)}`,
      before: { amountCents: existing.amountCents, status: existing.status }, after: { amountCents: p.amountCents, status: p.status },
    });
  });
  if (opts.submit) await notifyAdminsOfSubmission(ctx, paymentId);
}

export async function deleteDraftPayment(ctx: Ctx, paymentId: string) {
  const p = await getPaymentForCtx(ctx, paymentId);
  if (p.status !== "DRAFT") throw conflict("Only drafts can be deleted.");
  if (p.membershipId !== ctx.membershipId && !ctx.isAdmin) throw notFound();
  await prisma.$transaction([
    prisma.allocation.deleteMany({ where: { paymentId } }),
    prisma.paymentEvidence.deleteMany({ where: { paymentId } }),
    prisma.payment.delete({ where: { id: paymentId } }),
  ]);
}

/** Attach evidence. Only the payer (or an admin) can attach, and only while the payment is open. */
export async function attachEvidence(ctx: Ctx, paymentId: string, file: File) {
  await rateLimit(`upload:${ctx.userId}`, 40, 3600);
  const p = await getPaymentForCtx(ctx, paymentId);
  if (!ctx.isAdmin && p.membershipId !== ctx.membershipId) throw notFound();
  if (!ctx.isAdmin && !["DRAFT", "SUBMITTED", "UNDER_REVIEW", "CLARIFICATION_REQUESTED"].includes(p.status)) throw conflict("Evidence can't be added to a closed payment.");
  if (p.evidence.length >= 5) throw badRequest("A payment can have at most 5 files.");
  const stored = await storeUpload({ apartmentId: ctx.apartmentId, uploadedById: ctx.userId, ownerMembershipId: p.membershipId, purpose: "PAYMENT_EVIDENCE", file });
  await prisma.$transaction(async (tx) => {
    await tx.paymentEvidence.create({ data: { paymentId, fileId: stored.id } });
    await audit(tx, { apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: "payment.evidence_added", entityType: "Payment", entityId: paymentId, membershipId: p.membershipId, summary: `Evidence uploaded for a payment of ${formatCents(p.amountCents)}` });
  });
  return stored;
}

export async function removeEvidence(ctx: Ctx, paymentId: string, fileId: string) {
  const p = await getPaymentForCtx(ctx, paymentId);
  if (!ctx.isAdmin && (p.membershipId !== ctx.membershipId || !EDITABLE.includes(p.status) && p.status !== "SUBMITTED")) throw forbidden("Evidence can only be removed before review.");
  const link = p.evidence.find((e) => e.fileId === fileId);
  if (!link) throw notFound();
  await prisma.$transaction(async (tx) => {
    await tx.paymentEvidence.delete({ where: { id: link.id } });
    await tx.fileObject.update({ where: { id: fileId }, data: { deletedAt: new Date() } });
    await audit(tx, { apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: "payment.evidence_removed", entityType: "Payment", entityId: paymentId, membershipId: p.membershipId, summary: "Evidence removed from a payment" });
  });
}

async function notifyAdminsOfSubmission(ctx: Ctx, paymentId: string) {
  const p = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { membership: true } });
  for (const a of await apartmentAdmins(prisma, ctx.apartmentId)) {
    if (a.userId === p.membership.userId) continue;
    await notify(prisma, {
      apartmentId: ctx.apartmentId, userId: a.userId, type: "PAYMENT_SUBMITTED", link: `/payments/${p.id}`,
      title: `${p.membership.displayName} submitted ${formatCents(p.amountCents)}`,
      body: p.intendedPeriods.length ? `For ${p.intendedPeriods.map((x) => formatPeriod(x)).join(", ")}` : "Waiting for your review.",
      dedupeKey: `payment-submitted:${p.id}:${p.submittedAt?.getTime() ?? 0}:${a.id}`,
      email: (u) => simpleEmail({ name: u.name, subject: `Payment to review: ${p.membership.displayName}, ${formatCents(p.amountCents)}`, lines: [`${p.membership.displayName} submitted a payment of ${formatCents(p.amountCents)} that needs verification.`], url: absoluteUrl(`/payments/${p.id}`), action: "Review payment" }),
    });
  }
}

// ───────────── Administrator review ─────────────

/** Guard against verifying your own payment while another administrator could do it. */
async function assertMayReview(tx: Tx, ctx: Ctx, payment: { membershipId: string }) {
  assertAdmin(ctx);
  if (payment.membershipId !== ctx.membershipId) return { selfReview: false };
  const otherAdmins = await tx.membership.count({ where: { apartmentId: ctx.apartmentId, role: "ADMIN", status: "ACTIVE", id: { not: ctx.membershipId }, user: { status: "ACTIVE" } } });
  if (otherAdmins > 0) throw forbidden("Another administrator must verify your own payments.");
  return { selfReview: true };
}

export async function markUnderReview(ctx: Ctx, paymentId: string) {
  assertAdmin(ctx);
  await prisma.$transaction(async (tx) => {
    const p = await getPaymentForCtx(ctx, paymentId, tx);
    if (p.status !== "SUBMITTED") return;
    await tx.payment.update({ where: { id: p.id }, data: { status: "UNDER_REVIEW" } });
    await audit(tx, { apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: "payment.under_review", entityType: "Payment", entityId: p.id, membershipId: p.membershipId, summary: `Payment of ${formatCents(p.amountCents)} is under review` });
  });
}

/**
 * Verify a payment and make its allocations ACTIVE. Runs in a serializable transaction and
 * re-validates every allocation against the latest data (no over-allocation, own charges only).
 */
export async function verifyPayment(ctx: Ctx, paymentId: string, allocations: AllocationRequest[], adminNote?: string) {
  const result = await moneyTransaction(async (tx) => {
    const p = await getPaymentForCtx(ctx, paymentId, tx);
    if (!REVIEWABLE.includes(p.status)) throw conflict(`A ${p.status.toLowerCase().replace("_", " ")} payment can't be verified.`);
    const { selfReview } = await assertMayReview(tx, ctx, p);
    const open = await openChargesFor(tx, p.membershipId, p.id);
    const errors = validateAllocations(p, allocations, open);
    if (errors.length) throw badRequest(errors[0]!);
    await tx.allocation.deleteMany({ where: { paymentId: p.id, state: "PROPOSED" } });
    if (allocations.length) {
      await tx.allocation.createMany({
        data: allocations.map((a) => ({ paymentId: p.id, chargeId: a.chargeId, amountCents: a.amountCents, state: "ACTIVE" as const, activatedAt: new Date(), createdById: ctx.userId })),
      });
    }
    const allocated = allocations.reduce((a, x) => a + x.amountCents, 0);
    await tx.payment.update({ where: { id: p.id }, data: { status: "VERIFIED", reviewedAt: new Date(), reviewedById: ctx.userId, adminNote: adminNote || p.adminNote, clarificationMessage: null } });
    await audit(tx, {
      apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: selfReview ? "payment.self_verified" : "payment.verified", entityType: "Payment", entityId: p.id, membershipId: p.membershipId, isPublic: false,
      summary: `Payment of ${formatCents(p.amountCents)} from ${p.membership.displayName} verified${selfReview ? " (self-verified by the only administrator)" : ""}`,
      before: { status: p.status }, after: { status: "VERIFIED", allocations, unallocatedCents: p.amountCents - allocated }, reason: adminNote,
    });
    return { payment: p, allocated };
  });
  const p = result.payment;
  await notify(prisma, {
    apartmentId: ctx.apartmentId, userId: p.membership.userId, type: "PAYMENT_VERIFIED", link: `/payments/${p.id}`,
    title: `Payment of ${formatCents(p.amountCents)} verified`,
    body: result.allocated < p.amountCents ? `${formatCents(p.amountCents - result.allocated)} is kept as credit on your account.` : "Your balance has been updated.",
    dedupeKey: `payment-verified:${p.id}`,
    email: (u) => simpleEmail({ name: u.name, subject: `Payment verified: ${formatCents(p.amountCents)}`, lines: [`Your transfer of ${formatCents(p.amountCents)} from ${p.transferDate.toISOString().slice(0, 10)} was verified.`, result.allocated < p.amountCents ? `${formatCents(p.amountCents - result.allocated)} was not needed for current charges and is kept as credit.` : "Your balance has been updated."], url: absoluteUrl(`/payments/${p.id}`) }),
  });
}

export async function rejectPayment(ctx: Ctx, paymentId: string, reason: string) {
  if (!reason.trim()) throw badRequest("Tell the resident why the payment was rejected.");
  const p = await prisma.$transaction(async (tx) => {
    const p = await getPaymentForCtx(ctx, paymentId, tx);
    if (!REVIEWABLE.includes(p.status)) throw conflict("Only payments awaiting review can be rejected.");
    await assertMayReview(tx, ctx, p);
    await tx.allocation.deleteMany({ where: { paymentId: p.id, state: "PROPOSED" } });
    await tx.payment.update({ where: { id: p.id }, data: { status: "REJECTED", rejectionReason: reason, reviewedAt: new Date(), reviewedById: ctx.userId } });
    await audit(tx, { apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: "payment.rejected", entityType: "Payment", entityId: p.id, membershipId: p.membershipId, summary: `Payment of ${formatCents(p.amountCents)} from ${p.membership.displayName} rejected`, reason });
    return p;
  });
  await notify(prisma, {
    apartmentId: ctx.apartmentId, userId: p.membership.userId, type: "PAYMENT_REJECTED", link: `/payments/${p.id}`,
    title: `Payment of ${formatCents(p.amountCents)} rejected`, body: reason, dedupeKey: `payment-rejected:${p.id}`,
    email: (u) => simpleEmail({ name: u.name, subject: "A payment record was rejected", lines: [`Your payment record of ${formatCents(p.amountCents)} was rejected.`, `Reason: ${reason}`], url: absoluteUrl(`/payments/${p.id}`) }),
  });
}

export async function requestClarification(ctx: Ctx, paymentId: string, message: string) {
  if (!message.trim()) throw badRequest("Write what you need to know.");
  const p = await prisma.$transaction(async (tx) => {
    const p = await getPaymentForCtx(ctx, paymentId, tx);
    if (!["SUBMITTED", "UNDER_REVIEW"].includes(p.status)) throw conflict("Clarification can only be requested for payments awaiting review.");
    await assertMayReview(tx, ctx, p);
    await tx.payment.update({ where: { id: p.id }, data: { status: "CLARIFICATION_REQUESTED", clarificationMessage: message, reviewedById: ctx.userId } });
    await audit(tx, { apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: "payment.clarification_requested", entityType: "Payment", entityId: p.id, membershipId: p.membershipId, summary: `Clarification requested on a payment of ${formatCents(p.amountCents)}`, reason: message });
    return p;
  });
  await notify(prisma, {
    apartmentId: ctx.apartmentId, userId: p.membership.userId, type: "CLARIFICATION_REQUESTED", link: `/payments/${p.id}`,
    title: "Clarification requested", body: message, dedupeKey: `payment-clarify:${p.id}:${Date.now()}`,
    email: (u) => simpleEmail({ name: u.name, subject: "Question about your payment", lines: [`The administrator has a question about your payment of ${formatCents(p.amountCents)}:`, message], url: absoluteUrl(`/payments/${p.id}`), action: "Answer" }),
  });
}

/** Reverse a verified payment. Its allocations are reversed; the original record is kept. */
export async function reversePayment(ctx: Ctx, paymentId: string, reason: string) {
  if (!reason.trim()) throw badRequest("Enter a reason for the reversal.");
  await moneyTransaction(async (tx) => {
    const p = await getPaymentForCtx(ctx, paymentId, tx);
    if (p.status !== "VERIFIED") throw conflict("Only verified payments can be reversed.");
    await assertMayReview(tx, ctx, p);
    const n = await tx.allocation.updateMany({ where: { paymentId: p.id, state: "ACTIVE" }, data: { state: "REVERSED", reversedAt: new Date(), reversedById: ctx.userId, reversalReason: reason } });
    await tx.payment.update({ where: { id: p.id }, data: { status: "REVERSED", reversedAt: new Date(), reversedById: ctx.userId, reversalReason: reason } });
    await audit(tx, {
      apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: "payment.reversed", entityType: "Payment", entityId: p.id, membershipId: p.membershipId,
      summary: `Verified payment of ${formatCents(p.amountCents)} from ${p.membership.displayName} reversed`, before: { status: "VERIFIED" }, after: { status: "REVERSED", allocationsReversed: n.count }, reason,
    });
  });
}

/** Change how a verified payment is allocated: old allocations are reversed, new ones created. */
export async function reallocatePayment(ctx: Ctx, paymentId: string, allocations: AllocationRequest[], reason: string) {
  if (!reason.trim()) throw badRequest("Enter a reason for the change.");
  await moneyTransaction(async (tx) => {
    const p = await getPaymentForCtx(ctx, paymentId, tx);
    if (p.status !== "VERIFIED") throw conflict("Only verified payments can be reallocated.");
    await assertMayReview(tx, ctx, p);
    const open = await openChargesFor(tx, p.membershipId, p.id);
    const errors = validateAllocations(p, allocations, open);
    if (errors.length) throw badRequest(errors[0]!);
    const before = p.allocations.filter((a) => a.state === "ACTIVE").map((a) => ({ chargeId: a.chargeId, amountCents: a.amountCents }));
    await tx.allocation.updateMany({ where: { paymentId: p.id, state: "ACTIVE" }, data: { state: "REVERSED", reversedAt: new Date(), reversedById: ctx.userId, reversalReason: reason } });
    if (allocations.length) {
      await tx.allocation.createMany({ data: allocations.map((a) => ({ paymentId: p.id, chargeId: a.chargeId, amountCents: a.amountCents, state: "ACTIVE" as const, activatedAt: new Date(), createdById: ctx.userId })) });
    }
    await audit(tx, {
      apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: "payment.reallocated", entityType: "Payment", entityId: p.id, membershipId: p.membershipId,
      summary: `Allocation of a ${formatCents(p.amountCents)} payment from ${p.membership.displayName} corrected`, before, after: allocations, reason,
    });
  });
}

export const listFilterSchema = z.object({
  status: z.enum(["DRAFT", "SUBMITTED", "UNDER_REVIEW", "CLARIFICATION_REQUESTED", "VERIFIED", "REJECTED", "REVERSED", "OPEN"]).optional(),
  membershipId: z.string().optional(),
});

export async function listPayments(ctx: Ctx, raw: z.input<typeof listFilterSchema> = {}) {
  const f = listFilterSchema.parse(raw);
  const where: Prisma.PaymentWhereInput = { apartmentId: ctx.apartmentId };
  if (!ctx.isAdmin) where.membershipId = ctx.membershipId;
  else if (f.membershipId) where.membershipId = f.membershipId;
  if (f.status === "OPEN") where.status = { in: REVIEWABLE };
  else if (f.status) where.status = f.status;
  return prisma.payment.findMany({
    where,
    include: { membership: { select: { displayName: true } }, _count: { select: { evidence: true } }, allocations: { where: { state: { in: ["ACTIVE", "PROPOSED"] } }, select: { amountCents: true, state: true } } },
    orderBy: [{ transferDate: "desc" }, { createdAt: "desc" }],
    take: 500,
  });
}
