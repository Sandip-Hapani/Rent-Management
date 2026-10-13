/**
 * Administrator reports and resident statements. All figures come from ledger.ts so reports,
 * dashboards and statements always match. Deposits are reported separately from income.
 */
import { prisma } from "../db";
import { assertAdmin, type Ctx } from "../auth/ctx";
import { badRequest } from "../errors";
import { collectionByPeriod, computeLines, summarizeMember } from "../finance/ledger";
import { formatCents } from "../finance/money";
import { addMonths, formatPeriod, isoDate, isPeriod, periodsBetween, type Period } from "../finance/period";
import { apartmentClock, assertCanViewMember, loadLedgerInput } from "../finance/queries";
import { CATEGORY_LABELS, DEPOSIT_CATEGORIES, type Category } from "../finance/types";

export interface Column {
  key: string;
  label: string;
  /** "money" values are cents and are exported as decimal euros. "lines" = one fact per line (
-separated). */
  type?: "text" | "money" | "number" | "date" | "percent" | "status" | "id" | "lines";
  /** Allow long free text to wrap on screen (everything else stays on one line). */
  wrap?: boolean;
  /** false = export-only column, hidden in the on-screen table to avoid sideways scrolling. */
  screen?: boolean;
}

/** Group allocations by month: one line per month, e.g. "Jun 2026 | Rent 176,00 € | Electricity 23,60 €". */
export function allocationLines(allocs: { period: string; category: string; amountCents: number; reversed?: boolean }[]): string {
  const byMonth = new Map<string, string[]>();
  for (const a of [...allocs].sort((x, y) => x.period.localeCompare(y.period))) {
    const key = `${a.period}${a.reversed ? " (reversed)" : ""}`;
    byMonth.set(key, [...(byMonth.get(key) ?? []), `${CATEGORY_LABELS[a.category as Category]} ${formatCents(a.amountCents)}`]);
  }
  return [...byMonth.entries()].map(([k, parts]) => `${formatPeriod(k.slice(0, 7), "short")}${k.length > 7 ? " (reversed)" : ""} | ${parts.join(" | ")}`).join("\n");
}

export interface ReportTable {
  title: string;
  columns: Column[];
  rows: Record<string, string | number | null>[];
}

export const REPORT_TYPES = ["collection", "balances-resident", "balances-month", "ledger", "electricity", "deposits", "pending", "adjustments", "reminders"] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export const REPORT_TITLES: Record<ReportType, string> = {
  collection: "Expected vs confirmed collection",
  "balances-resident": "Outstanding balances by resident",
  "balances-month": "Outstanding balances by month",
  ledger: "Payment ledger",
  electricity: "Electricity allocation and collection",
  deposits: "Deposit balances",
  pending: "Pending payment verifications",
  adjustments: "Adjustments, reversals and voids",
  reminders: "Reminder delivery history",
};

export interface ReportFilters {
  from?: Period;
  to?: Period;
  membershipId?: string;
}

async function range(ctx: Ctx, f: ReportFilters) {
  const { current, today, graceDays } = await apartmentClock(prisma, ctx.apartmentId);
  const to = f.to && isPeriod(f.to) ? f.to : current;
  const from = f.from && isPeriod(f.from) ? f.from : addMonths(to, -11);
  if (from > to) throw badRequest("The start month must be before the end month.");
  if (periodsBetween(from, to).length > 120) throw badRequest("Choose at most 10 years.");
  return { from, to, current, today, graceDays };
}

