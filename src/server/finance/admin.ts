/**
 * Administrator-only financial mutations: pricing rules, price changes, period generation,
 * manual charges, voids, adjustments, payouts and reconciliation status.
 * Every mutation is transactional and writes an audit event.
 */
import type { ChargeCategory, Prisma } from "@prisma/client";
import { z } from "zod";
import { moneyTransaction, prisma, type Db, type Tx } from "../db";
import { audit } from "../audit";
import { assertAdmin, type Ctx } from "../auth/ctx";
import { badRequest, conflict, notFound } from "../errors";
import { activeResidents, absoluteUrl, notify } from "../notifications/notify";
import { priceChangeEmail } from "../notifications/templates";
import { summarizeMember } from "./ledger";
import { formatCents } from "./money";
import { addMonths, comparePeriods, dueDateFor, formatPeriod, isPeriod, type Period } from "./period";
import { apartmentClock, loadLedgerInput, loadMembers, loadRules, toRuleInput } from "./queries";
import { computeRuleCharges, generatePeriodCharges, previewPriceChange, validateRule } from "./rules";
import { CATEGORIES, CATEGORY_LABELS, type Category } from "./types";

const periodField = z.string().refine(isPeriod, "Use the format YYYY-MM");
const categoryField = z.enum(CATEGORIES);
const centsField = z.number().int().safe();

// ───────────── Periods ─────────────

export async function ensurePeriod(db: Db, apartmentId: string, period: Period) {
  const apartment = await db.apartment.findUniqueOrThrow({ where: { id: apartmentId } });
  return db.financialPeriod.upsert({
    where: { apartmentId_period: { apartmentId, period } },
    create: { apartmentId, period, dueDate: dueDateFor(period, apartment.rentDueDay) },
    update: {},
  });
}

// ───────────── Charge rules & price changes ─────────────

export const ruleSchema = z.object({
  name: z.string().trim().min(1).max(100),
  category: categoryField,
  method: z.enum(["EQUAL_SPLIT", "FIXED_PER_MEMBER", "CUSTOM", "PERCENTAGE"]),
  totalAmountCents: centsField.nonnegative().nullable(),
  perMemberAmountCents: centsField.nonnegative().nullable(),
  effectiveFrom: periodField,
  effectiveTo: periodField.nullable().optional(),
  reason: z.string().trim().max(1000).optional(),
  previousRuleId: z.string().nullable().optional(),
  shares: z.array(z.object({ membershipId: z.string(), amountCents: centsField.nonnegative().nullable(), basisPoints: z.number().int().min(0).max(10_000).nullable() })).default([]),
});

export async function saveDraftRule(ctx: Ctx, raw: z.input<typeof ruleSchema>, ruleId?: string) {
  assertAdmin(ctx);
  const input = ruleSchema.parse(raw);
  const problems = validateRule({ id: "draft", version: 1, ...input, effectiveTo: input.effectiveTo ?? null, shares: input.shares });
  if (problems.length) throw badRequest(problems.join(" "));
  const members = await prisma.membership.findMany({ where: { apartmentId: ctx.apartmentId, id: { in: input.shares.map((s) => s.membershipId) } } });
  if (members.length !== new Set(input.shares.map((s) => s.membershipId)).size) throw badRequest("Unknown resident in rule shares.");

  let version = 1;
  if (input.previousRuleId) {
    const prev = await prisma.chargeRule.findFirst({ where: { id: input.previousRuleId, apartmentId: ctx.apartmentId, status: "PUBLISHED" } });
    if (!prev) throw badRequest("The rule being replaced must be a published rule of this apartment.");
    if (prev.category !== input.category) throw badRequest("A replacement rule must have the same category.");
    if (comparePeriods(input.effectiveFrom, prev.effectiveFrom) <= 0) throw badRequest(`The new price must start after ${formatPeriod(prev.effectiveFrom)}.`);
    version = prev.version + 1;
  }
  const data = {
    name: input.name, category: input.category, method: input.method, totalAmountCents: input.totalAmountCents, perMemberAmountCents: input.perMemberAmountCents,
    effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null, reason: input.reason ?? null, previousRuleId: input.previousRuleId ?? null, version,
  };
  return prisma.$transaction(async (tx) => {
    if (ruleId) {
      const existing = await tx.chargeRule.findFirst({ where: { id: ruleId, apartmentId: ctx.apartmentId } });
      if (!existing) throw notFound();
      if (existing.status !== "DRAFT") throw conflict("Published rules can't be edited. Create a new price version instead.");
      await tx.chargeRuleShare.deleteMany({ where: { ruleId } });
      return tx.chargeRule.update({ where: { id: ruleId }, data: { ...data, shares: { create: input.shares } } });
    }
    return tx.chargeRule.create({ data: { ...data, apartmentId: ctx.apartmentId, createdById: ctx.userId, shares: { create: input.shares } } });
  });
}

