/**
 * Historical import workflow: upload → staged rows with issues → admin review → commit.
 * Imported transfers become SUBMITTED payments (never auto-verified); raw rows are kept forever.
 */
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db";
import { audit } from "../audit";
import { assertAdmin, type Ctx } from "../auth/ctx";
import { badRequest, conflict, notFound } from "../errors";
import { suggestAllocations } from "../finance/allocation";
import { formatCents } from "../finance/money";
import { isPeriod } from "../finance/period";
import { openChargesFor, verifyPayment } from "../payments/service";
import { storeUpload } from "../storage/upload";
import { BLOCKING, normalizeName, normalizeRows, readWorkbook, rowStatus, type NameDirectory } from "./parse";

async function nameDirectory(apartmentId: string): Promise<NameDirectory> {
  const [members, aliases] = await Promise.all([
    prisma.membership.findMany({ where: { apartmentId }, include: { user: { select: { name: true } } } }),
    prisma.residentAlias.findMany({ where: { apartmentId } }),
  ]);
  const exact = new Map<string, string>();
  for (const m of members) {
    exact.set(normalizeName(m.displayName), m.id);
    exact.set(normalizeName(m.user.name), m.id);
    const first = normalizeName(m.user.name).split(" ")[0];
    if (first && !exact.has(first)) exact.set(first, m.id);
  }
  for (const a of aliases) exact.set(a.alias, a.membershipId);
  return { exact };
}

/** Parse and stage an uploaded workbook. Re-importing the same file needs `force`. */
export async function stageImport(ctx: Ctx, file: File, force = false) {
  assertAdmin(ctx);
  const data = Buffer.from(await file.arrayBuffer());
  const sha = createHash("sha256").update(data).digest("hex");
  const apartment = await prisma.apartment.findUniqueOrThrow({ where: { id: ctx.apartmentId } });
  const sameFile = await prisma.importBatch.findFirst({ where: { apartmentId: ctx.apartmentId, fileSha256: sha, status: { not: "CANCELLED" } } });
  if (sameFile && !force) throw conflict("This exact file was already imported. Confirm to import it again.");
  if (apartment.historicalImportDone && !force) throw conflict("Historical data has already been imported. Confirm to run another import.");

  let parsed;
  try {
    parsed = await readWorkbook(data);
  } catch (e) {
    throw badRequest(e instanceof Error ? e.message : "The workbook couldn't be read.");
  }
  if (parsed.rows.length === 0) throw badRequest("No data rows found in the first sheet.");
  const stored = await storeUpload({ apartmentId: ctx.apartmentId, uploadedById: ctx.userId, purpose: "IMPORT", file });

  const dir = await nameDirectory(ctx.apartmentId);
  const existing = await prisma.payment.findMany({ where: { apartmentId: ctx.apartmentId, status: { notIn: ["REJECTED", "DRAFT"] } }, select: { membershipId: true, amountCents: true, transferDate: true } });
  const rows = normalizeRows(parsed.rows, dir, existing);

  const batch = await prisma.$transaction(async (tx) => {
    const b = await tx.importBatch.create({ data: { apartmentId: ctx.apartmentId, fileName: file.name.slice(0, 200), fileSha256: sha, fileId: stored.id, forced: force, createdById: ctx.userId } });
    await tx.importRow.createMany({
      data: rows.map((r) => ({
        batchId: b.id, rowNumber: r.rowNumber, raw: r.raw as Prisma.InputJsonValue, submittedAt: r.submittedAt, monthName: r.monthName, period: r.period,
        transferDate: r.transferDate, bank: r.bank, amountCents: r.amountCents, amountFormula: r.amountFormula, amountParts: r.amountParts, description: r.description,
        nameRaw: r.nameRaw, note: r.note, includesDeposit: r.includesDeposit, includesElectricity: r.includesElectricity,
        membershipId: r.membershipId ?? r.suggestedMembershipId, issues: r.issues, duplicateOfRow: r.duplicateOfRow,
        status: rowStatus(r.issues, r.membershipId),
        decision: rowStatus(r.issues, r.membershipId) === "READY" ? "IMPORT" : "PENDING",
      })),
    });
    await audit(tx, { apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: "import.staged", entityType: "ImportBatch", entityId: b.id, summary: `Historical file "${file.name}" staged (${rows.length} rows)`, after: { rows: rows.length, forced: force } });
    return b;
  });
  return batch;
}

export async function getBatch(ctx: Ctx, batchId: string) {
  assertAdmin(ctx);
  const batch = await prisma.importBatch.findFirst({ where: { id: batchId, apartmentId: ctx.apartmentId }, include: { rows: { orderBy: { rowNumber: "asc" }, include: { payment: { select: { id: true, status: true } } } } } });
  if (!batch) throw notFound();
  return { batch, summary: summarize(batch.rows) };
}