export async function buildReport(ctx: Ctx, type: ReportType, f: ReportFilters): Promise<ReportTable> {
  assertAdmin(ctx);
  const { from, to, current, today, graceDays } = await range(ctx, f);
  const members = await prisma.membership.findMany({ where: { apartmentId: ctx.apartmentId, ...(f.membershipId ? { id: f.membershipId } : {}) }, orderBy: { moveInDate: "asc" } });
  const nameOf = new Map(members.map((m) => [m.id, m.displayName]));
  const memberFilter = f.membershipId ? { membershipId: f.membershipId } : {};
  const title = REPORT_TITLES[type];

  switch (type) {
    case "collection": {
      const input = await loadLedgerInput(prisma, ctx.apartmentId, f.membershipId);
      const series = collectionByPeriod(input, periodsBetween(from, to), { today, graceDays });
      return {
        title,
        columns: [{ key: "month", label: "Month" }, { key: "expected", label: "Expected", type: "money" }, { key: "confirmed", label: "Confirmed", type: "money" }, { key: "pending", label: "Pending verification", type: "money" }, { key: "outstanding", label: "Outstanding", type: "money" }, { key: "rate", label: "Collection %", type: "percent" }],
        rows: series.map((s) => ({ month: s.period, expected: s.expected, confirmed: s.confirmed, pending: s.pending, outstanding: s.outstanding, rate: s.expected > 0 ? Math.round((s.confirmed / s.expected) * 1000) / 10 : null })),
      };
    }
    case "balances-resident": {
      const input = await loadLedgerInput(prisma, ctx.apartmentId);
      const lines = computeLines(input);
      return {
        title,
        columns: [{ key: "resident", label: "Resident" }, { key: "status", label: "Membership", type: "status" }, { key: "reconciliation", label: "Checked", type: "status" }, { key: "outstanding", label: "Outstanding", type: "money" }, { key: "pending", label: "Pending", type: "money" }, { key: "credit", label: "Credit", type: "money" }, { key: "paid", label: "Paid (verified)", type: "money" }, { key: "deposit", label: "Deposit held", type: "money" }],
        rows: members.map((m) => {
          const s = summarizeMember(input, m.id, { asOf: current, today, graceDays }, lines);
          return { resident: m.displayName, status: m.status, reconciliation: m.reconciliationStatus, outstanding: s.totalOutstanding, pending: s.pendingSubmissionCents, credit: s.unallocatedCredit, paid: s.totalVerifiedPayments, deposit: s.depositHeld };
        }),
      };
    }
    case "balances-month": {
      const input = await loadLedgerInput(prisma, ctx.apartmentId, f.membershipId);
      const series = collectionByPeriod(input, periodsBetween(from, to), { today, graceDays });
      return {
        title,
        columns: [{ key: "month", label: "Month" }, { key: "resident", label: "Resident" }, { key: "due", label: "Due", type: "money" }, { key: "confirmed", label: "Confirmed", type: "money" }, { key: "outstanding", label: "Outstanding", type: "money" }, { key: "status", label: "Status", type: "status" }],
        rows: series.flatMap((s) => s.byMember.filter((b) => b.outstanding !== 0 || b.due !== 0).map((b) => ({ month: s.period, resident: nameOf.get(b.membershipId) ?? "?", due: b.due, confirmed: b.confirmed, outstanding: b.outstanding, status: b.status }))),
      };
    }
    case "ledger": {
      const payments = await prisma.payment.findMany({
        where: { apartmentId: ctx.apartmentId, ...memberFilter, status: { not: "DRAFT" }, transferDate: { gte: new Date(`${from}-01T00:00:00Z`), lt: new Date(`${addMonths(to, 1)}-01T00:00:00Z`) } },
        include: { membership: { select: { displayName: true } }, allocations: { include: { charge: { include: { period: true } } } } },
        orderBy: { transferDate: "asc" },
      });
      return {
        title,
        columns: [{ key: "date", label: "Date", type: "date" }, { key: "resident", label: "Resident" }, { key: "amount", label: "Amount", type: "money" }, { key: "status", label: "Status", type: "status" }, { key: "allocations", label: "Allocated to", type: "lines" }, { key: "unallocated", label: "Credit", type: "money" }, { key: "bank", label: "Bank", screen: false }, { key: "source", label: "Source", screen: false }, { key: "allocated", label: "Allocated", type: "money", screen: false }, { key: "description", label: "Description", screen: false }, { key: "id", label: "Transaction ID", type: "id" }],
        rows: payments.map((p) => {
          const active = p.allocations.filter((a) => a.state === "ACTIVE");
          const allocated = active.reduce((a, x) => a + x.amountCents, 0);
          return {
            id: p.id, date: isoDate(p.transferDate), resident: p.membership.displayName, amount: p.amountCents, bank: p.bank, status: p.status, source: p.source,
            allocations: allocationLines(active.map((a) => ({ period: a.charge.period.period, category: a.charge.category, amountCents: a.amountCents }))),
            allocated: p.status === "VERIFIED" ? allocated : 0, unallocated: p.status === "VERIFIED" ? p.amountCents - allocated : null, description: p.description,
          };
        }),
      };
    }
    case "electricity": {
      const input = await loadLedgerInput(prisma, ctx.apartmentId, f.membershipId);
      const lines = computeLines(input).filter((l) => l.category === "ELECTRICITY" && l.period >= from && l.period <= to);
      return {
        title,
        columns: [{ key: "month", label: "Month" }, { key: "resident", label: "Resident" }, { key: "due", label: "Electricity due", type: "money" }, { key: "confirmed", label: "Confirmed", type: "money" }, { key: "pending", label: "Pending", type: "money" }, { key: "outstanding", label: "Outstanding", type: "money" }],
        rows: lines.map((l) => ({ month: l.period, resident: nameOf.get(l.membershipId) ?? "?", due: l.due, confirmed: l.confirmed, pending: l.pending, outstanding: l.outstanding })),
      };
    }
    case "deposits": {
      const input = await loadLedgerInput(prisma, ctx.apartmentId);
      const lines = computeLines(input);
      return {
        title,
        columns: [{ key: "resident", label: "Resident" }, { key: "category", label: "Deposit" }, { key: "due", label: "Required", type: "money" }, { key: "paid", label: "Paid", type: "money" }, { key: "returned", label: "Refunded / applied", type: "money" }, { key: "held", label: "Held", type: "money" }],
        rows: members.flatMap((m) =>
          DEPOSIT_CATEGORIES.map((c) => {
            const ls = lines.filter((l) => l.membershipId === m.id && l.category === c);
            const paid = ls.reduce((a, l) => a + l.confirmed, 0);
            const returned = input.payouts.filter((p) => p.membershipId === m.id && p.category === c && !p.reversed && p.kind !== "CREDIT_REFUND").reduce((a, p) => a + p.amountCents, 0);
            return { resident: m.displayName, category: CATEGORY_LABELS[c], due: ls.reduce((a, l) => a + l.due, 0), paid, returned, held: paid - returned };
          }).filter((r) => r.due || r.paid || r.returned),
        ),
      };
    }
    case "pending": {
      const payments = await prisma.payment.findMany({
        where: { apartmentId: ctx.apartmentId, ...memberFilter, status: { in: ["SUBMITTED", "UNDER_REVIEW", "CLARIFICATION_REQUESTED"] } },
        include: { membership: { select: { displayName: true } }, _count: { select: { evidence: true } } },
        orderBy: { submittedAt: "asc" },
      });
      return {
        title,
        columns: [{ key: "submitted", label: "Submitted", type: "date" }, { key: "resident", label: "Resident" }, { key: "amount", label: "Amount", type: "money" }, { key: "date", label: "Transfer date", type: "date" }, { key: "months", label: "For months", type: "lines" }, { key: "status", label: "Status", type: "status" }, { key: "evidence", label: "Files", type: "number" }, { key: "source", label: "Source", screen: false }],
        rows: payments.map((p) => ({ submitted: p.submittedAt ? isoDate(p.submittedAt) : null, resident: p.membership.displayName, amount: p.amountCents, date: isoDate(p.transferDate), months: p.intendedPeriods.map((x) => formatPeriod(x, "short")).join("\n"), status: p.status, evidence: p._count.evidence, source: p.source })),
      };
    }
    case "adjustments": {
      const [adjustments, reversedPayments, voided, payouts] = await Promise.all([
        prisma.adjustment.findMany({ where: { apartmentId: ctx.apartmentId, ...memberFilter, period: { period: { gte: from, lte: to } } }, include: { membership: true, period: true } }),
        prisma.payment.findMany({ where: { apartmentId: ctx.apartmentId, ...memberFilter, status: "REVERSED" }, include: { membership: true } }),
        prisma.charge.findMany({ where: { apartmentId: ctx.apartmentId, ...memberFilter, status: "VOID", period: { period: { gte: from, lte: to } } }, include: { membership: true, period: true } }),
        prisma.payout.findMany({ where: { apartmentId: ctx.apartmentId, ...memberFilter }, include: { membership: true } }),
      ]);
      const rows = [
        ...adjustments.map((a) => ({ date: isoDate(a.createdAt), type: `Adjustment (${a.kind.toLowerCase().replace("_", " ")})`, resident: a.membership.displayName, month: a.period.period, category: CATEGORY_LABELS[a.category as Category], amount: a.amountCents, reason: a.reason })),
        ...reversedPayments.map((p) => ({ date: isoDate(p.reversedAt ?? p.updatedAt), type: "Payment reversal", resident: p.membership.displayName, month: null, category: null, amount: -p.amountCents, reason: p.reversalReason })),
        ...voided.map((c) => ({ date: isoDate(c.voidedAt ?? c.createdAt), type: "Charge voided", resident: c.membership.displayName, month: c.period.period, category: CATEGORY_LABELS[c.category as Category], amount: -c.amountCents, reason: c.voidReason })),
        ...payouts.map((p) => ({ date: isoDate(p.date), type: `Payout (${p.kind.toLowerCase().replace(/_/g, " ")})${p.reversedAt ? " — reversed" : ""}`, resident: p.membership.displayName, month: null, category: p.category ? CATEGORY_LABELS[p.category as Category] : null, amount: p.amountCents, reason: p.description })),
      ].sort((a, b) => String(a.date).localeCompare(String(b.date)));
      return {
        title,
        columns: [{ key: "date", label: "Date", type: "date" }, { key: "type", label: "Type" }, { key: "resident", label: "Resident" }, { key: "month", label: "Month" }, { key: "category", label: "Category" }, { key: "amount", label: "Amount", type: "money" }, { key: "reason", label: "Reason", wrap: true }],
        rows,
      };
    }
    case "reminders": {
      const runs = await prisma.reminderRun.findMany({
        where: { period: { apartmentId: ctx.apartmentId, period: { gte: from, lte: to } }, ...memberFilter },
        include: { period: true, membership: true },
        orderBy: { createdAt: "desc" },
        take: 2000,
      });
      return {
        title,
        columns: [{ key: "date", label: "Date", type: "date" }, { key: "resident", label: "Resident" }, { key: "month", label: "Month" }, { key: "offset", label: "Days vs due", type: "number" }, { key: "outcome", label: "Outcome", type: "status" }, { key: "amount", label: "Outstanding then", type: "money" }, { key: "reason", label: "Reason", wrap: true }],
        rows: runs.map((r) => ({ date: isoDate(r.createdAt), resident: r.membership.displayName, month: r.period.period, offset: r.offsetDays, outcome: r.outcome, amount: r.amountDueCents, reason: r.reason })),
      };
    }
  }
}