export async function deleteDraftRule(ctx: Ctx, ruleId: string) {
  assertAdmin(ctx);
  const rule = await prisma.chargeRule.findFirst({ where: { id: ruleId, apartmentId: ctx.apartmentId } });
  if (!rule) throw notFound();
  if (rule.status !== "DRAFT") throw conflict("Only draft rules can be deleted.");
  await prisma.chargeRule.delete({ where: { id: ruleId } });
}

/** Preview the effect of a draft rule on each resident in its first month. */
export async function previewRule(ctx: Ctx, ruleId: string) {
  assertAdmin(ctx);
  const draft = await prisma.chargeRule.findFirst({ where: { id: ruleId, apartmentId: ctx.apartmentId }, include: { shares: true } });
  if (!draft) throw notFound();
  const [members, published] = await Promise.all([loadMembers(prisma, ctx.apartmentId), loadRules(prisma, ctx.apartmentId, ["PUBLISHED"])]);
  const replaced = published.filter((r) => r.id === draft.previousRuleId);
  const rule = toRuleInput(draft);
  const rows = previewPriceChange(replaced, rule, members, draft.effectiveFrom);
  const result = computeRuleCharges(rule, members, draft.effectiveFrom);
  // Months already finalised under the old price stay unchanged (history is never rewritten).
  const finalizedAfter = await prisma.financialPeriod.findMany({
    where: { apartmentId: ctx.apartmentId, status: "FINALIZED", period: { gte: draft.effectiveFrom } },
    select: { period: true },
  });
  return {
    rule: draft,
    rows,
    warnings: [
      ...result.warnings,
      ...(finalizedAfter.length
        ? [`${finalizedAfter.map((f) => formatPeriod(f.period)).join(", ")} ${finalizedAfter.length === 1 ? "is" : "are"} already finalised and will keep the old amounts. Use adjustments if those months must change.`]
        : []),
    ],
  };
}

/**
 * Publish a draft rule. If it replaces a rule, the old one is closed the month before the new
 * effective date (never edited retroactively). Residents are notified when this is a price change.
 */
