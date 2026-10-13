/**
 * Read-side finance queries. Everything here loads a ledger snapshot and delegates the maths to
 * ledger.ts, so dashboards, statements, charts, reminders and exports always agree.
 */
import type { Db } from "../db";
import { prisma } from "../db";
import type { Ctx } from "../auth/ctx";
import { notFound } from "../errors";
import { collectionByPeriod, computeLines, summarizeMember, type MemberSummary } from "./ledger";
import { addMonths, currentPeriod, dueDateFor, isWithin, periodsBetween, todayInZone, type Period } from "./period";
import type { Category, LedgerInput, MemberInfo, RuleInput } from "./types";

/** Load the full ledger for an apartment, optionally restricted to one membership. */
export async function loadLedgerInput(db: Db, apartmentId: string, membershipId?: string): Promise<LedgerInput> {
  const scope = { apartmentId, ...(membershipId ? { membershipId } : {}) };
  const [charges, adjustments, payments, payouts] = await Promise.all([
    db.charge.findMany({ where: { ...scope, status: { not: "DRAFT" } }, include: { period: { select: { period: true } } } }),
    db.adjustment.findMany({ where: scope, include: { period: { select: { period: true } } } }),
    db.payment.findMany({
      where: { ...scope, status: { not: "DRAFT" } },
      include: { allocations: { select: { id: true, chargeId: true, amountCents: true, state: true } } },
    }),
    db.payout.findMany({ where: scope }),
  ]);
  return {
    charges: charges.map((c) => ({ id: c.id, membershipId: c.membershipId, period: c.period.period, category: c.category as Category, amountCents: c.amountCents, status: c.status, dueDate: c.dueDate })),
    adjustments: adjustments.map((a) => ({ id: a.id, membershipId: a.membershipId, period: a.period.period, category: a.category as Category, amountCents: a.amountCents })),
    payments: payments.map((p) => ({ id: p.id, membershipId: p.membershipId, amountCents: p.amountCents, status: p.status, transferDate: p.transferDate, allocations: p.allocations })),
    payouts: payouts.map((p) => ({ id: p.id, membershipId: p.membershipId, kind: p.kind, category: p.category as Category | null, amountCents: p.amountCents, reversed: p.reversedAt !== null })),
  };
}

export async function loadMembers(db: Db, apartmentId: string): Promise<(MemberInfo & { status: string; role: string; userId: string })[]> {
  const ms = await db.membership.findMany({ where: { apartmentId }, orderBy: [{ moveInDate: "asc" }, { id: "asc" }] });
  return ms.map((m) => ({
    id: m.id, displayName: m.displayName, billingStart: m.billingStart, billingEnd: m.billingEnd, sortKey: m.moveInDate.getTime(),
    status: m.status, role: m.role, userId: m.userId,
  }));
}

export async function loadRules(db: Db, apartmentId: string, statuses: ("PUBLISHED" | "SUPERSEDED" | "DRAFT")[] = ["PUBLISHED", "SUPERSEDED"]): Promise<RuleInput[]> {
  const rules = await db.chargeRule.findMany({ where: { apartmentId, status: { in: statuses } }, include: { shares: true }, orderBy: { createdAt: "asc" } });
  return rules.map(toRuleInput);
}

export function toRuleInput(r: { id: string; version: number; name: string; category: string; method: string; totalAmountCents: number | null; perMemberAmountCents: number | null; effectiveFrom: string; effectiveTo: string | null; shares: { membershipId: string; amountCents: number | null; basisPoints: number | null }[] }): RuleInput {
  return {
    id: r.id, version: r.version, name: r.name, category: r.category as Category, method: r.method as RuleInput["method"],
    totalAmountCents: r.totalAmountCents, perMemberAmountCents: r.perMemberAmountCents, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo,
    shares: r.shares.map((s) => ({ membershipId: s.membershipId, amountCents: s.amountCents, basisPoints: s.basisPoints })),
  };
}

export async function apartmentClock(db: Db, apartmentId: string) {
  const a = await db.apartment.findUniqueOrThrow({ where: { id: apartmentId } });
  return { apartment: a, today: todayInZone(a.timezone), current: currentPeriod(a.timezone), graceDays: a.graceDays };
}

/** May ctx see this membership's private finances? (admin, or the member themself) */
export async function assertCanViewMember(ctx: Ctx, membershipId: string, db: Db = prisma) {
  const m = await db.membership.findFirst({ where: { id: membershipId, apartmentId: ctx.apartmentId } });
  if (!m || (!ctx.isAdmin && m.id !== ctx.membershipId)) throw notFound();
  return m;
}

export async function getMemberSummary(ctx: Ctx, membershipId: string): Promise<MemberSummary & { displayName: string; reconciliationStatus: string; asOf: Period }> {
  const m = await assertCanViewMember(ctx, membershipId);
  const { today, current, graceDays } = await apartmentClock(prisma, ctx.apartmentId);
  const input = await loadLedgerInput(prisma, ctx.apartmentId, membershipId);
  const summary = summarizeMember(input, membershipId, { asOf: current, today, graceDays });
  return { ...summary, displayName: m.displayName, reconciliationStatus: m.reconciliationStatus, asOf: current };
}

export interface ApartmentOverview {
  period: Period;
  expected: number;
  confirmed: number;
  pending: number;
  outstanding: number;
  totalOutstandingToDate: number;
  fullyPaid: number;
  withPending: number;
  overdue: number;
  memberCount: number;
  nextDueDate: Date | null;
  members: { membershipId: string; displayName: string; due: number; confirmed: number; pending: number; outstanding: number; totalOutstanding: number; overdueMonths: number; status: string; reconciliationStatus: string }[];
}

