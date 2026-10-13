/**
 * Balance computation — the single source of truth for every figure shown in dashboards,
 * statements, charts, reminders and exports. Pure functions over a LedgerInput snapshot.
 *
 *   due         = Σ FINAL charges + Σ adjustments
 *   confirmed   = Σ ACTIVE allocations of VERIFIED payments to FINAL charges
 *   pending     = Σ PROPOSED allocations of submitted / under-review payments
 *   outstanding = due − confirmed
 */
import { sum, type Cents } from "./money";
import { addDays, comparePeriods, daysBetween, type Period } from "./period";
import {
  CATEGORIES,
  DEPOSIT_CATEGORIES,
  INCOME_CATEGORIES,
  PENDING_PAYMENT_STATUSES,
  type Category,
  type LedgerInput,
} from "./types";

export interface LedgerLine {
  membershipId: string;
  period: Period;
  category: Category;
  charged: Cents;
  adjusted: Cents;
  due: Cents;
  confirmed: Cents;
  pending: Cents;
  outstanding: Cents;
}

export type MemberPeriodStatus = "PAID" | "PENDING" | "OVERDUE" | "PARTIAL" | "DUE" | "NO_CHARGES";

export interface MonthSummary {
  period: Period;
  byCategory: Partial<Record<Category, LedgerLine>>;
  due: Cents;
  confirmed: Cents;
  pending: Cents;
  outstanding: Cents;
  dueDate: Date | null;
  status: MemberPeriodStatus;
}

const key = (m: string, p: Period, c: Category) => `${m}|${p}|${c}`;

/** Build ledger lines for every (membership, period, category) touched by the input. */
export function computeLines(input: LedgerInput): LedgerLine[] {
  const lines = new Map<string, LedgerLine>();
  const line = (membershipId: string, period: Period, category: Category) => {
    const k = key(membershipId, period, category);
    let l = lines.get(k);
    if (!l) {
      l = { membershipId, period, category, charged: 0, adjusted: 0, due: 0, confirmed: 0, pending: 0, outstanding: 0 };
      lines.set(k, l);
    }
    return l;
  };

  const finalCharges = new Map(input.charges.filter((c) => c.status === "FINAL").map((c) => [c.id, c]));
  for (const c of finalCharges.values()) line(c.membershipId, c.period, c.category).charged += c.amountCents;
  for (const a of input.adjustments) line(a.membershipId, a.period, a.category).adjusted += a.amountCents;

  for (const p of input.payments) {
    const verified = p.status === "VERIFIED";
    const pending = PENDING_PAYMENT_STATUSES.includes(p.status);
    if (!verified && !pending) continue;
    for (const a of p.allocations) {
      const charge = finalCharges.get(a.chargeId);
      if (!charge) continue; // draft / void charges never carry confirmed money
      if (charge.membershipId !== p.membershipId) {
        throw new Error(`Allocation ${a.id} links payment and charge of different residents`);
      }
      if (verified && a.state === "ACTIVE") line(charge.membershipId, charge.period, charge.category).confirmed += a.amountCents;
      else if (pending && a.state === "PROPOSED") line(charge.membershipId, charge.period, charge.category).pending += a.amountCents;
    }
  }

  for (const l of lines.values()) {
    l.due = l.charged + l.adjusted;
    l.outstanding = l.due - l.confirmed;
  }
  return [...lines.values()].sort(
    (a, b) => comparePeriods(a.period, b.period) || a.membershipId.localeCompare(b.membershipId) || CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category),
  );
}

export function memberPeriodStatus(
  m: { due: Cents; confirmed: Cents; pending: Cents; outstanding: Cents },
  dueDate: Date | null,
  today: Date,
  graceDays: number,
): MemberPeriodStatus {
  if (m.due === 0 && m.confirmed === 0) return "NO_CHARGES";
  if (m.outstanding <= 0) return "PAID";
  if (m.pending >= m.outstanding) return "PENDING";
  if (dueDate && daysBetween(addDays(dueDate, graceDays), today) > 0) return "OVERDUE";
  if (m.confirmed > 0) return "PARTIAL";
  return "DUE";
}