export async function publishRule(ctx: Ctx, ruleId: string, opts: { reason: string; notifyResidents: boolean }) {
  assertAdmin(ctx);
  if (!opts.reason.trim()) throw badRequest("Enter the reason for this change.");
  const preview = await previewRule(ctx, ruleId);
  const draft = preview.rule;
  if (draft.status !== "DRAFT") throw conflict("This rule is already published.");

  const result = await prisma.$transaction(async (tx) => {
    let previous = null as null | { id: string; effectiveFrom: string };
    if (draft.previousRuleId) {
      previous = await tx.chargeRule.findFirst({ where: { id: draft.previousRuleId, apartmentId: ctx.apartmentId, status: "PUBLISHED" } });
      if (!previous) throw conflict("The rule being replaced is no longer active.");
      await tx.chargeRule.update({ where: { id: previous.id }, data: { effectiveTo: addMonths(draft.effectiveFrom, -1), status: "SUPERSEDED" } });
    }
    const published = await tx.chargeRule.update({ where: { id: draft.id }, data: { status: "PUBLISHED", publishedAt: new Date(), reason: opts.reason } });
    let priceChangeId: string | null = null;
    if (previous) {
      const label = CATEGORY_LABELS[draft.category as Category];
      const announcement = await tx.announcement.create({
        data: {
          apartmentId: ctx.apartmentId, kind: "PRICE_CHANGE", createdById: ctx.userId,
          title: `${label} changes from ${formatPeriod(draft.effectiveFrom)}`,
          // Per-resident amounts are private; each resident sees only their own row under Price changes.
          body: `${opts.reason}\n\nYour personal before/after amount is listed under Notifications → Price changes. Months before ${formatPeriod(draft.effectiveFrom)} are not affected.`,
        },
      });
      const pc = await tx.priceChange.create({
        data: {
          apartmentId: ctx.apartmentId, category: draft.category, previousRuleId: previous.id, newRuleId: draft.id, effectiveFrom: draft.effectiveFrom,
          reason: opts.reason, summary: preview.rows as unknown as Prisma.InputJsonValue, announcementId: announcement.id, publishedById: ctx.userId,
        },
      });
      priceChangeId = pc.id;
    }
    await audit(tx, {
      apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: previous ? "price.changed" : "rule.published", entityType: "ChargeRule", entityId: draft.id, isPublic: !!previous,
      summary: previous
        ? `${CATEGORY_LABELS[draft.category as Category]} price changed from ${formatPeriod(draft.effectiveFrom)}`
        : `${ctx.displayName} published the rule "${draft.name}"`,
      after: { effectiveFrom: draft.effectiveFrom, method: draft.method, total: draft.totalAmountCents, perMember: draft.perMemberAmountCents },
      reason: opts.reason,
    });
    return { published, priceChangeId };
  });

  if (result.priceChangeId && opts.notifyResidents) await notifyPriceChange(ctx, result.priceChangeId);
  return result;
}

export async function notifyPriceChange(ctx: Ctx, priceChangeId: string) {
  const pc = await prisma.priceChange.findFirstOrThrow({ where: { id: priceChangeId, apartmentId: ctx.apartmentId } });
  const rows = pc.summary as unknown as { membershipId: string; previousCents: number; newCents: number }[];
  const residents = await activeResidents(prisma, ctx.apartmentId);
  const rules = await loadRules(prisma, ctx.apartmentId, ["PUBLISHED", "SUPERSEDED"]);
  const members = await loadMembers(prisma, ctx.apartmentId);
  const label = CATEGORY_LABELS[pc.category as Category];
  const type = pc.category === "RENT" ? "RENT_PRICE_UPDATED" : pc.category === "ELECTRICITY" ? "ELECTRICITY_PRICE_UPDATED" : "PRICE_UPDATED";
  const monthly = generatePeriodCharges(rules, members, pc.effectiveFrom).charges;
  for (const r of residents) {
    const row = rows.find((x) => x.membershipId === r.id);
    if (!row) continue;
    const revised = monthly.filter((c) => c.membershipId === r.id).reduce((a, c) => a + c.amountCents, 0);
    await notify(prisma, {
      apartmentId: ctx.apartmentId, userId: r.userId, type, link: "/notifications",
      title: `${label} changes from ${formatPeriod(pc.effectiveFrom)}`,
      body: `${formatCents(row.previousCents)} → ${formatCents(row.newCents)}. ${pc.reason}`,
      dedupeKey: `price-change:${pc.id}:${r.id}`,
      email: (u) => priceChangeEmail({ name: u.name, categoryLabel: label, effectiveFrom: pc.effectiveFrom, reason: pc.reason, previousCents: row.previousCents, newCents: row.newCents, revisedMonthlyCents: revised, url: absoluteUrl("/notifications") }),
    });
  }
}

// ───────────── Obligation generation ─────────────

/**
 * Generate DRAFT charges for a period from the published rules. Idempotent: existing DRAFT
 * charges for the period are replaced; FINAL and VOID charges are never touched.
 */
