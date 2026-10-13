/**
 * Pure parsing / normalisation of the legacy "Rent Tracker" Google-Form export.
 * Nothing here guesses silently: every inference that could be wrong produces an issue code.
 */
import ExcelJS from "exceljs";
import { numberToCents, parseEuroToCents, sum } from "../finance/money";
import { comparePeriods, makePeriod, MONTH_NAMES, type Period } from "../finance/period";

export type IssueCode =
  // blocking — must be resolved before the row can be imported
  | "UNKNOWN_RESIDENT"
  | "AMBIGUOUS_RESIDENT"
  | "MISSING_AMOUNT"
  | "INVALID_AMOUNT"
  | "MISSING_MONTH"
  | "MISSING_DATE"
  // review — admin must decide import / skip
  | "POSSIBLE_DUPLICATE"
  | "DATE_INCONSISTENT"
  | "MANUAL_NOTE"
  | "MANUALLY_ENTERED"
  // informational
  | "FORMULA_AMOUNT"
  | "PAID_BY_OTHER"
  | "INCLUDES_DEPOSIT";

export const BLOCKING: readonly IssueCode[] = ["UNKNOWN_RESIDENT", "AMBIGUOUS_RESIDENT", "MISSING_AMOUNT", "INVALID_AMOUNT", "MISSING_MONTH", "MISSING_DATE"];
export const REVIEW: readonly IssueCode[] = ["POSSIBLE_DUPLICATE", "DATE_INCONSISTENT", "MANUAL_NOTE", "MANUALLY_ENTERED"];

export const ISSUE_LABELS: Record<IssueCode, string> = {
  UNKNOWN_RESIDENT: "Name doesn't match any resident",
  AMBIGUOUS_RESIDENT: "Name only partly matches a resident",
  MISSING_AMOUNT: "Amount is missing",
  INVALID_AMOUNT: "Amount couldn't be read",
  MISSING_MONTH: "Rent month is missing",
  MISSING_DATE: "Transfer date is missing",
  POSSIBLE_DUPLICATE: "Possible duplicate",
  DATE_INCONSISTENT: "Transfer date and submission date disagree",
  MANUAL_NOTE: "Has a manual correction note",
  MANUALLY_ENTERED: "Entered manually (no form timestamp)",
  FORMULA_AMOUNT: "Amount was a formula (split shown)",
  PAID_BY_OTHER: "Paid by someone else on the resident's behalf",
  INCLUDES_DEPOSIT: "Includes a deposit",
};

export interface RawImportRow {
  rowNumber: number;
  raw: Record<string, string | number | boolean | null>;
  submittedAt: Date | null; // wall-clock (Berlin) stored as UTC parts
  monthName: string | null;
  transferDate: Date | null; // calendar date (UTC midnight)
  bank: string | null;
  amountText: string | null;
  amountNumber: number | null;
  amountFormula: string | null;
  description: string | null;
  nameRaw: string | null;
  note: string | null;
  includesDeposit: boolean;
  includesElectricity: boolean;
}

export interface NormalizedRow extends RawImportRow {
  amountCents: number | null;
  amountParts: number[];
  period: Period | null;
  /** Period inferred from the transfer date alone (for comparison). */
  periodByTransfer: Period | null;
  issues: IssueCode[];
  duplicateOfRow: number | null;
  membershipId: string | null;
  suggestedMembershipId: string | null;
}

const HEADER_PATTERNS: [keyof Omit<RawImportRow, "rowNumber" | "raw" | "amountText" | "amountNumber" | "amountFormula" | "note">, RegExp][] = [
  ["submittedAt", /time\s*stamp/i],
  ["monthName", /which month|rent month|^month$/i],
  ["includesDeposit", /deposit/i],
  ["includesElectricity", /electric/i],
  ["transferDate", /^(transfer\s*)?date$/i],
  ["bank", /bank/i],
  ["description", /descr/i],
  ["nameRaw", /^name$/i],
];