function aggregate(lines: readonly LedgerLine[]) {
  return {
    due: sum(lines.map((l) => l.due)),
    confirmed: sum(lines.map((l) => l.confirmed)),
    pending: sum(lines.map((l) => l.pending)),
    outstanding: sum(lines.map((l) => l.outstanding)),
  };
}

/** Earliest due date of a member's FINAL charges in a period. */
function dueDateOf(input: LedgerInput, membershipId: string | null, period: Period): Date | null {
  let d: Date | null = null;
  for (const c of input.charges) {
    if (c.status !== "FINAL" || c.period !== period) continue;
    if (membershipId && c.membershipId !== membershipId) continue;
    if (!d || c.dueDate < d) d = c.dueDate;
  }
  return d;
}

export interface MemberSummaryOptions {
  /** The "current" period (e.g. this month); later periods are excluded from to-date totals. */
  asOf: Period;
  today: Date;
  graceDays: number;
}

export interface MemberSummary {
  membershipId: string;
  current: MonthSummary;
  /** Income categories, periods ≤ asOf. */
  totalOutstanding: Cents;
  /** Income categories, periods < asOf and outstanding > 0. */
  overdueMonths: MonthSummary[];
  months: MonthSummary[];
  /** Σ amounts of VERIFIED payments. */
  totalVerifiedPayments: Cents;
  /** Σ ACTIVE allocations per category. */
  paidByCategory: Record<Category, Cents>;
  unallocatedCredit: Cents;
  depositDue: Cents;
  depositPaid: Cents;
  depositReturned: Cents;
  depositHeld: Cents;
  pendingSubmissionCount: number;
  pendingSubmissionCents: Cents;
}

/** Build month summaries (income categories only) for one member. */
export function memberMonths(input: LedgerInput, lines: readonly LedgerLine[], membershipId: string, today: Date, graceDays: number): MonthSummary[] {
  const byPeriod = new Map<Period, LedgerLine[]>();
  for (const l of lines) {
    if (l.membershipId !== membershipId || !INCOME_CATEGORIES.includes(l.category)) continue;
    const arr = byPeriod.get(l.period) ?? [];
    arr.push(l);
    byPeriod.set(l.period, arr);
  }
  return [...byPeriod.entries()]
    .sort(([a], [b]) => comparePeriods(a, b))
    .map(([period, ls]) => {
      const agg = aggregate(ls);
      const dueDate = dueDateOf(input, membershipId, period);
      return {
        period,
        byCategory: Object.fromEntries(ls.map((l) => [l.category, l])),
        ...agg,
        dueDate,
        status: memberPeriodStatus(agg, dueDate, today, graceDays),
      };
    });
}

export function emptyMonth(period: Period): MonthSummary {
  return { period, byCategory: {}, due: 0, confirmed: 0, pending: 0, outstanding: 0, dueDate: null, status: "NO_CHARGES" };
}

export function summarizeMember(input: LedgerInput, membershipId: string, opts: MemberSummaryOptions, lines = computeLines(input)): MemberSummary {
  const months = memberMonths(input, lines, membershipId, opts.today, opts.graceDays);
  const current = months.find((m) => m.period === opts.asOf) ?? emptyMonth(opts.asOf);
  const toDate = months.filter((m) => comparePeriods(m.period, opts.asOf) <= 0);

  const memberPayments = input.payments.filter((p) => p.membershipId === membershipId);
  const verified = memberPayments.filter((p) => p.status === "VERIFIED");
  const totalVerifiedPayments = sum(verified.map((p) => p.amountCents));
  const activeAllocated = sum(verified.flatMap((p) => p.allocations.filter((a) => a.state === "ACTIVE").map((a) => a.amountCents)));

  const paidByCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, Cents>;
  const depositLines = lines.filter((l) => l.membershipId === membershipId && DEPOSIT_CATEGORIES.includes(l.category));
  for (const l of lines) if (l.membershipId === membershipId) paidByCategory[l.category] += l.confirmed;

  const payouts = input.payouts.filter((p) => p.membershipId === membershipId && !p.reversed);
  const depositReturned = sum(payouts.filter((p) => p.kind !== "CREDIT_REFUND").map((p) => p.amountCents));
  const creditRefunded = sum(payouts.filter((p) => p.kind === "CREDIT_REFUND").map((p) => p.amountCents));
  const depositPaid = sum(depositLines.map((l) => l.confirmed));

  const pendingPayments = memberPayments.filter((p) => PENDING_PAYMENT_STATUSES.includes(p.status));

  return {
    membershipId,
    current,
    totalOutstanding: sum(toDate.map((m) => m.outstanding)),
    overdueMonths: toDate.filter((m) => m.period !== opts.asOf && m.outstanding > 0),
    months,
    totalVerifiedPayments,
    paidByCategory,
    unallocatedCredit: totalVerifiedPayments - activeAllocated - creditRefunded,
    depositDue: sum(depositLines.map((l) => l.due)),
    depositPaid,
    depositReturned,
    depositHeld: depositPaid - depositReturned,
    pendingSubmissionCount: pendingPayments.length,
    pendingSubmissionCents: sum(pendingPayments.map((p) => p.amountCents)),
  };
}