export async function generatePeriod(ctx: Ctx, period: Period) {
  assertAdmin(ctx);
  if (!isPeriod(period)) throw badRequest("Invalid month.");
  const [members, rules] = await Promise.all([loadMembers(prisma, ctx.apartmentId), loadRules(prisma, ctx.apartmentId)]);
  const gen = generatePeriodCharges(rules, members, period);
  return prisma.$transaction(async (tx) => {
    const fp = await ensurePeriod(tx, ctx.apartmentId, period);
    await tx.charge.deleteMany({ where: { periodId: fp.id, status: "DRAFT", ruleId: { not: null } } });
    const existing = await tx.charge.findMany({ where: { periodId: fp.id, status: { in: ["FINAL", "VOID"] }, ruleId: { not: null } }, select: { membershipId: true, category: true, ruleId: true } });
    const exists = new Set(existing.map((c) => `${c.membershipId}|${c.category}|${c.ruleId}`));
    const toCreate = gen.charges.filter((c) => !exists.has(`${c.membershipId}|${c.category}|${c.ruleId}`));
    await tx.charge.createMany({
      data: toCreate.map((c) => ({
        apartmentId: ctx.apartmentId, membershipId: c.membershipId, periodId: fp.id, category: c.category, amountCents: c.amountCents,
        ruleId: c.ruleId, ruleVersion: c.ruleVersion, dueDate: fp.dueDate, status: "DRAFT", createdById: ctx.userId,
      })),
    });
    await tx.financialPeriod.update({ where: { id: fp.id }, data: { generatedAt: new Date(), status: fp.status === "FINALIZED" ? "FINALIZED" : "GENERATED" } });
    await audit(tx, {
      apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: "period.generated", entityType: "FinancialPeriod", entityId: fp.id,
      summary: `Draft obligations generated for ${formatPeriod(period)}`, after: { created: toCreate.length, skippedFinal: gen.charges.length - toCreate.length },
    });
    return { created: toCreate.length, skipped: gen.charges.length - toCreate.length, warnings: gen.warnings, results: gen.results };
  });
}

/** Review data for a period: every charge grouped by member with per-rule reconciliation. */
export async function getPeriodReview(ctx: Ctx, period: Period) {
  assertAdmin(ctx);
  const fp = await prisma.financialPeriod.findUnique({ where: { apartmentId_period: { apartmentId: ctx.apartmentId, period } } });
  const members = await prisma.membership.findMany({ where: { apartmentId: ctx.apartmentId }, orderBy: { moveInDate: "asc" } });
  if (!fp) return { period, fp: null, charges: [], members, ruleChecks: [] };
  const charges = await prisma.charge.findMany({ where: { periodId: fp.id }, include: { rule: true }, orderBy: [{ category: "asc" }] });
  const ruleIds = [...new Set(charges.map((c) => c.ruleId).filter(Boolean))] as string[];
  const ruleChecks = (await prisma.chargeRule.findMany({ where: { id: { in: ruleIds } } })).map((r) => {
    const total = charges.filter((c) => c.ruleId === r.id && c.status !== "VOID").reduce((a, c) => a + c.amountCents, 0);
    const expected = r.method === "EQUAL_SPLIT" || r.method === "PERCENTAGE" ? r.totalAmountCents : null;
    return { ruleId: r.id, name: r.name, category: r.category, total, expected, ok: expected === null || expected === total };
  });
  return { period, fp, charges, members, ruleChecks };
}

/** Make all DRAFT charges of a period FINAL. Final charges are immutable from now on. */
export async function finalizePeriod(ctx: Ctx, period: Period) {
  assertAdmin(ctx);
  const res = await prisma.$transaction(async (tx) => {
    const fp = await tx.financialPeriod.findUnique({ where: { apartmentId_period: { apartmentId: ctx.apartmentId, period } } });
    if (!fp) throw notFound("Generate the month first.");
    const drafts = await tx.charge.count({ where: { periodId: fp.id, status: "DRAFT" } });
    if (drafts === 0 && fp.status === "FINALIZED") throw conflict("This month has no draft charges to finalise.");
    await tx.charge.updateMany({ where: { periodId: fp.id, status: "DRAFT" }, data: { status: "FINAL", finalizedAt: new Date() } });
    await tx.financialPeriod.update({ where: { id: fp.id }, data: { status: "FINALIZED", finalizedAt: new Date(), finalizedById: ctx.userId } });
    await audit(tx, {
      apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: "period.finalized", entityType: "FinancialPeriod", entityId: fp.id, isPublic: true,
      summary: `Rent obligations for ${formatPeriod(period)} were created`, after: { finalized: drafts },
    });
    return { fp, finalized: drafts };
  });
  // Tell every resident with a new obligation what they owe (in-app; reminders handle email).
  const charges = await prisma.charge.findMany({ where: { periodId: res.fp.id, status: "FINAL" }, include: { membership: true } });
  const byMember = new Map<string, { userId: string; total: number }>();
  for (const c of charges) {
    const e = byMember.get(c.membershipId) ?? { userId: c.membership.userId, total: 0 };
    e.total += c.amountCents;
    byMember.set(c.membershipId, e);
  }
  for (const [membershipId, e] of byMember) {
    await notify(prisma, {
      apartmentId: ctx.apartmentId, userId: e.userId, type: "RENT_DUE_SOON", link: `/account/month/${period}`,
      title: `${formatPeriod(period)}: ${formatCents(e.total)} due`,
      body: `Your obligations for ${formatPeriod(period)} are ready. Due ${res.fp.dueDate.toISOString().slice(0, 10)}.`,
      dedupeKey: `period-final:${res.fp.id}:${membershipId}`,
    });
  }
  return res;
}