export function summarize(rows: { status: string; decision: string; issues: string[]; membershipId: string | null }[]) {
  const unresolved = rows.filter((r) => r.status !== "IMPORTED" && r.status !== "SKIPPED" && (r.decision === "PENDING" || hasBlocking(r)));
  return {
    total: rows.length,
    imported: rows.filter((r) => r.status === "IMPORTED").length,
    skipped: rows.filter((r) => r.status === "SKIPPED").length,
    duplicates: rows.filter((r) => r.issues.includes("POSSIBLE_DUPLICATE")).length,
    readyToImport: rows.filter((r) => r.status !== "IMPORTED" && r.status !== "SKIPPED" && r.decision === "IMPORT" && !hasBlocking(r)).length,
    toSkip: rows.filter((r) => r.status !== "SKIPPED" && r.decision === "SKIP").length,
    unresolved: unresolved.length,
  };
}

function hasBlocking(r: { issues: string[]; membershipId: string | null }) {
  return !r.membershipId || r.issues.some((i) => BLOCKING.includes(i as never) && i !== "UNKNOWN_RESIDENT" && i !== "AMBIGUOUS_RESIDENT");
}

export const rowDecisionSchema = z.object({
  membershipId: z.string().nullable(),
  period: z.string().refine(isPeriod, "Use YYYY-MM"),
  amountCents: z.number().int().positive(),
  transferDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  decision: z.enum(["PENDING", "IMPORT", "SKIP"]),
  skipReason: z.string().max(300).optional(),
});

/** Admin resolves one row: confirm resident, correct period/amount/date, decide import or skip. */
export async function resolveRow(ctx: Ctx, rowId: string, raw: z.input<typeof rowDecisionSchema>) {
  assertAdmin(ctx);
  const input = rowDecisionSchema.parse(raw);
  const row = await prisma.importRow.findFirst({ where: { id: rowId, batch: { apartmentId: ctx.apartmentId } }, include: { batch: true } });
  if (!row) throw notFound();
  if (row.batch.status !== "STAGED" || row.status === "IMPORTED") throw conflict("This row has already been imported.");
  if (input.decision === "SKIP" && !input.skipReason?.trim()) throw badRequest("Give a reason for skipping the row.");
  if (input.membershipId) {
    const m = await prisma.membership.findFirst({ where: { id: input.membershipId, apartmentId: ctx.apartmentId } });
    if (!m) throw badRequest("Unknown resident.");
  }
  if (input.decision === "IMPORT" && !input.membershipId) throw badRequest("Choose the resident before importing.");
  // Once an admin confirms the resident, the name issues are resolved; other issues stay visible.
  const issues = row.issues.filter((i) => !(input.membershipId && (i === "UNKNOWN_RESIDENT" || i === "AMBIGUOUS_RESIDENT")) && !(i === "MISSING_AMOUNT" || i === "INVALID_AMOUNT" || i === "MISSING_DATE" || i === "MISSING_MONTH"));
  await prisma.$transaction(async (tx) => {
    await tx.importRow.update({
      where: { id: row.id },
      data: {
        membershipId: input.membershipId, period: input.period, amountCents: input.amountCents, transferDate: new Date(`${input.transferDate}T00:00:00Z`),
        decision: input.decision, skipReason: input.decision === "SKIP" ? input.skipReason : null, issues, status: input.decision === "PENDING" ? "NEEDS_REVIEW" : "READY",
      },
    });
    await audit(tx, {
      apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: "import.row_resolved", entityType: "ImportRow", entityId: row.id, summary: `Import row ${row.rowNumber} reviewed (${input.decision.toLowerCase()})`,
      before: { membershipId: row.membershipId, period: row.period, amountCents: row.amountCents, transferDate: row.transferDate }, after: input, reason: input.skipReason,
    });
  });
}

/** Save a name alias (e.g. "Jhon" → John) and apply it to every unresolved row with that name. */
export async function mapAlias(ctx: Ctx, batchId: string, nameRaw: string, membershipId: string) {
  assertAdmin(ctx);
  const m = await prisma.membership.findFirst({ where: { id: membershipId, apartmentId: ctx.apartmentId } });
  if (!m) throw badRequest("Unknown resident.");
  const alias = normalizeName(nameRaw);
  await prisma.residentAlias.upsert({ where: { apartmentId_alias: { apartmentId: ctx.apartmentId, alias } }, create: { apartmentId: ctx.apartmentId, membershipId, alias }, update: { membershipId } });
  const rows = await prisma.importRow.findMany({ where: { batchId, batch: { apartmentId: ctx.apartmentId }, nameRaw, status: { in: ["READY", "NEEDS_REVIEW"] } } });
  for (const r of rows) {
    const issues = r.issues.filter((i) => i !== "UNKNOWN_RESIDENT" && i !== "AMBIGUOUS_RESIDENT");
    const status = rowStatus(issues, membershipId);
    await prisma.importRow.update({ where: { id: r.id }, data: { membershipId, issues, status, decision: r.decision === "PENDING" && status === "READY" ? "IMPORT" : r.decision } });
  }
  await audit(prisma, { apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: "import.alias_mapped", entityType: "ImportBatch", entityId: batchId, summary: `Name "${nameRaw}" mapped to ${m.displayName}` });
  return rows.length;
}

