/**
 * Allocation suggestion and validation (pure). The DB service re-runs validateAllocations inside
 * the verification transaction with freshly locked rows, so these rules are always enforced.
 */
import { sum, type Cents } from "./money";
import { comparePeriods, type Period } from "./period";
import { CATEGORIES, type Category } from "./types";

export interface OpenCharge {
  id: string;
  membershipId: string;
  period: Period;
  category: Category;
  amountCents: Cents;
  status: "DRAFT" | "FINAL" | "VOID";
  /** Σ ACTIVE allocations from verified payments (excluding the payment being edited). */
  alreadyAllocatedCents: Cents;
}

export interface AllocationRequest {
  chargeId: string;
  amountCents: Cents;
}

export function openAmount(c: OpenCharge): Cents {
  return Math.max(0, c.amountCents - c.alreadyAllocatedCents);
}

/** Category priority when one transfer covers several things in the same month. */
const PRIORITY: Category[] = ["RENT", "ELECTRICITY", "OPERATING_COSTS", "SHARED_EXPENSE", "OTHER", "RENT_BUFFER", "SECURITY_DEPOSIT"];

/**
 * Suggest allocations oldest-first. When `periods` is given, only those months are considered.
 * Deposit categories are included only when `includeDeposit` is true (deposits are never
 * silently paid out of a rent transfer).
 */
export function suggestAllocations(
  amountCents: Cents,
  charges: readonly OpenCharge[],
  opts: { periods?: readonly Period[]; includeDeposit?: boolean } = {},
): { allocations: AllocationRequest[]; unallocatedCents: Cents } {
  const candidates = charges
    .filter((c) => c.status === "FINAL" && openAmount(c) > 0)
    .filter((c) => !opts.periods || opts.periods.length === 0 || opts.periods.includes(c.period))
    .filter((c) => opts.includeDeposit || (c.category !== "SECURITY_DEPOSIT" && c.category !== "RENT_BUFFER"))
    .sort((a, b) => comparePeriods(a.period, b.period) || PRIORITY.indexOf(a.category) - PRIORITY.indexOf(b.category) || CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category));
  let remaining = amountCents;
  const allocations: AllocationRequest[] = [];
  for (const c of candidates) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, openAmount(c));
    allocations.push({ chargeId: c.id, amountCents: take });
    remaining -= take;
  }
  return { allocations, unallocatedCents: remaining };
}

/** Validate a full set of allocations for one payment. Returns error messages (empty = valid). */
export function validateAllocations(
  payment: { membershipId: string; amountCents: Cents },
  requests: readonly AllocationRequest[],
  charges: readonly OpenCharge[],
): string[] {
  const errors: string[] = [];
  const byId = new Map(charges.map((c) => [c.id, c]));
  const seen = new Set<string>();
  for (const r of requests) {
    if (!Number.isSafeInteger(r.amountCents) || r.amountCents <= 0) {
      errors.push("Allocation amounts must be positive whole cents.");
      continue;
    }
    if (seen.has(r.chargeId)) errors.push("Each charge can appear only once per payment.");
    seen.add(r.chargeId);
    const c = byId.get(r.chargeId);
    if (!c) {
      errors.push("An allocation references an unknown charge.");
      continue;
    }
    if (c.membershipId !== payment.membershipId) errors.push("Payments can only be allocated to the payer's own charges.");
    if (c.status !== "FINAL") errors.push(`Charge for ${c.period} is not final and cannot receive payments.`);
    if (r.amountCents > openAmount(c)) errors.push(`Allocation for ${c.period} ${c.category.toLowerCase()} exceeds the open amount.`);
  }
  if (sum(requests.map((r) => r.amountCents)) > payment.amountCents) errors.push("Allocations exceed the payment amount.");
  return errors;
}