export async function updateDraftCharge(ctx: Ctx, chargeId: string, amountCents: number) {
  assertAdmin(ctx);
  centsField.nonnegative().parse(amountCents);
  const c = await prisma.charge.findFirst({ where: { id: chargeId, apartmentId: ctx.apartmentId } });
  if (!c) throw notFound();
  if (c.status !== "DRAFT") throw conflict("Only draft charges can be edited. Use an adjustment for final charges.");
  return prisma.charge.update({ where: { id: c.id }, data: { amountCents } });
}

// ───────────── Manual charges, voids, adjustments ─────────────

export const manualChargeSchema = z.object({
  membershipId: z.string(),
  period: periodField,
  category: categoryField,
  amountCents: centsField.positive(),
  description: z.string().trim().min(1).max(300),
  finalize: z.boolean().default(true),
});

/** One-off charge (deposit, operating-cost settlement, shared purchase…). */
export async function createManualCharge(ctx: Ctx, raw: z.input<typeof manualChargeSchema>) {
  assertAdmin(ctx);
  const input = manualChargeSchema.parse(raw);
  const m = await prisma.membership.findFirst({ where: { id: input.membershipId, apartmentId: ctx.apartmentId } });
  if (!m) throw notFound();
  return prisma.$transaction(async (tx) => {
    const fp = await ensurePeriod(tx, ctx.apartmentId, input.period);
    const charge = await tx.charge.create({
      data: {
        apartmentId: ctx.apartmentId, membershipId: m.id, periodId: fp.id, category: input.category, amountCents: input.amountCents, description: input.description,
        dueDate: fp.dueDate, status: input.finalize ? "FINAL" : "DRAFT", finalizedAt: input.finalize ? new Date() : null, createdById: ctx.userId,
      },
    });
    await audit(tx, {
      apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: "charge.created", entityType: "Charge", entityId: charge.id, membershipId: m.id,
      summary: `${CATEGORY_LABELS[input.category]} charge of ${formatCents(input.amountCents)} added for ${m.displayName} (${formatPeriod(input.period)})`,
      after: input,
    });
    return charge;
  });
}

/** Void a charge. Draft charges are deleted; final charges become VOID and their allocations are reversed (money becomes credit). */
export async function voidCharge(ctx: Ctx, chargeId: string, reason: string) {
  assertAdmin(ctx);
  if (!reason.trim()) throw badRequest("Enter a reason.");
  return moneyTransaction(async (tx) => {
    const c = await tx.charge.findFirst({ where: { id: chargeId, apartmentId: ctx.apartmentId }, include: { membership: true, period: true } });
    if (!c) throw notFound();
    if (c.status === "VOID") throw conflict("Already void.");
    if (c.status === "DRAFT") {
      await tx.allocation.deleteMany({ where: { chargeId: c.id, state: "PROPOSED" } });
      await tx.charge.delete({ where: { id: c.id } });
      return { deleted: true };
    }
    const reversed = await tx.allocation.updateMany({
      where: { chargeId: c.id, state: { in: ["ACTIVE", "PROPOSED"] } },
      data: { state: "REVERSED", reversedAt: new Date(), reversedById: ctx.userId, reversalReason: `Charge voided: ${reason}` },
    });
    await tx.charge.update({ where: { id: c.id }, data: { status: "VOID", voidedAt: new Date(), voidedById: ctx.userId, voidReason: reason } });
    await audit(tx, {
      apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: "charge.voided", entityType: "Charge", entityId: c.id, membershipId: c.membershipId,
      summary: `${CATEGORY_LABELS[c.category as Category]} charge for ${c.membership.displayName} (${formatPeriod(c.period.period)}) voided`,
      before: { status: c.status, amountCents: c.amountCents }, after: { status: "VOID", allocationsReversed: reversed.count }, reason,
    });
    return { deleted: false, allocationsReversed: reversed.count };
  });
}

