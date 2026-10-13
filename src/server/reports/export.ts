import ExcelJS from "exceljs";
import { centsToDecimalString } from "../finance/money";
import type { ReportTable } from "./service";

/** Neutralise spreadsheet formula injection (cells starting with = + - @ tab CR). */
function safeText(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

function cellText(value: string | number | null, type?: string): string {
  if (value === null || value === undefined) return "";
  if (type === "money" && typeof value === "number") return centsToDecimalString(value);
  return safeText(String(value));
}

function csvEscape(s: string): string {
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(tables: ReportTable[]): string {
  const parts = tables.map((t) => {
    const header = t.columns.map((c) => csvEscape(c.label)).join(",");
    const body = t.rows.map((r) => t.columns.map((c) => csvEscape(cellText(r[c.key] ?? null, c.type))).join(",")).join("\r\n");
    return (tables.length > 1 ? `${csvEscape(t.title)}\r\n` : "") + header + "\r\n" + body;
  });
  return "﻿" + parts.join("\r\n\r\n") + "\r\n"; // BOM so Excel opens UTF-8 correctly
}

export async function toXlsx(tables: ReportTable[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  for (const t of tables) {
    const ws = wb.addWorksheet(t.title.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Sheet");
    ws.columns = t.columns.map((c) => ({ header: c.label, key: c.key, width: Math.max(12, Math.min(48, c.label.length + 4)) }));
    ws.getRow(1).font = { bold: true };
    for (const r of t.rows) {
      const row: Record<string, string | number | null> = {};
      for (const c of t.columns) {
        const v = r[c.key] ?? null;
        if (c.type === "money" && typeof v === "number") row[c.key] = v / 100;
        else if (typeof v === "string") row[c.key] = safeText(v);
        else row[c.key] = v;
      }
      ws.addRow(row);
    }
    t.columns.forEach((c, i) => {
      if (c.type === "money") ws.getColumn(i + 1).numFmt = '#,##0.00 "€"';
    });
    ws.views = [{ state: "frozen", ySplit: 1 }];
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
