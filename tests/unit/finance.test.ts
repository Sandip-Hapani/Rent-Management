import { describe, expect, it } from "vitest";
import { parseEuroToCents, numberToCents, splitEqually, splitByWeights, formatCents, centsToDecimalString } from "@/server/finance/money";
import { addMonths, defaultBillingEnd, defaultBillingStart, dueDateFor, periodsBetween, parseIsoDate } from "@/server/finance/period";
import { computeRuleCharges, generatePeriodCharges, previewPriceChange, validateRule } from "@/server/finance/rules";
import { collectionByPeriod, computeLines, reconcile, summarizeMember } from "@/server/finance/ledger";
import { suggestAllocations, validateAllocations, type OpenCharge } from "@/server/finance/allocation";
import type { LedgerCharge, LedgerInput, LedgerPayment, MemberInfo, RuleInput } from "@/server/finance/types";

const d = (s: string) => parseIsoDate(s)!;
const opts = { asOf: "2026-03", today: d("2026-03-20"), graceDays: 3 };

function member(id: string, billingStart = "2026-01", billingEnd: string | null = null, sortKey = 0): MemberInfo {
  return { id, displayName: id, billingStart, billingEnd, sortKey };
}

function rule(partial: Partial<RuleInput> & Pick<RuleInput, "id" | "category" | "method">): RuleInput {
  return { version: 1, name: partial.id, totalAmountCents: null, perMemberAmountCents: null, effectiveFrom: "2026-01", effectiveTo: null, shares: [], ...partial };
}

let seq = 0;
function charge(membershipId: string, period: string, category: LedgerCharge["category"], amountCents: number, status: LedgerCharge["status"] = "FINAL"): LedgerCharge {
  return { id: `c${++seq}`, membershipId, period, category, amountCents, status, dueDate: dueDateFor(period, 1) };
}
function payment(membershipId: string, amountCents: number, allocations: [LedgerCharge, number, ("ACTIVE" | "PROPOSED" | "REVERSED")?][], status: LedgerPayment["status"] = "VERIFIED"): LedgerPayment {
  return {
    id: `p${++seq}`,
    membershipId,
    amountCents,
    status,
    transferDate: d("2026-01-01"),
    allocations: allocations.map(([c, amt, state]) => ({ id: `a${++seq}`, chargeId: c.id, amountCents: amt, state: state ?? (status === "VERIFIED" ? "ACTIVE" : "PROPOSED") })),
  };
}
const ledger = (p: Partial<LedgerInput>): LedgerInput => ({ charges: [], adjustments: [], payments: [], payouts: [], ...p });

describe("money", () => {
  it("parses German and English formats into cents without floats", () => {
    expect(parseEuroToCents("198,40")).toBe(19840);
    expect(parseEuroToCents("198.4")).toBe(19840);
    expect(parseEuroToCents("1.234,56")).toBe(123456);
    expect(parseEuroToCents("1,234.56")).toBe(123456);
    expect(parseEuroToCents("€ 25")).toBe(2500);
    expect(parseEuroToCents("0.1")).toBe(10);
    expect(parseEuroToCents("abc")).toBeNull();
    expect(parseEuroToCents("12.345")).toBe(1234500); // grouping
    expect(numberToCents(214.89)).toBe(21489);
    expect(numberToCents(0.1 + 0.2)).toBe(30);
    expect(centsToDecimalString(-505)).toBe("-5.05");
    expect(formatCents(19840)).toContain("198,40");
  });

  it("splits with the largest-remainder method and always reconciles", () => {
    expect(splitEqually(99200, 6)).toEqual([16534, 16534, 16533, 16533, 16533, 16533]);
    expect(splitEqually(100, 3)).toEqual([34, 33, 33]);
    for (let total = 0; total < 2000; total += 7) {
      for (let n = 1; n <= 7; n++) expect(splitEqually(total, n).reduce((a, b) => a + b, 0)).toBe(total);
    }
    expect(splitByWeights(10000, [5000, 3000, 2000])).toEqual([5000, 3000, 2000]);
    expect(splitByWeights(1001, [3333, 3333, 3334]).reduce((a, b) => a + b)).toBe(1001);
    expect(() => splitEqually(100, 0)).toThrow();
  });
});