/** Resident statement: monthly charges, payments, allocations, adjustments and balances. */
export async function buildStatement(ctx: Ctx, membershipId: string, f: { from?: Period; to?: Period }) {
  const m = await assertCanViewMember(ctx, membershipId);
  const { current, today, graceDays } = await apartmentClock(prisma, ctx.apartmentId);
  const to = f.to && isPeriod(f.to) ? f.to : current;
  const from = f.from && isPeriod(f.from) ? f.from : m.billingStart;
  const input = await loadLedgerInput(prisma, ctx.apartmentId, membershipId);
  const lines = computeLines(input);
  const summary = summarizeMember(input, membershipId, { asOf: current, today, graceDays }, lines);
  const payments = await prisma.payment.findMany({
    where: { membershipId, status: { notIn: ["DRAFT"] } },
    include: { allocations: { where: { state: { in: ["ACTIVE", "REVERSED"] } }, include: { charge: { include: { period: true } } } } },
    orderBy: { transferDate: "asc" },
  });
  const adjustments = await prisma.adjustment.findMany({ where: { membershipId }, include: { period: true }, orderBy: { createdAt: "asc" } });

  const monthly: ReportTable = {
    title: "Monthly charges and balances",
    columns: [{ key: "month", label: "Month" }, { key: "category", label: "Category" }, { key: "charged", label: "Charged", type: "money" }, { key: "adjusted", label: "Adjustments", type: "money" }, { key: "confirmed", label: "Payments allocated", type: "money" }, { key: "outstanding", label: "Remaining", type: "money" }],
    rows: lines.filter((l) => l.membershipId === membershipId && l.period >= from && l.period <= to).map((l) => ({ month: l.period, category: CATEGORY_LABELS[l.category], charged: l.charged, adjusted: l.adjusted, confirmed: l.confirmed, outstanding: l.outstanding })),
  };
  const paymentTable: ReportTable = {
    title: "Payments",
    columns: [{ key: "date", label: "Date", type: "date" }, { key: "amount", label: "Amount", type: "money" }, { key: "status", label: "Status", type: "status" }, { key: "allocations", label: "Allocated to", type: "lines" }, { key: "description", label: "Description", wrap: true }, { key: "id", label: "Transaction ID", type: "id" }],
    rows: payments.map((p) => ({
      id: p.id, date: isoDate(p.transferDate), amount: p.amountCents, status: p.status,
      allocations: allocationLines(p.allocations.map((a) => ({ period: a.charge.period.period, category: a.charge.category, amountCents: a.amountCents, reversed: a.state === "REVERSED" }))),
      description: p.description,
    })),
  };
  const adjustmentTable: ReportTable = {
    title: "Adjustments",
    columns: [{ key: "date", label: "Date", type: "date" }, { key: "month", label: "Month" }, { key: "category", label: "Category" }, { key: "kind", label: "Type" }, { key: "amount", label: "Amount", type: "money" }, { key: "reason", label: "Reason", wrap: true }],
    rows: adjustments.filter((a) => a.period.period >= from && a.period.period <= to).map((a) => ({ date: isoDate(a.createdAt), month: a.period.period, category: CATEGORY_LABELS[a.category as Category], kind: a.kind.replace(/_/g, " ").toLowerCase(), amount: a.amountCents, reason: a.reason })),
  };
  return {
    membership: m,
    from,
    to,
    summary,
    tables: [monthly, paymentTable, adjustmentTable],
    title: `Statement for ${m.displayName}, ${formatPeriod(from)} – ${formatPeriod(to)}`,
  };
}