export const adjustmentSchema = z.object({
  membershipId: z.string(),
  period: periodField,
  category: categoryField,
  kind: z.enum(["OPENING_BALANCE", "CREDIT", "DEBIT", "SETTLEMENT", "WRITE_OFF", "CORRECTION"]),
  amountCents: centsField.refine((v) => v !== 0, "Amount must not be zero"),
  reason: z.string().trim().min(3).max(500),
});

/** Signed adjustment: positive increases what is owed, negative reduces it. */
export async function createAdjustment(ctx: Ctx, raw: z.input<typeof adjustmentSchema>, db?: Tx) {
  assertAdmin(ctx);
  const input = adjustmentSchema.parse(raw);
  if ((input.kind === "CREDIT" || input.kind === "WRITE_OFF") && input.amountCents > 0) throw badRequest("Credits and write-offs must be negative.");
  if (input.kind === "DEBIT" && input.amountCents < 0) throw badRequest("Debits must be positive.");
  const run = async (tx: Tx) => {
    const m = await tx.membership.findFirst({ where: { id: input.membershipId, apartmentId: ctx.apartmentId } });
    if (!m) throw notFound();
    const fp = await ensurePeriod(tx, ctx.apartmentId, input.period);
    const adj = await tx.adjustment.create({
      data: { apartmentId: ctx.apartmentId, membershipId: m.id, periodId: fp.id, category: input.category as ChargeCategory, kind: input.kind, amountCents: input.amountCents, reason: input.reason, createdById: ctx.userId },
    });
    await audit(tx, {
      apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: "adjustment.created", entityType: "Adjustment", entityId: adj.id, membershipId: m.id,
      summary: `${input.kind.replace("_", " ").toLowerCase()} of ${formatCents(input.amountCents)} for ${m.displayName} (${formatPeriod(input.period)}, ${CATEGORY_LABELS[input.category]})`,
      after: input, reason: input.reason,
    });
    return adj;
  };
  return db ? run(db) : prisma.$transaction(run);
}

/** Reverse an adjustment by creating the exact opposite entry. */
export async function reverseAdjustment(ctx: Ctx, adjustmentId: string, reason: string) {
  assertAdmin(ctx);
  if (!reason.trim()) throw badRequest("Enter a reason.");
  return prisma.$transaction(async (tx) => {
    const a = await tx.adjustment.findFirst({ where: { id: adjustmentId, apartmentId: ctx.apartmentId }, include: { reversedBy: true } });
    if (!a) throw notFound();
    if (a.reversedBy || a.kind === "REVERSAL") throw conflict("This adjustment has already been reversed.");
    const r = await tx.adjustment.create({
      data: { apartmentId: a.apartmentId, membershipId: a.membershipId, periodId: a.periodId, category: a.category, kind: "REVERSAL", amountCents: -a.amountCents, reason, reversesId: a.id, createdById: ctx.userId },
    });
    await audit(tx, {
      apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: "adjustment.reversed", entityType: "Adjustment", entityId: a.id, membershipId: a.membershipId,
      summary: `Adjustment of ${formatCents(a.amountCents)} reversed`, reason, after: { reversalId: r.id },
    });
    return r;
  });
}

// ───────────── Payouts (refunds, deposit applied) ─────────────