/**
 * Create payments for rows marked IMPORT. Rows with blocking issues or pending decisions stay
 * unresolved; nothing is silently dropped.
 */
export async function commitBatch(ctx: Ctx, batchId: string) {
  assertAdmin(ctx);
  const batch = await prisma.importBatch.findFirst({ where: { id: batchId, apartmentId: ctx.apartmentId }, include: { rows: true } });
  if (!batch) throw notFound();
  if (batch.status !== "STAGED") throw conflict("This import is already closed.");
  let imported = 0;
  let skipped = 0;
  for (const row of batch.rows) {
    if (row.status === "IMPORTED" || row.status === "SKIPPED") continue;
    if (row.decision === "SKIP") {
      await prisma.importRow.update({ where: { id: row.id }, data: { status: "SKIPPED" } });
      skipped++;
      continue;
    }
    if (row.decision !== "IMPORT" || hasBlocking(row) || !row.membershipId || !row.amountCents || !row.transferDate || !row.period) continue;
    await prisma.$transaction(async (tx) => {
      const notes = [`Imported from "${batch.fileName}" row ${row.rowNumber}.`, row.amountParts.length > 1 ? `Original split: ${row.amountParts.map((p) => formatCents(p)).join(" + ")}.` : null, row.note ? `Sheet note: ${row.note}` : null, row.issues.length ? `Flags: ${row.issues.join(", ")}.` : null].filter(Boolean).join(" ");
      const payment = await tx.payment.create({
        data: {
          apartmentId: ctx.apartmentId, membershipId: row.membershipId!, amountCents: row.amountCents!, transferDate: row.transferDate!, bank: row.bank, description: row.description,
          intendedPeriods: [row.period!], includesDeposit: row.includesDeposit, includesElectricity: row.includesElectricity, status: "SUBMITTED", source: "IMPORT",
          submittedAt: row.submittedAt ?? new Date(), adminNote: notes, importRowId: row.id, createdById: ctx.userId,
        },
      });
      const open = await openChargesFor(tx, row.membershipId!, payment.id);
      const proposal = suggestAllocations(row.amountCents!, open, { periods: [row.period!], includeDeposit: row.includesDeposit });
      if (proposal.allocations.length) {
        await tx.allocation.createMany({ data: proposal.allocations.map((a) => ({ paymentId: payment.id, chargeId: a.chargeId, amountCents: a.amountCents, state: "PROPOSED" as const, createdById: ctx.userId })) });
      }
      await tx.importRow.update({ where: { id: row.id }, data: { status: "IMPORTED" } });
    });
    imported++;
  }
  const after = await prisma.importRow.findMany({ where: { batchId } });
  const summary = summarize(after);
  const closed = summary.unresolved === 0;
  await prisma.$transaction(async (tx) => {
    await tx.importBatch.update({ where: { id: batchId }, data: { summary, ...(closed ? { status: "COMMITTED", committedAt: new Date() } : {}) } });
    await tx.apartment.update({ where: { id: ctx.apartmentId }, data: { historicalImportDone: true } });
    await audit(tx, {
      apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: "import.committed", entityType: "ImportBatch", entityId: batchId,
      summary: `Historical import: ${imported} imported, ${skipped} skipped, ${summary.unresolved} unresolved`, after: summary,
    });
  });
  return { imported, skipped, summary, closed };
}

export async function cancelBatch(ctx: Ctx, batchId: string) {
  assertAdmin(ctx);
  const batch = await prisma.importBatch.findFirst({ where: { id: batchId, apartmentId: ctx.apartmentId }, include: { rows: { where: { status: "IMPORTED" }, select: { id: true } } } });
  if (!batch) throw notFound();
  if (batch.rows.length) throw conflict("Some rows were already imported; review those payments instead.");
  await prisma.importBatch.update({ where: { id: batchId }, data: { status: "CANCELLED" } });
  await audit(prisma, { apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: "import.cancelled", entityType: "ImportBatch", entityId: batchId, summary: "Staged import cancelled" });
}

/**
 * Explicit admin action after reconciliation: verify imported payments whose proposed allocations
 * fully match existing charges. Payments without a full match are left for manual review.
 */
export async function verifyImportedWithFullMatch(ctx: Ctx, batchId: string) {
  assertAdmin(ctx);
  const payments = await prisma.payment.findMany({
    where: { apartmentId: ctx.apartmentId, source: "IMPORT", status: "SUBMITTED", importRow: { batchId } },
    include: { allocations: { where: { state: "PROPOSED" } } },
    orderBy: { transferDate: "asc" },
  });
  let verified = 0;
  const left: string[] = [];
  for (const p of payments) {
    const allocated = p.allocations.reduce((a, x) => a + x.amountCents, 0);
    if (allocated !== p.amountCents) {
      left.push(p.id);
      continue;
    }
    try {
      await verifyPayment(ctx, p.id, p.allocations.map((a) => ({ chargeId: a.chargeId, amountCents: a.amountCents })), "Verified in bulk after historical reconciliation");
      verified++;
    } catch {
      left.push(p.id);
    }
  }
  return { verified, leftForReview: left.length };
}