function cellToPlain(v: ExcelJS.CellValue): { value: string | number | boolean | Date | null; formula: string | null } {
  if (v === null || v === undefined) return { value: null, formula: null };
  if (v instanceof Date) return { value: v, formula: null };
  if (typeof v === "object") {
    if ("formula" in v || "sharedFormula" in v) {
      const f = (v as ExcelJS.CellFormulaValue).formula ?? (v as ExcelJS.CellSharedFormulaValue).sharedFormula ?? null;
      const r = (v as ExcelJS.CellFormulaValue).result;
      return { value: r === undefined || r === null || typeof r === "object" ? null : (r as string | number | boolean), formula: f ? String(f) : null };
    }
    if ("richText" in v) return { value: (v as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join(""), formula: null };
    if ("text" in v) return { value: String((v as ExcelJS.CellHyperlinkValue).text), formula: null };
    if ("error" in v) return { value: null, formula: null };
  }
  return { value: v as string | number | boolean, formula: null };
}

const str = (v: unknown) => (v === null || v === undefined ? null : String(v).trim() || null);
const yes = (v: unknown) => /^(yes|ja|true|y)$/i.test(String(v ?? "").trim());

/** Read the first worksheet of a Google-Form export. Columns are located by header text. */
export async function readWorkbook(data: Buffer | ArrayBuffer): Promise<{ rows: RawImportRow[]; headers: string[] }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("The workbook has no sheets.");
  const headerRow = ws.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, col) => (headers[col] = String(cellToPlain(cell.value).value ?? "").trim()));

  const colOf = new Map<string, number>();
  let amountCol: number | null = null;
  let emailCol: number | null = null;
  headers.forEach((h, col) => {
    if (!h) return;
    if (/amount/i.test(h) && amountCol === null) amountCol = col;
    else if (/e-?mail/i.test(h)) emailCol = col;
    else for (const [field, re] of HEADER_PATTERNS) if (re.test(h) && !colOf.has(field)) { colOf.set(field, col); break; }
  });
  for (const required of ["monthName", "nameRaw", "transferDate"]) {
    if (!colOf.has(required) || amountCol === null) throw new Error(`Couldn't find the "${required === "nameRaw" ? "Name" : required === "monthName" ? "month" : "Date"}" or "Amount" column in the first sheet.`);
  }
  const known = new Set([...colOf.values(), amountCol, emailCol].filter((x): x is number => x !== null));

  const rows: RawImportRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const get = (field: string) => {
      const c = colOf.get(field);
      return c ? cellToPlain(row.getCell(c).value).value : null;
    };
    const amountCell = row.getCell(amountCol!);
    const amount = cellToPlain(amountCell.value);
    // Shared formulas only reference their master cell; ExcelJS translates them via cell.formula.
    if (amount.formula && !/^[\d.,+\- ]+$/.test(amount.formula) && amountCell.formula) amount.formula = amountCell.formula;
    const raw: RawImportRow["raw"] = {};
    const notes: string[] = [];
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const plain = cellToPlain(cell.value);
      const v = plain.value instanceof Date ? plain.value.toISOString() : plain.value;
      raw[headers[col] || `column_${col}`] = plain.formula ? `=${plain.formula}` : (v as string | number | boolean | null);
      if (!known.has(col) && v !== null && String(v).trim()) notes.push(String(v).replace(/\s+/g, " ").trim());
    });
    const values = Object.values(raw).filter((v) => v !== null && String(v).trim() !== "");
    if (values.length === 0) return;
    const date = get("transferDate");
    const ts = get("submittedAt");
    rows.push({
      rowNumber,
      raw,
      submittedAt: ts instanceof Date ? ts : null,
      monthName: str(get("monthName")),
      transferDate: date instanceof Date ? new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())) : null,
      bank: str(get("bank")),
      amountText: typeof amount.value === "string" ? amount.value : null,
      amountNumber: typeof amount.value === "number" ? amount.value : null,
      amountFormula: amount.formula,
      description: str(get("description")),
      nameRaw: str(get("nameRaw")),
      note: notes.length ? notes.join(" / ") : null,
      includesDeposit: yes(get("includesDeposit")),
      includesElectricity: yes(get("includesElectricity")),
    });
  });
  return { rows, headers: headers.filter(Boolean) };
}