export const payoutSchema = z.object({
  membershipId: z.string(),
  kind: z.enum(["DEPOSIT_REFUND", "CREDIT_REFUND"]),
  category: z.enum(["SECURITY_DEPOSIT", "RENT_BUFFER"]).nullable(),
  amountCents: centsField.positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().trim().min(3).max(300),
});

async function memberBalances(tx: Tx, apartmentId: string, membershipId: string) {
  const { today, current, graceDays } = await apartmentClock(tx, apartmentId);
  const input = await loadLedgerInput(tx, apartmentId, membershipId);
  return { summary: summarizeMember(input, membershipId, { asOf: current, today, graceDays }), input };
}

function depositHeldFor(input: Awaited<ReturnType<typeof memberBalances>>["input"], category: Category) {
  const paid = input.payments
    .filter((p) => p.status === "VERIFIED")
    .flatMap((p) => p.allocations.filter((a) => a.state === "ACTIVE"))
    .filter((a) => input.charges.find((c) => c.id === a.chargeId && c.status === "FINAL" && c.category === category))
    .reduce((s, a) => s + a.amountCents, 0);
  const out = input.payouts.filter((p) => !p.reversed && p.category === category && p.kind !== "CREDIT_REFUND").reduce((s, p) => s + p.amountCents, 0);
  return paid - out;
}

export async function createPayout(ctx: Ctx, raw: z.input<typeof payoutSchema>) {
  assertAdmin(ctx);
  const input = payoutSchema.parse(raw);
  if (input.kind === "DEPOSIT_REFUND" && !input.category) throw badRequest("Choose which deposit is refunded.");
  return moneyTransaction(async (tx) => {
    const m = await tx.membership.findFirst({ where: { id: input.membershipId, apartmentId: ctx.apartmentId } });
    if (!m) throw notFound();
    const { summary, input: ledger } = await memberBalances(tx, ctx.apartmentId, m.id);
    if (input.kind === "CREDIT_REFUND" && input.amountCents > summary.unallocatedCredit) throw badRequest(`Only ${formatCents(summary.unallocatedCredit)} of unallocated credit is available.`);
    if (input.kind === "DEPOSIT_REFUND" && input.amountCents > depositHeldFor(ledger, input.category!)) throw badRequest("The refund is larger than the deposit held.");
    const payout = await tx.payout.create({
      data: { apartmentId: ctx.apartmentId, membershipId: m.id, kind: input.kind, category: input.category, amountCents: input.amountCents, date: new Date(`${input.date}T00:00:00Z`), description: input.description, createdById: ctx.userId },
    });
    await audit(tx, {
      apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: "payout.created", entityType: "Payout", entityId: payout.id, membershipId: m.id,
      summary: `${input.kind === "DEPOSIT_REFUND" ? "Deposit refund" : "Credit refund"} of ${formatCents(input.amountCents)} to ${m.displayName}`, after: input,
    });
    return payout;
  });
}

export async function reversePayout(ctx: Ctx, payoutId: string, reason: string) {
  assertAdmin(ctx);
  if (!reason.trim()) throw badRequest("Enter a reason.");
  return prisma.$transaction(async (tx) => {
    const p = await tx.payout.findFirst({ where: { id: payoutId, apartmentId: ctx.apartmentId } });
    if (!p) throw notFound();
    if (p.reversedAt) throw conflict("Already reversed.");
    await tx.payout.update({ where: { id: p.id }, data: { reversedAt: new Date(), reversedById: ctx.userId, reversalReason: reason } });
    await audit(tx, { apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: "payout.reversed", entityType: "Payout", entityId: p.id, membershipId: p.membershipId, summary: `Payout of ${formatCents(p.amountCents)} reversed`, reason });
  });
}

/**
 * Explicitly apply held deposit money to a rent (or other) obligation: records a DEPOSIT_APPLIED
 * payout and a matching negative adjustment on the target month. Both are audited.
 */
