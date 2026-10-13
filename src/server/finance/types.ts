/**
 * Plain types used by the pure finance functions. They mirror the Prisma enums but keep the
 * calculation code independent of the database layer so it can be unit-tested in isolation.
 */
import type { Cents } from "./money";
import type { Period } from "./period";

export const CATEGORIES = [
  "RENT",
  "ELECTRICITY",
  "OPERATING_COSTS",
  "SHARED_EXPENSE",
  "SECURITY_DEPOSIT",
  "RENT_BUFFER",
  "OTHER",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Held funds: never counted as income / rent collected. */
export const DEPOSIT_CATEGORIES: readonly Category[] = ["SECURITY_DEPOSIT", "RENT_BUFFER"];
export const INCOME_CATEGORIES: readonly Category[] = CATEGORIES.filter((c) => !DEPOSIT_CATEGORIES.includes(c));

export function isDepositCategory(c: Category): boolean {
  return DEPOSIT_CATEGORIES.includes(c);
}

export const CATEGORY_LABELS: Record<Category, string> = {
  RENT: "Rent",
  ELECTRICITY: "Electricity",
  OPERATING_COSTS: "Operating costs",
  SHARED_EXPENSE: "Shared expense",
  SECURITY_DEPOSIT: "Security deposit",
  RENT_BUFFER: "Rent buffer deposit",
  OTHER: "Other",
};

export type AllocationMethod = "EQUAL_SPLIT" | "FIXED_PER_MEMBER" | "CUSTOM" | "PERCENTAGE";
export type ChargeStatus = "DRAFT" | "FINAL" | "VOID";
export type PaymentStatus =
  | "DRAFT"
  | "SUBMITTED"
  | "UNDER_REVIEW"
  | "CLARIFICATION_REQUESTED"
  | "VERIFIED"
  | "REJECTED"
  | "REVERSED";
export type AllocationState = "PROPOSED" | "ACTIVE" | "REVERSED";
export type PayoutKind = "DEPOSIT_REFUND" | "CREDIT_REFUND" | "DEPOSIT_APPLIED";

/** Statuses whose proposed allocations count as "pending". */
export const PENDING_PAYMENT_STATUSES: readonly PaymentStatus[] = ["SUBMITTED", "UNDER_REVIEW", "CLARIFICATION_REQUESTED"];

export interface MemberInfo {
  id: string;
  displayName: string;
  billingStart: Period;
  billingEnd: Period | null;
  /** Deterministic ordering key for rounding tie-breaks (move-in date, ms). */
  sortKey: number;
}

export interface RuleShareInput {
  membershipId: string;
  amountCents: Cents | null;
  basisPoints: number | null;
}

export interface RuleInput {
  id: string;
  version: number;
  name: string;
  category: Category;
  method: AllocationMethod;
  totalAmountCents: Cents | null;
  perMemberAmountCents: Cents | null;
  effectiveFrom: Period;
  effectiveTo: Period | null;
  shares: RuleShareInput[];
}

export interface LedgerCharge {
  id: string;
  membershipId: string;
  period: Period;
  category: Category;
  amountCents: Cents;
  status: ChargeStatus;
  dueDate: Date;
}

export interface LedgerAdjustment {
  id: string;
  membershipId: string;
  period: Period;
  category: Category;
  amountCents: Cents; // signed
}

export interface LedgerAllocation {
  id: string;
  chargeId: string;
  amountCents: Cents;
  state: AllocationState;
}

export interface LedgerPayment {
  id: string;
  membershipId: string;
  amountCents: Cents;
  status: PaymentStatus;
  transferDate: Date;
  allocations: LedgerAllocation[];
}

export interface LedgerPayout {
  id: string;
  membershipId: string;
  kind: PayoutKind;
  category: Category | null;
  amountCents: Cents;
  reversed: boolean;
}

export interface LedgerInput {
  charges: LedgerCharge[];
  adjustments: LedgerAdjustment[];
  payments: LedgerPayment[];
  payouts: LedgerPayout[];
}
