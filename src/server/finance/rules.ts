/**
 * Charge-rule resolution and monthly obligation generation (pure functions).
 */
import { splitByWeights, splitEqually, sum, type Cents } from "./money";
import { comparePeriods, isWithin, type Period } from "./period";
import type { Category, MemberInfo, RuleInput } from "./types";

export interface GeneratedCharge {
  membershipId: string;
  category: Category;
  ruleId: string;
  ruleVersion: number;
  amountCents: Cents;
}

export interface RuleResult {
  ruleId: string;
  category: Category;
  /** Apartment-wide total the rule should produce (null when not defined by the method). */
  expectedTotalCents: Cents | null;
  generatedTotalCents: Cents;
  charges: GeneratedCharge[];
  warnings: string[];
}

export function activeMembers(members: readonly MemberInfo[], period: Period): MemberInfo[] {
  return members
    .filter((m) => isWithin(period, m.billingStart, m.billingEnd))
    .sort((a, b) => a.sortKey - b.sortKey || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function ruleApplies(rule: RuleInput, period: Period): boolean {
  return isWithin(period, rule.effectiveFrom, rule.effectiveTo);
}

/** Validate a rule's configuration; returns human-readable problems (empty = valid). */
export function validateRule(rule: RuleInput): string[] {
  const errors: string[] = [];
  if (rule.effectiveTo && comparePeriods(rule.effectiveTo, rule.effectiveFrom) < 0) {
    errors.push("The end month must not be before the effective month.");
  }
  switch (rule.method) {
    case "EQUAL_SPLIT":
      if (rule.totalAmountCents == null || rule.totalAmountCents < 0) errors.push("Enter the apartment-wide monthly total.");
      break;
    case "FIXED_PER_MEMBER":
      if (rule.perMemberAmountCents == null || rule.perMemberAmountCents < 0) errors.push("Enter the amount per resident.");
      break;
    case "CUSTOM":
      if (rule.shares.length === 0) errors.push("Enter at least one resident amount.");
      if (rule.shares.some((s) => s.amountCents == null || s.amountCents < 0)) errors.push("Every custom amount must be zero or more.");
      break;
    case "PERCENTAGE": {
      if (rule.totalAmountCents == null || rule.totalAmountCents < 0) errors.push("Enter the apartment-wide monthly total.");
      const bp = rule.shares.map((s) => s.basisPoints ?? -1);
      if (bp.some((b) => b < 0)) errors.push("Every percentage must be zero or more.");
      if (sum(bp) !== 10_000) errors.push(`Percentages must add up to 100% (currently ${(sum(bp) / 100).toFixed(2)}%).`);
      break;
    }
  }
  return errors;
}

/** Compute the per-member charges one rule produces for one period. */
export function computeRuleCharges(rule: RuleInput, members: readonly MemberInfo[], period: Period): RuleResult {
  const warnings: string[] = [];
  const active = activeMembers(members, period);
  const shareBy = new Map(rule.shares.map((s) => [s.membershipId, s]));
  const result = (amounts: { m: MemberInfo; cents: Cents }[], expected: Cents | null): RuleResult => {
    const charges = amounts
      .filter((a) => a.cents > 0)
      .map((a) => ({ membershipId: a.m.id, category: rule.category, ruleId: rule.id, ruleVersion: rule.version, amountCents: a.cents }));
    const generatedTotalCents = sum(charges.map((c) => c.amountCents));
    if (expected != null && generatedTotalCents !== expected) {
      warnings.push(`Generated total ${generatedTotalCents} differs from the configured total ${expected}.`);
    }
    return { ruleId: rule.id, category: rule.category, expectedTotalCents: expected, generatedTotalCents, charges, warnings };
  };

  switch (rule.method) {
    case "EQUAL_SPLIT": {
      const participants = rule.shares.length > 0 ? active.filter((m) => shareBy.has(m.id)) : active;
      const total = rule.totalAmountCents ?? 0;
      if (participants.length === 0) {
        if (total > 0) warnings.push(`No active residents to split "${rule.name}" between.`);
        return result([], total > 0 ? total : null);
      }
      const parts = splitEqually(total, participants.length);
      return result(participants.map((m, i) => ({ m, cents: parts[i]! })), total);
    }
    case "FIXED_PER_MEMBER": {
      const participants = rule.shares.length > 0 ? active.filter((m) => shareBy.has(m.id)) : active;
      const each = rule.perMemberAmountCents ?? 0;
      return result(participants.map((m) => ({ m, cents: each })), each * participants.length);
    }
    case "CUSTOM": {
      const amounts = active.filter((m) => shareBy.has(m.id)).map((m) => ({ m, cents: shareBy.get(m.id)!.amountCents ?? 0 }));
      for (const s of rule.shares) {
        if (!active.some((m) => m.id === s.membershipId) && (s.amountCents ?? 0) > 0) {
          warnings.push(`A resident with a custom amount is not active in ${period} and was not charged.`);
        }
      }
      return result(amounts, null);
    }
    case "PERCENTAGE": {
      const total = rule.totalAmountCents ?? 0;
      const participants = active.filter((m) => (shareBy.get(m.id)?.basisPoints ?? 0) > 0);
      const activeBp = sum(participants.map((m) => shareBy.get(m.id)!.basisPoints!));
      if (participants.length === 0) {
        if (total > 0) warnings.push(`No active residents with a percentage for "${rule.name}".`);
        return result([], total > 0 ? total : null);
      }
      if (activeBp !== 10_000) {
        warnings.push(`Active residents' percentages add up to ${(activeBp / 100).toFixed(2)}%; the total was re-weighted between them.`);
      }
      const parts = splitByWeights(total, participants.map((m) => shareBy.get(m.id)!.basisPoints!));
      return result(participants.map((m, i) => ({ m, cents: parts[i]! })), total);
    }
  }
}

/** Generate all charges for a period from every applicable rule. */
export function generatePeriodCharges(rules: readonly RuleInput[], members: readonly MemberInfo[], period: Period) {
  const results = rules.filter((r) => ruleApplies(r, period)).map((r) => computeRuleCharges(r, members, period));
  return {
    results,
    charges: results.flatMap((r) => r.charges),
    warnings: results.flatMap((r) => r.warnings),
  };
}

export interface PriceChangePreviewRow {
  membershipId: string;
  displayName: string;
  previousCents: Cents;
  newCents: Cents;
  differenceCents: Cents;
}

/** Per-member before/after for a price change in a category, effective from `period`. */
export function previewPriceChange(
  previousRules: readonly RuleInput[],
  newRule: RuleInput,
  members: readonly MemberInfo[],
  period: Period,
): PriceChangePreviewRow[] {
  const prev = new Map<string, Cents>();
  for (const r of previousRules) {
    for (const c of computeRuleCharges(r, members, period).charges) prev.set(c.membershipId, (prev.get(c.membershipId) ?? 0) + c.amountCents);
  }
  const next = new Map(computeRuleCharges(newRule, members, period).charges.map((c) => [c.membershipId, c.amountCents]));
  return activeMembers(members, period).map((m) => {
    const previousCents = prev.get(m.id) ?? 0;
    const newCents = next.get(m.id) ?? 0;
    return { membershipId: m.id, displayName: m.displayName, previousCents, newCents, differenceCents: newCents - previousCents };
  });
}