/** Evaluate a formula made only of numbers joined by + / - (e.g. "169.4+206.8"). Returns cents parts or null. */
export function evaluateSimpleFormula(formula: string): number[] | null {
  const f = formula.replace(/^=/, "").replace(/\s+/g, "");
  if (!/^[+-]?\d+(?:[.,]\d+)?(?:[+-]\d+(?:[.,]\d+)?)*$/.test(f)) return null;
  const terms = f.match(/[+-]?\d+(?:[.,]\d+)?/g) ?? [];
  const parts = terms.map((t) => parseEuroToCents(t.replace(/^\+/, "")));
  return parts.every((p): p is number => p !== null) ? parts : null;
}

export function monthIndex(name: string | null): number | null {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  const i = MONTH_NAMES.findIndex((m) => m.toLowerCase() === n || m.toLowerCase().slice(0, 3) === n.slice(0, 3));
  return i >= 0 ? i + 1 : null;
}

/** The year Y for which (Y, month) is closest to `ref`, preferring the same or the following month. */
export function inferPeriod(month: number, ref: Date): Period {
  const refIdx = ref.getUTCFullYear() * 12 + ref.getUTCMonth();
  let best: { p: Period; score: number } | null = null;
  for (const y of [ref.getUTCFullYear() - 1, ref.getUTCFullYear(), ref.getUTCFullYear() + 1]) {
    const diff = y * 12 + (month - 1) - refIdx;
    // Residents usually pay for the current or next month; late payments up to a few months back.
    const score = diff >= 0 ? diff : -diff + 0.5;
    if (!best || score < best.score) best = { p: makePeriod(y, month), score };
  }
  return best!.p;
}

export const normalizeName = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length]![b.length]!;
}

export interface NameDirectory {
  /** normalised alias / display name / user name → membershipId */
  exact: Map<string, string>;
}

export function matchResident(nameRaw: string | null, dir: NameDirectory): { membershipId: string | null; suggested: string | null; issues: IssueCode[] } {
  if (!nameRaw) return { membershipId: null, suggested: null, issues: ["UNKNOWN_RESIDENT"] };
  const n = normalizeName(nameRaw);
  const exact = dir.exact.get(n);
  if (exact) return { membershipId: exact, suggested: null, issues: [] };
  const base = normalizeName(n.replace(/\(.*?\)/g, ""));
  const issues: IssueCode[] = [];
  if (base !== n) issues.push("PAID_BY_OTHER");
  const byBase = dir.exact.get(base);
  if (byBase) return { membershipId: null, suggested: byBase, issues: ["AMBIGUOUS_RESIDENT", ...issues] };
  let best: { id: string; d: number } | null = null;
  for (const [alias, id] of dir.exact) {
    const d = levenshtein(base, alias);
    if (d <= 2 && (!best || d < best.d)) best = { id, d };
  }
  if (best) return { membershipId: null, suggested: best.id, issues: ["AMBIGUOUS_RESIDENT", ...issues] };
  return { membershipId: null, suggested: null, issues: ["UNKNOWN_RESIDENT", ...issues] };
}

export interface ExistingPaymentKey {
  membershipId: string;
  amountCents: number;
  transferDate: Date;
}

