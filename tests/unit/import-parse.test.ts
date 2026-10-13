import { describe, expect, it } from "vitest";
import { evaluateSimpleFormula, inferPeriod, markDuplicates, matchResident, monthIndex, normalizeName, rowStatus, type NormalizedRow } from "@/server/imports/parse";

const d = (s: string) => new Date(`${s}T12:00:00Z`);
const dir = { exact: new Map([["john", "m-john"], ["mia", "m-mia"], ["omar", "m-omar"]]) };

describe("legacy import parsing", () => {
  it("evaluates only plain additive formulas, in cents", () => {
    expect(evaluateSimpleFormula("=169.4+206.8")).toEqual([16940, 20680]);
    expect(evaluateSimpleFormula("191.8+6.6+132.17")).toEqual([19180, 660, 13217]);
    expect(evaluateSimpleFormula("=100-25,5")).toEqual([10000, -2550]);
    expect(evaluateSimpleFormula("=SUM(A1:A3)")).toBeNull();
    expect(evaluateSimpleFormula("=1+HYPERLINK(\"x\")")).toBeNull();
  });

  it("infers the year of a month-only rent period from a reference date", () => {
    expect(inferPeriod(6, d("2024-07-02"))).toBe("2024-06"); // paid a month late
    expect(inferPeriod(8, d("2024-07-26"))).toBe("2024-08"); // paid in advance
    expect(inferPeriod(1, d("2025-12-30"))).toBe("2026-01"); // across new year
    expect(inferPeriod(12, d("2026-01-02"))).toBe("2025-12");
    expect(inferPeriod(8, d("2026-10-05"))).toBe("2026-08"); // two months late
  });

  it("parses month names", () => {
    expect(monthIndex("September")).toBe(9);
    expect(monthIndex("sept")).toBe(9);
    expect(monthIndex("Foo")).toBeNull();
  });

  it("matches residents exactly, flags paid-by-other and near-miss spellings", () => {
    expect(matchResident("John", dir)).toEqual({ membershipId: "m-john", suggested: null, issues: [] });
    expect(matchResident(" Omar ", dir).membershipId).toBe("m-omar");
    const byOther = matchResident("John (By Mia)", dir);
    expect(byOther.membershipId).toBeNull();
    expect(byOther.suggested).toBe("m-john");
    expect(byOther.issues).toEqual(["AMBIGUOUS_RESIDENT", "PAID_BY_OTHER"]);
    const typo = matchResident("Jhon ", dir);
    expect(typo.suggested).toBe("m-john");
    expect(typo.issues).toContain("AMBIGUOUS_RESIDENT");
    expect(matchResident("Stranger", dir).issues).toContain("UNKNOWN_RESIDENT");
    expect(normalizeName("  José   Doe ")).toBe("jose doe");
  });

  it("flags duplicates within the file and against existing payments", () => {
    const base = { rowNumber: 0, raw: {}, submittedAt: null, monthName: "March", bank: null, amountText: null, amountNumber: null, amountFormula: null, description: null, nameRaw: "Lena", note: null, includesDeposit: false, includesElectricity: true, amountParts: [], period: "2026-03", periodByTransfer: "2026-03", duplicateOfRow: null, membershipId: "m-d", suggestedMembershipId: null };
    const rows: NormalizedRow[] = [
      { ...base, rowNumber: 95, amountCents: 20160, transferDate: d("2026-03-29"), issues: [] },
      { ...base, rowNumber: 96, period: "2026-04", amountCents: 20160, transferDate: d("2026-03-29"), issues: [] },
      { ...base, rowNumber: 97, amountCents: 20160, transferDate: d("2026-04-29"), issues: [] },
    ];
    markDuplicates(rows, [{ membershipId: "m-d", amountCents: 20160, transferDate: d("2026-04-27") }]);
    expect(rows[0]!.issues).toContain("POSSIBLE_DUPLICATE");
    expect(rows[1]!.duplicateOfRow).toBe(95);
    expect(rows[2]!.issues).toContain("POSSIBLE_DUPLICATE"); // within ±3 days of an existing payment
    expect(rowStatus(rows[2]!.issues, "m-d")).toBe("NEEDS_REVIEW");
    expect(rowStatus([], "m-d")).toBe("READY");
    expect(rowStatus(["FORMULA_AMOUNT"], "m-d")).toBe("READY");
    expect(rowStatus([], null)).toBe("NEEDS_REVIEW");
  });
});
