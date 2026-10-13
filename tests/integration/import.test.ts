import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { commitBatch, getBatch, mapAlias, resolveRow, stageImport, verifyImportedWithFullMatch } from "@/server/imports/service";
import { getMemberSummary } from "@/server/finance/queries";
import { createWorld, fakeFile, openMonth, resetDb, standardPricing, type World } from "./fixtures";

let w: World;

/** Build a workbook shaped like the Google-Form export (same headers, quirks included). */
async function legacyWorkbook(): Promise<File> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Form responses 1");
  ws.addRow(["Timestamp", "For Which month are you transfering", "Does it include Deposit?", "Does it include Electricity?", "Date", "", "Select Bank", "Transfered amount in Euro", "Descriptions", "Email address", "Name", ""]);
  const rows: unknown[][] = [
    [new Date("2026-01-02T10:00:00Z"), "January", "No", "Yes", new Date("2026-01-02T00:00:00Z"), null, "Sparkasse", 235, "Jan rent + elec", "", "Ravi", null],
    [new Date("2026-01-03T10:00:00Z"), "January", "No", "Yes", new Date("2026-01-03T00:00:00Z"), null, "Wise", { formula: "200+35", result: 235 }, "Jan", "", "Lena", null],
    [new Date("2026-01-03T10:05:00Z"), "January", "No", "Yes", new Date("2026-01-03T00:00:00Z"), null, "Wise", 235, "Jan again?", "", "Lena", null], // duplicate
    [new Date("2026-01-04T00:00:00Z"), "January", "No", "Yes", new Date("2026-01-04T00:00:00Z"), null, "N-26", 235, "Jan", "", "Omarr", "Manually added after discussing"], // typo + note
    [new Date("2026-01-05T09:00:00Z"), "January", "No", "Yes", new Date("2027-01-05T00:00:00Z"), null, "Deutsche Bank", 235, "Jan", "", "Mia (By Ravi)", null], // year typo, paid by other
    [new Date("2026-01-05T09:00:00Z"), "January", "No", "Yes", new Date("2026-01-05T00:00:00Z"), null, "Deutsche Bank", null, "no amount", "", "Hanna", null],
    [new Date("2026-01-06T09:00:00Z"), "January", "No", "No", new Date("2026-01-06T00:00:00Z"), null, "Deutsche Bank", 50, "?", "", "Stranger", null],
  ];
  rows.forEach((r) => ws.addRow(r));
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  return fakeFile(buf, "Rent Tracker.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}

beforeEach(async () => {
  await resetDb();
  w = await createWorld();
  await standardPricing(w);
  await openMonth(w, "2026-01");
});

describe("historical import", () => {
  it("stages every row with issues, resolves, commits without silently dropping anything", async () => {
    const batch = await stageImport(w.admin, await legacyWorkbook());
    const { batch: b, summary } = await getBatch(w.admin, batch.id);
    expect(summary.total).toBe(7);
    const byRow = new Map(b.rows.map((r) => [r.rowNumber, r]));
    expect(byRow.get(2)!.status).toBe("READY");
    expect(byRow.get(3)!.amountParts).toEqual([20_000, 3_500]);
    expect(byRow.get(3)!.issues).toContain("FORMULA_AMOUNT");
    expect(byRow.get(4)!.issues).toContain("POSSIBLE_DUPLICATE");
    expect(byRow.get(4)!.duplicateOfRow).toBe(3);
    expect(byRow.get(5)!.issues).toEqual(expect.arrayContaining(["AMBIGUOUS_RESIDENT", "MANUAL_NOTE", "MANUALLY_ENTERED"]));
    expect(byRow.get(6)!.issues).toEqual(expect.arrayContaining(["DATE_INCONSISTENT", "PAID_BY_OTHER", "AMBIGUOUS_RESIDENT"]));
    expect(byRow.get(6)!.period).toBe("2026-01"); // year from the submission, flagged — not trusted blindly
    expect(byRow.get(7)!.issues).toContain("MISSING_AMOUNT");
    expect(byRow.get(8)!.issues).toContain("UNKNOWN_RESIDENT");
    expect(summary.unresolved).toBeGreaterThanOrEqual(5);

    // Admin decisions
    const omar = w.residents[2]!;
    expect(await mapAlias(w.admin, batch.id, "Omarr", omar.membershipId)).toBe(1);
    await resolveRow(w.admin, byRow.get(4)!.id, { membershipId: byRow.get(4)!.membershipId, period: "2026-01", amountCents: 23_500, transferDate: "2026-01-03", decision: "SKIP", skipReason: "Same transfer submitted twice" });
    await resolveRow(w.admin, byRow.get(5)!.id, { membershipId: omar.membershipId, period: "2026-01", amountCents: 23_500, transferDate: "2026-01-04", decision: "IMPORT" });
    await resolveRow(w.admin, byRow.get(6)!.id, { membershipId: w.residents[3]!.membershipId, period: "2026-01", amountCents: 23_500, transferDate: "2026-01-05", decision: "IMPORT" });
    await resolveRow(w.admin, byRow.get(3)!.id, { membershipId: w.residents[1]!.membershipId, period: "2026-01", amountCents: 23_500, transferDate: "2026-01-03", decision: "IMPORT" });

    const result = await commitBatch(w.admin, batch.id);
    expect(result.imported).toBe(4);
    expect(result.skipped).toBe(1);
    expect(result.summary.unresolved).toBe(2); // missing amount + unknown person stay visible
    expect(result.closed).toBe(false);

    // Imported payments are NOT verified and do not reduce balances yet.
    const ravi = w.residents[0]!;
    expect((await getMemberSummary(w.admin, ravi.membershipId)).months[0]!.outstanding).toBe(23_500);
    const imported = await prisma.payment.findMany({ where: { source: "IMPORT" } });
    expect(imported.every((p) => p.status === "SUBMITTED" && p.importRowId)).toBe(true);
    expect(imported.find((p) => p.membershipId === w.residents[1]!.membershipId)!.adminNote!.replace(/ /g, " ")).toMatch(/Original split: 200,00 € \+ 35,00 €/);

    // Explicit bulk verification after review.
    const bulk = await verifyImportedWithFullMatch(w.admin, batch.id);
    expect(bulk.verified).toBe(4);
    expect((await getMemberSummary(w.admin, ravi.membershipId)).months[0]!.outstanding).toBe(0);

    // The raw rows remain available for audit.
    const raw = await prisma.importRow.findFirstOrThrow({ where: { batchId: batch.id, rowNumber: 3 } });
    expect(JSON.stringify(raw.raw)).toContain("=200+35");
  });

  it("refuses a second import unless explicitly forced, and flags duplicates against existing payments", async () => {
    const file = await legacyWorkbook();
    const b1 = await stageImport(w.admin, file);
    await commitBatch(w.admin, b1.id);
    await expect(stageImport(w.admin, await legacyWorkbook())).rejects.toThrow(/already/);
    const b2 = await stageImport(w.admin, await legacyWorkbook(), true);
    const { batch } = await getBatch(w.admin, b2.id);
    expect(batch.rows.find((r) => r.rowNumber === 2)!.issues).toContain("POSSIBLE_DUPLICATE");
    expect(batch.rows.find((r) => r.rowNumber === 2)!.status).toBe("NEEDS_REVIEW");
  });
});