export interface PeriodCollection {
  period: Period;
  expected: Cents;
  confirmed: Cents;
  pending: Cents;
  outstanding: Cents;
  byMember: { membershipId: string; due: Cents; confirmed: Cents; pending: Cents; outstanding: Cents; status: MemberPeriodStatus }[];
}

/** Apartment-wide expected vs confirmed collection per period (income categories only). */
export function collectionByPeriod(
  input: LedgerInput,
  periods: readonly Period[],
  opts: { today: Date; graceDays: number },
  lines = computeLines(input),
): PeriodCollection[] {
  return periods.map((period) => {
    const ls = lines.filter((l) => l.period === period && INCOME_CATEGORIES.includes(l.category));
    const members = [...new Set(ls.map((l) => l.membershipId))].sort();
    const byMember = members.map((membershipId) => {
      const agg = aggregate(ls.filter((l) => l.membershipId === membershipId));
      return { membershipId, ...agg, status: memberPeriodStatus(agg, dueDateOf(input, membershipId, period), opts.today, opts.graceDays) };
    });
    const agg = aggregate(ls);
    return { period, expected: agg.due, confirmed: agg.confirmed, pending: agg.pending, outstanding: agg.outstanding, byMember };
  });
}

export interface ReconciliationCheck {
  ok: boolean;
  problems: string[];
}

/**
 * Cross-checks that the ledger is internally consistent:
 *  - no payment is over-allocated, no charge is over-paid
 *  - apartment-wide confirmed collection equals Σ member-level confirmed amounts
 *  - Σ verified payments = Σ active allocations + Σ unallocated credit (+ credit refunds)
 */
export function reconcile(input: LedgerInput): ReconciliationCheck {
  const problems: string[] = [];
  const charges = new Map(input.charges.map((c) => [c.id, c]));
  const perCharge = new Map<string, Cents>();
  for (const p of input.payments) {
    const active = p.status === "VERIFIED" ? p.allocations.filter((a) => a.state === "ACTIVE") : [];
    const allocated = sum(active.map((a) => a.amountCents));
    if (allocated > p.amountCents) problems.push(`Payment ${p.id} is over-allocated (${allocated} > ${p.amountCents}).`);
    for (const a of active) {
      if (a.amountCents <= 0) problems.push(`Allocation ${a.id} has a non-positive amount.`);
      perCharge.set(a.chargeId, (perCharge.get(a.chargeId) ?? 0) + a.amountCents);
      const c = charges.get(a.chargeId);
      if (!c) problems.push(`Allocation ${a.id} references a missing charge.`);
      else if (c.status !== "FINAL") problems.push(`Allocation ${a.id} is active on a ${c.status} charge.`);
    }
  }
  for (const [chargeId, allocated] of perCharge) {
    const c = charges.get(chargeId);
    if (c && allocated > c.amountCents) problems.push(`Charge ${chargeId} is over-paid (${allocated} > ${c.amountCents}).`);
  }
  const lines = computeLines(input);
  const lineConfirmed = sum(lines.map((l) => l.confirmed));
  const allocationConfirmed = sum([...perCharge.entries()].filter(([id]) => charges.get(id)?.status === "FINAL").map(([, v]) => v));
  if (lineConfirmed !== allocationConfirmed) problems.push(`Ledger lines (${lineConfirmed}) and allocations (${allocationConfirmed}) disagree.`);
  return { ok: problems.length === 0, problems };
}