describe("periods", () => {
  it("does month arithmetic and due dates", () => {
    expect(addMonths("2025-12", 1)).toBe("2026-01");
    expect(addMonths("2026-01", -13)).toBe("2024-12");
    expect(periodsBetween("2025-11", "2026-02")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(dueDateFor("2026-02", 31).toISOString().slice(0, 10)).toBe("2026-02-28");
    expect(defaultBillingStart(d("2025-11-10"))).toBe("2025-11");
    expect(defaultBillingStart(d("2025-11-20"))).toBe("2025-12");
    expect(defaultBillingEnd(d("2025-11-30"))).toBe("2025-11");
    expect(defaultBillingEnd(d("2025-12-05"))).toBe("2025-11");
  });
});

describe("charge rules", () => {
  const members = [member("a", "2026-01", null, 1), member("b", "2026-01", null, 2), member("c", "2026-01", null, 3)];

  it("equal split reconciles to the apartment total", () => {
    const r = computeRuleCharges(rule({ id: "r", category: "RENT", method: "EQUAL_SPLIT", totalAmountCents: 100000 }), members, "2026-01");
    expect(r.charges.map((c) => c.amountCents)).toEqual([33334, 33333, 33333]);
    expect(r.generatedTotalCents).toBe(100000);
    expect(r.warnings).toEqual([]);
  });

  it("supports fixed, custom and percentage methods (no equal-amount assumption)", () => {
    const fixed = computeRuleCharges(rule({ id: "f", category: "ELECTRICITY", method: "FIXED_PER_MEMBER", perMemberAmountCents: 2560 }), members, "2026-01");
    expect(fixed.charges.map((c) => c.amountCents)).toEqual([2560, 2560, 2560]);

    const custom = computeRuleCharges(
      rule({ id: "x", category: "RENT", method: "CUSTOM", shares: [{ membershipId: "a", amountCents: 25000, basisPoints: null }, { membershipId: "b", amountCents: 20000, basisPoints: null }] }),
      members,
      "2026-01",
    );
    expect(custom.charges.map((c) => [c.membershipId, c.amountCents])).toEqual([["a", 25000], ["b", 20000]]);

    const pct = rule({
      id: "p", category: "SHARED_EXPENSE", method: "PERCENTAGE", totalAmountCents: 10001,
      shares: [{ membershipId: "a", amountCents: null, basisPoints: 5000 }, { membershipId: "b", amountCents: null, basisPoints: 2500 }, { membershipId: "c", amountCents: null, basisPoints: 2500 }],
    });
    expect(validateRule(pct)).toEqual([]);
    const r = computeRuleCharges(pct, members, "2026-01");
    expect(r.generatedTotalCents).toBe(10001);
    expect(validateRule({ ...pct, shares: pct.shares.slice(0, 2) })[0]).toMatch(/100%/);
  });

  it("handles residents joining and leaving (six-way overlap month like Nov 2025)", () => {
    const ms = [
      member("leaver", "2024-06", "2025-11", 1),
      member("r2", "2024-06", null, 2),
      member("r3", "2024-06", null, 3),
      member("r4", "2024-06", null, 4),
      member("contact", "2024-06", null, 5),
      member("joiner", "2025-11", null, 6),
    ];
    const r = rule({ id: "r", category: "RENT", method: "EQUAL_SPLIT", totalAmountCents: 99200, effectiveFrom: "2025-07" });
    const nov = computeRuleCharges(r, ms, "2025-11");
    expect(nov.charges).toHaveLength(6);
    expect(nov.generatedTotalCents).toBe(99200);
    const dec = computeRuleCharges(r, ms, "2025-12");
    expect(dec.charges.map((c) => c.membershipId)).not.toContain("leaver");
    expect(dec.charges.every((c) => c.amountCents === 19840)).toBe(true);
    expect(computeRuleCharges(r, ms, "2025-10").charges.map((c) => c.membershipId)).not.toContain("joiner");
  });

  it("applies a future price change only from its effective month", () => {
    const old = rule({ id: "e1", category: "ELECTRICITY", method: "FIXED_PER_MEMBER", perMemberAmountCents: 2360, effectiveFrom: "2026-01", effectiveTo: "2026-03" });
    const neu = rule({ id: "e2", version: 2, category: "ELECTRICITY", method: "FIXED_PER_MEMBER", perMemberAmountCents: 2560, effectiveFrom: "2026-04" });
    const rent = rule({ id: "r1", category: "RENT", method: "FIXED_PER_MEMBER", perMemberAmountCents: 17000, effectiveFrom: "2026-01" });
    const march = generatePeriodCharges([old, neu, rent], members, "2026-03");
    const april = generatePeriodCharges([old, neu, rent], members, "2026-04");
    expect(march.charges.filter((c) => c.category === "ELECTRICITY").every((c) => c.amountCents === 2360 && c.ruleId === "e1")).toBe(true);
    expect(april.charges.filter((c) => c.category === "ELECTRICITY").every((c) => c.amountCents === 2560 && c.ruleId === "e2")).toBe(true);
    // Rent unaffected by an electricity change with a different effective date.
    expect(april.charges.filter((c) => c.category === "RENT").every((c) => c.amountCents === 17000)).toBe(true);

    const preview = previewPriceChange([old], neu, members, "2026-04");
    expect(preview.map((p) => p.differenceCents)).toEqual([200, 200, 200]);
  });
});

describe("ledger", () => {
  it("full rent payment clears the month", () => {
    const rent = charge("a", "2026-03", "RENT", 20160);
    const input = ledger({ charges: [rent], payments: [payment("a", 20160, [[rent, 20160]])] });
    const s = summarizeMember(input, "a", opts);
    expect(s.current.outstanding).toBe(0);
    expect(s.current.status).toBe("PAID");
    expect(s.totalVerifiedPayments).toBe(20160);
    expect(reconcile(input).ok).toBe(true);
  });

  it("partial payment leaves the remainder outstanding", () => {
    const rent = charge("a", "2026-03", "RENT", 25000);
    const s = summarizeMember(ledger({ charges: [rent], payments: [payment("a", 20000, [[rent, 20000]])] }), "a", opts);
    expect(s.current.outstanding).toBe(5000);
    expect(s.current.status).toBe("OVERDUE"); // 20 March > 1 March + 3 days grace
  });

  it("rent and electricity paid together via one transfer stay separately identifiable", () => {
    const rent = charge("a", "2026-03", "RENT", 17600);
    const elec = charge("a", "2026-03", "ELECTRICITY", 2560);
    const input = ledger({ charges: [rent, elec], payments: [payment("a", 20160, [[rent, 17600], [elec, 2560]])] });
    const s = summarizeMember(input, "a", opts);
    expect(s.current.outstanding).toBe(0);
    expect(s.paidByCategory.RENT).toBe(17600);
    expect(s.paidByCategory.ELECTRICITY).toBe(2560);
  });

  it("one transfer across multiple months is counted once", () => {
    const jan = charge("a", "2026-01", "RENT", 20000);
    const feb = charge("a", "2026-02", "RENT", 20000);
    const input = ledger({ charges: [jan, feb], payments: [payment("a", 40000, [[jan, 20000], [feb, 20000]])] });
    const col = collectionByPeriod(input, ["2026-01", "2026-02"], opts);
    expect(col.map((c) => c.confirmed)).toEqual([20000, 20000]);
    expect(col.reduce((a, c) => a + c.confirmed, 0)).toBe(40000);
  });

  it("several transfers can pay one obligation", () => {
    const rent = charge("a", "2026-03", "RENT", 20000);
    const input = ledger({ charges: [rent], payments: [payment("a", 5000, [[rent, 5000]]), payment("a", 15000, [[rent, 15000]])] });
    expect(summarizeMember(input, "a", opts).current.outstanding).toBe(0);
  });

  it("keeps deposits separate from rent income", () => {
    const rent = charge("a", "2026-03", "RENT", 16940);
    const dep = charge("a", "2026-03", "SECURITY_DEPOSIT", 20680);
    const input = ledger({ charges: [rent, dep], payments: [payment("a", 37620, [[rent, 16940], [dep, 20680]])] });
    const s = summarizeMember(input, "a", opts);
    expect(s.depositPaid).toBe(20680);
    expect(s.depositHeld).toBe(20680);
    const col = collectionByPeriod(input, ["2026-03"], opts)[0]!;
    expect(col.expected).toBe(16940); // deposit is not expected income
    expect(col.confirmed).toBe(16940);
  });

  it("records overpayment as unallocated credit, not lost", () => {
    const rent = charge("a", "2026-03", "RENT", 20000);
    const s = summarizeMember(ledger({ charges: [rent], payments: [payment("a", 25000, [[rent, 20000]])] }), "a", opts);
    expect(s.current.outstanding).toBe(0);
    expect(s.unallocatedCredit).toBe(5000);
  });

  it("pending submissions never reduce the confirmed balance", () => {
    const rent = charge("a", "2026-03", "RENT", 20000);
    const input = ledger({ charges: [rent], payments: [payment("a", 20000, [[rent, 20000]], "SUBMITTED")] });
    const s = summarizeMember(input, "a", opts);
    expect(s.current.outstanding).toBe(20000);
    expect(s.current.pending).toBe(20000);
    expect(s.current.status).toBe("PENDING");
    expect(s.pendingSubmissionCount).toBe(1);
    const col = collectionByPeriod(input, ["2026-03"], opts)[0]!;
    expect(col.confirmed).toBe(0);
    expect(col.pending).toBe(20000);
  });

  it("ignores rejected/reversed payments, reversed allocations and draft/void charges", () => {
    const rent = charge("a", "2026-03", "RENT", 20000);
    const draft = charge("a", "2026-03", "ELECTRICITY", 3000, "DRAFT");
    const input = ledger({
      charges: [rent, draft],
      payments: [
        payment("a", 20000, [[rent, 20000]], "REJECTED"),
        payment("a", 20000, [[rent, 20000]], "REVERSED"),
        payment("a", 20000, [[rent, 20000, "REVERSED"]]),
      ],
    });
    const s = summarizeMember(input, "a", opts);
    expect(s.current.due).toBe(20000);
    expect(s.current.outstanding).toBe(20000);
    expect(s.unallocatedCredit).toBe(20000); // the verified one whose allocation was reversed
  });

  it("applies adjustments, refunds and reversals explicitly", () => {
    const rent = charge("a", "2026-03", "RENT", 20000);
    const dep = charge("a", "2026-01", "SECURITY_DEPOSIT", 20680);
    const input = ledger({
      charges: [rent, dep],
      adjustments: [
        { id: "adj1", membershipId: "a", period: "2026-03", category: "RENT", amountCents: -709 }, // Splitwise settlement credit
        { id: "adj2", membershipId: "a", period: "2026-03", category: "OPERATING_COSTS", amountCents: 31868 }, // Betriebskosten
      ],
      payments: [payment("a", 20680, [[dep, 20680]]), payment("a", 19291, [[rent, 19291]])],
      payouts: [
        { id: "po1", membershipId: "a", kind: "DEPOSIT_REFUND", category: "SECURITY_DEPOSIT", amountCents: 20680, reversed: false },
        { id: "po2", membershipId: "a", kind: "DEPOSIT_REFUND", category: "SECURITY_DEPOSIT", amountCents: 999, reversed: true },
      ],
    });
    const s = summarizeMember(input, "a", opts);
    expect(s.current.byCategory.RENT!.outstanding).toBe(0);
    expect(s.current.byCategory.OPERATING_COSTS!.outstanding).toBe(31868);
    expect(s.depositHeld).toBe(0);
    expect(s.depositReturned).toBe(20680);
  });

  it("builds the month-by-month outstanding breakdown and to-date totals", () => {
    const cs = [
      charge("a", "2026-01", "RENT", 25000), charge("a", "2026-01", "ELECTRICITY", 3500),
      charge("a", "2026-02", "RENT", 25000), charge("a", "2026-02", "ELECTRICITY", 4000),
      charge("a", "2026-03", "RENT", 25000), charge("a", "2026-03", "ELECTRICITY", 3500),
      charge("a", "2026-04", "RENT", 25000),
    ];
    const input = ledger({ charges: cs, payments: [payment("a", 25000, [[cs[0]!, 25000]]), payment("a", 20000, [[cs[2]!, 20000]])] });
    const s = summarizeMember(input, "a", opts);
    expect(s.months.map((m) => m.outstanding)).toEqual([3500, 9000, 28500, 25000]);
    expect(s.totalOutstanding).toBe(3500 + 9000 + 28500); // April is in the future
    expect(s.overdueMonths.map((m) => m.period)).toEqual(["2026-01", "2026-02"]);
  });

  it("apartment-wide totals reconcile with resident-level records", () => {
    const members = ["a", "b", "c", "d", "e"];
    const cs = members.flatMap((m) => [charge(m, "2026-03", "RENT", 17600), charge(m, "2026-03", "ELECTRICITY", 2560)]);
    const pays = [payment("a", 20160, [[cs[0]!, 17600], [cs[1]!, 2560]]), payment("b", 17600, [[cs[2]!, 17600]]), payment("c", 20160, [[cs[4]!, 17600], [cs[5]!, 2560]], "SUBMITTED")];
    const input = ledger({ charges: cs, payments: pays });
    const col = collectionByPeriod(input, ["2026-03"], opts)[0]!;
    expect(col.expected).toBe(5 * 20160);
    expect(col.confirmed).toBe(20160 + 17600);
    expect(col.byMember.reduce((a, m) => a + m.confirmed, 0)).toBe(col.confirmed);
    expect(col.byMember.reduce((a, m) => a + m.outstanding, 0)).toBe(col.outstanding);
    const lines = computeLines(input);
    expect(lines.reduce((a, l) => a + l.due, 0)).toBe(col.expected);
    expect(reconcile(input).ok).toBe(true);
  });

  it("reconcile() detects over-allocation", () => {
    const rent = charge("a", "2026-03", "RENT", 100);
    const bad = ledger({ charges: [rent], payments: [payment("a", 50, [[rent, 80]])] });
    expect(reconcile(bad).ok).toBe(false);
  });
});

describe("allocation", () => {
  const open = (id: string, period: string, category: OpenCharge["category"], amountCents: number, already = 0): OpenCharge => ({
    id, membershipId: "a", period, category, amountCents, status: "FINAL", alreadyAllocatedCents: already,
  });

  it("suggests oldest-first allocations, skipping deposits unless asked, and reports the remainder", () => {
    const charges = [open("feb-r", "2026-02", "RENT", 20000, 15000), open("jan-e", "2026-01", "ELECTRICITY", 3000), open("jan-r", "2026-01", "RENT", 20000), open("dep", "2026-01", "SECURITY_DEPOSIT", 20680)];
    const s = suggestAllocations(30000, charges);
    expect(s.allocations).toEqual([
      { chargeId: "jan-r", amountCents: 20000 },
      { chargeId: "jan-e", amountCents: 3000 },
      { chargeId: "feb-r", amountCents: 5000 },
    ]);
    expect(s.unallocatedCents).toBe(2000);
    expect(suggestAllocations(1000, charges, { periods: ["2026-02"] }).allocations).toEqual([{ chargeId: "feb-r", amountCents: 1000 }]);
    expect(suggestAllocations(50000, charges, { includeDeposit: true }).allocations.map((a) => a.chargeId)).toContain("dep");
  });

  it("rejects over-allocation, foreign charges and non-final charges", () => {
    const charges = [open("r", "2026-03", "RENT", 20000, 5000), { ...open("x", "2026-03", "RENT", 20000), membershipId: "b" }, { ...open("d", "2026-03", "ELECTRICITY", 100), status: "DRAFT" as const }];
    expect(validateAllocations({ membershipId: "a", amountCents: 20000 }, [{ chargeId: "r", amountCents: 15000 }], charges)).toEqual([]);
    expect(validateAllocations({ membershipId: "a", amountCents: 20000 }, [{ chargeId: "r", amountCents: 15001 }], charges)[0]).toMatch(/exceeds the open amount/);
    expect(validateAllocations({ membershipId: "a", amountCents: 100 }, [{ chargeId: "r", amountCents: 200 }], charges)).toContain("Allocations exceed the payment amount.");
    expect(validateAllocations({ membershipId: "a", amountCents: 20000 }, [{ chargeId: "x", amountCents: 100 }], charges)[0]).toMatch(/payer's own/);
    expect(validateAllocations({ membershipId: "a", amountCents: 20000 }, [{ chargeId: "d", amountCents: 100 }], charges)[0]).toMatch(/not final/);
    expect(validateAllocations({ membershipId: "a", amountCents: 20000 }, [{ chargeId: "r", amountCents: 0 }], charges)[0]).toMatch(/positive/);
  });
});