/** Normalise raw rows: amounts, periods, residents, duplicates and consistency checks. */
export function normalizeRows(rows: readonly RawImportRow[], dir: NameDirectory, existing: readonly ExistingPaymentKey[] = []): NormalizedRow[] {
  const out: NormalizedRow[] = rows.map((r) => {
    const issues: IssueCode[] = [];
    // Amount
    let amountCents: number | null = null;
    let amountParts: number[] = [];
    if (r.amountFormula) {
      const parts = evaluateSimpleFormula(r.amountFormula);
      if (parts) {
        amountParts = parts;
        amountCents = sum(parts);
        if (parts.length > 1) issues.push("FORMULA_AMOUNT");
      } else if (r.amountNumber !== null) amountCents = numberToCents(r.amountNumber);
      else issues.push("INVALID_AMOUNT");
    } else if (r.amountNumber !== null) amountCents = numberToCents(r.amountNumber);
    else if (r.amountText) {
      const parts = r.amountText.trim().startsWith("=") ? evaluateSimpleFormula(r.amountText) : null;
      if (parts) {
        amountParts = parts;
        amountCents = sum(parts);
        if (parts.length > 1) issues.push("FORMULA_AMOUNT");
      } else {
        amountCents = parseEuroToCents(r.amountText);
        if (amountCents === null) issues.push("INVALID_AMOUNT");
      }
    } else issues.push("MISSING_AMOUNT");
    if (amountCents !== null && amountCents <= 0) issues.push("INVALID_AMOUNT");

    // Period & dates
    const month = monthIndex(r.monthName);
    let period: Period | null = null;
    let periodByTransfer: Period | null = null;
    if (!month) issues.push("MISSING_MONTH");
    if (!r.transferDate) issues.push("MISSING_DATE");
    if (month && r.transferDate) periodByTransfer = inferPeriod(month, r.transferDate);
    const periodBySubmission = month && r.submittedAt ? inferPeriod(month, r.submittedAt) : null;
    period = periodBySubmission ?? periodByTransfer;
    if (r.transferDate && r.submittedAt) {
      const gapDays = Math.abs(r.submittedAt.getTime() - r.transferDate.getTime()) / 86_400_000;
      if (gapDays > 45 || (periodByTransfer && periodBySubmission && comparePeriods(periodByTransfer, periodBySubmission) !== 0)) issues.push("DATE_INCONSISTENT");
    }
    if (r.submittedAt && r.submittedAt.getUTCHours() === 0 && r.submittedAt.getUTCMinutes() === 0 && r.submittedAt.getUTCSeconds() === 0) issues.push("MANUALLY_ENTERED");
    if (r.note) issues.push("MANUAL_NOTE");
    if (r.includesDeposit) issues.push("INCLUDES_DEPOSIT");

    const match = matchResident(r.nameRaw, dir);
    issues.push(...match.issues);
    return { ...r, amountCents, amountParts, period, periodByTransfer, issues, duplicateOfRow: null, membershipId: match.membershipId, suggestedMembershipId: match.suggested };
  });
  markDuplicates(out, existing);
  return out;
}

/** Same person + same amount + same transfer date (within the file), or ±3 days of an existing payment. */
export function markDuplicates(rows: NormalizedRow[], existing: readonly ExistingPaymentKey[] = []): void {
  const seen = new Map<string, NormalizedRow>();
  for (const r of rows) {
    const who = r.membershipId ?? r.suggestedMembershipId ?? (r.nameRaw ? normalizeName(r.nameRaw) : "?");
    if (r.amountCents === null || !r.transferDate) continue;
    const key = `${who}|${r.amountCents}|${r.transferDate.toISOString().slice(0, 10)}`;
    const first = seen.get(key);
    if (first) {
      if (!r.issues.includes("POSSIBLE_DUPLICATE")) r.issues.push("POSSIBLE_DUPLICATE");
      if (!first.issues.includes("POSSIBLE_DUPLICATE")) first.issues.push("POSSIBLE_DUPLICATE");
      r.duplicateOfRow = first.rowNumber;
    } else seen.set(key, r);
    const memberId = r.membershipId ?? r.suggestedMembershipId;
    if (memberId && existing.some((e) => e.membershipId === memberId && e.amountCents === r.amountCents && Math.abs(e.transferDate.getTime() - r.transferDate!.getTime()) <= 3 * 86_400_000)) {
      if (!r.issues.includes("POSSIBLE_DUPLICATE")) r.issues.push("POSSIBLE_DUPLICATE");
    }
  }
}

export function rowStatus(issues: readonly string[], membershipId: string | null): "READY" | "NEEDS_REVIEW" {
  if (!membershipId) return "NEEDS_REVIEW";
  return issues.some((i) => BLOCKING.includes(i as IssueCode) && i !== "UNKNOWN_RESIDENT" && i !== "AMBIGUOUS_RESIDENT") || issues.some((i) => REVIEW.includes(i as IssueCode)) ? "NEEDS_REVIEW" : "READY";
}