function nextDueDateFromSettings(current: Period, dueDay: number, today: Date): Date {
  const thisMonth = dueDateFor(current, dueDay);
  return thisMonth >= today ? thisMonth : dueDateFor(addMonths(current, 1), dueDay);
}

/** Apartment-wide figures for a period. Per-member rows are only returned to admins. */
export async function getApartmentOverview(ctx: Ctx, period?: Period): Promise<ApartmentOverview> {
  const { today, current, graceDays, apartment } = await apartmentClock(prisma, ctx.apartmentId);
  const p = period ?? current;
  const [input, members, nextPeriod] = await Promise.all([
    loadLedgerInput(prisma, ctx.apartmentId),
    prisma.membership.findMany({ where: { apartmentId: ctx.apartmentId } }),
    prisma.financialPeriod.findFirst({ where: { apartmentId: ctx.apartmentId, status: "FINALIZED", dueDate: { gte: today } }, orderBy: { dueDate: "asc" } }),
  ]);
  const lines = computeLines(input);
  const col = collectionByPeriod(input, [p], { today, graceDays }, lines)[0]!;
  // Every resident billed in the period gets a row, even before any charge exists for them.
  const ids = new Set([...col.byMember.map((b) => b.membershipId), ...members.filter((m) => isWithin(p, m.billingStart, m.billingEnd)).map((m) => m.id)]);
  const rows = members
    .filter((m) => ids.has(m.id))
    .map((m) => {
      const b = col.byMember.find((x) => x.membershipId === m.id) ?? { membershipId: m.id, due: 0, confirmed: 0, pending: 0, outstanding: 0, status: "NO_CHARGES" as const };
      const s = summarizeMember(input, m.id, { asOf: current, today, graceDays }, lines);
      return { ...b, displayName: m.displayName, totalOutstanding: s.totalOutstanding, overdueMonths: s.overdueMonths.length, reconciliationStatus: m.reconciliationStatus };
    });
  const totalOutstandingToDate = members.reduce((acc, m) => acc + summarizeMember(input, m.id, { asOf: current, today, graceDays }, lines).totalOutstanding, 0);
  return {
    period: p,
    expected: col.expected,
    confirmed: col.confirmed,
    pending: col.pending,
    outstanding: col.outstanding,
    totalOutstandingToDate,
    fullyPaid: rows.filter((m) => m.status === "PAID").length,
    withPending: rows.filter((m) => m.pending > 0).length,
    overdue: rows.filter((m) => m.status === "OVERDUE" || m.overdueMonths > 0).length,
    memberCount: rows.length,
    nextDueDate: nextPeriod?.dueDate ?? nextDueDateFromSettings(current, apartment.rentDueDay, today),
    members: ctx.isAdmin ? rows : [],
  };
}

/** Expected vs confirmed per month for the chart. Residents get apartment totals, admins also per-member. */
export async function getCollectionSeries(ctx: Ctx, months = 12, membershipId?: string) {
  const { today, current, graceDays } = await apartmentClock(prisma, ctx.apartmentId);
  if (membershipId) await assertCanViewMember(ctx, membershipId);
  const input = await loadLedgerInput(prisma, ctx.apartmentId, membershipId);
  const periods = periodsBetween(addMonths(current, -(months - 1)), current);
  const members = await prisma.membership.findMany({ where: { apartmentId: ctx.apartmentId }, select: { id: true, displayName: true } });
  const names = new Map(members.map((m) => [m.id, m.displayName]));
  const series = collectionByPeriod(input, periods, { today, graceDays });
  const rejected = await prisma.payment.groupBy({
    by: ["membershipId"],
    where: { apartmentId: ctx.apartmentId, status: "REJECTED", ...(membershipId ? { membershipId } : {}) },
    _count: true,
  });
  return {
    series: series.map((s) => ({
      period: s.period,
      expected: s.expected,
      confirmed: s.confirmed,
      pending: s.pending,
      outstanding: s.outstanding,
      byMember: ctx.isAdmin || membershipId ? s.byMember.map((b) => ({ ...b, displayName: names.get(b.membershipId) ?? "?" })) : [],
    })),
    rejectedCount: rejected.reduce((a, r) => a + r._count, 0),
  };
}

/** Everything about one member-month: charges, adjustments, allocations (with payments) and evidence. */
export async function getMonthDetail(ctx: Ctx, membershipId: string, period: Period) {
  const m = await assertCanViewMember(ctx, membershipId);
  const fp = await prisma.financialPeriod.findUnique({ where: { apartmentId_period: { apartmentId: ctx.apartmentId, period } } });
  if (!fp) return { membership: m, period, charges: [], adjustments: [], dueDate: null };
  const [charges, adjustments] = await Promise.all([
    prisma.charge.findMany({
      where: { membershipId, periodId: fp.id, status: { not: "DRAFT" } },
      include: {
        allocations: {
          where: { state: { in: ["ACTIVE", "PROPOSED"] }, payment: { status: { in: ["SUBMITTED", "UNDER_REVIEW", "CLARIFICATION_REQUESTED", "VERIFIED"] } } },
          include: { payment: { select: { id: true, status: true, transferDate: true, amountCents: true, bank: true, description: true, evidence: { select: { fileId: true, file: { select: { originalName: true } } } } } } },
        },
      },
      orderBy: { category: "asc" },
    }),
    prisma.adjustment.findMany({ where: { membershipId, periodId: fp.id }, orderBy: { createdAt: "asc" } }),
  ]);
  return { membership: m, period, charges, adjustments, dueDate: fp.dueDate };
}