export async function applyDeposit(ctx: Ctx, raw: { membershipId: string; depositCategory: "SECURITY_DEPOSIT" | "RENT_BUFFER"; amountCents: number; targetPeriod: string; targetCategory: Category; reason: string }) {
  assertAdmin(ctx);
  centsField.positive().parse(raw.amountCents);
  if (!isPeriod(raw.targetPeriod)) throw badRequest("Invalid month.");
  if (!raw.reason.trim()) throw badRequest("Enter a reason.");
  return moneyTransaction(async (tx) => {
    const m = await tx.membership.findFirst({ where: { id: raw.membershipId, apartmentId: ctx.apartmentId } });
    if (!m) throw notFound();
    const { input } = await memberBalances(tx, ctx.apartmentId, m.id);
    if (raw.amountCents > depositHeldFor(input, raw.depositCategory)) throw badRequest("The amount is larger than the deposit held.");
    const fp = await ensurePeriod(tx, ctx.apartmentId, raw.targetPeriod);
    const payout = await tx.payout.create({
      data: { apartmentId: ctx.apartmentId, membershipId: m.id, kind: "DEPOSIT_APPLIED", category: raw.depositCategory, amountCents: raw.amountCents, date: new Date(), description: raw.reason, createdById: ctx.userId },
    });
    const adj = await tx.adjustment.create({
      data: { apartmentId: ctx.apartmentId, membershipId: m.id, periodId: fp.id, category: raw.targetCategory, kind: "DEPOSIT_APPLIED", amountCents: -raw.amountCents, reason: raw.reason, createdById: ctx.userId },
    });
    await audit(tx, {
      apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: "deposit.applied", entityType: "Payout", entityId: payout.id, membershipId: m.id,
      summary: `${formatCents(raw.amountCents)} of ${m.displayName}'s ${CATEGORY_LABELS[raw.depositCategory].toLowerCase()} applied to ${formatPeriod(raw.targetPeriod)} ${CATEGORY_LABELS[raw.targetCategory].toLowerCase()}`,
      after: { payoutId: payout.id, adjustmentId: adj.id }, reason: raw.reason,
    });
    return { payout, adjustment: adj };
  });
}

// ───────────── Reconciliation & settings ─────────────

export async function setReconciliationStatus(ctx: Ctx, membershipId: string, reconciled: boolean, note: string) {
  assertAdmin(ctx);
  const m = await prisma.membership.findFirst({ where: { id: membershipId, apartmentId: ctx.apartmentId } });
  if (!m) throw notFound();
  await prisma.$transaction(async (tx) => {
    await tx.membership.update({ where: { id: m.id }, data: { reconciliationStatus: reconciled ? "RECONCILED" : "UNRECONCILED", reconciledAt: reconciled ? new Date() : null } });
    await audit(tx, {
      apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: reconciled ? "account.reconciled" : "account.unreconciled", entityType: "Membership", entityId: m.id, membershipId: m.id,
      summary: `${m.displayName}'s account marked as ${reconciled ? "reconciled" : "unreconciled"}`, reason: note,
    });
  });
}

export const settingsSchema = z.object({
  name: z.string().trim().min(1).max(100),
  address: z.string().trim().max(300).optional(),
  rentDueDay: z.number().int().min(1).max(28),
  graceDays: z.number().int().min(0).max(31),
  maxUploadMb: z.number().int().min(1).max(25),
});

export async function updateApartmentSettings(ctx: Ctx, raw: z.input<typeof settingsSchema>) {
  assertAdmin(ctx);
  const input = settingsSchema.parse(raw);
  await prisma.$transaction(async (tx) => {
    const before = await tx.apartment.findUniqueOrThrow({ where: { id: ctx.apartmentId } });
    const after = await tx.apartment.update({
      where: { id: ctx.apartmentId },
      data: { name: input.name, address: input.address ?? null, rentDueDay: input.rentDueDay, graceDays: input.graceDays, maxUploadBytes: input.maxUploadMb * 1024 * 1024 },
    });
    await audit(tx, {
      apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: "settings.updated", entityType: "Apartment", entityId: ctx.apartmentId, summary: `${ctx.displayName} updated apartment settings`,
      before: { rentDueDay: before.rentDueDay, graceDays: before.graceDays, maxUploadBytes: before.maxUploadBytes }, after: { rentDueDay: after.rentDueDay, graceDays: after.graceDays, maxUploadBytes: after.maxUploadBytes },
    });
  });
}
