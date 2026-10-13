import type { Column, ReportTable } from "@/server/reports/service";
import { StatusBadge, Table, Td, Th, cx } from "./ui";
import { eur, formatDate, formatPeriod } from "@/lib/format";
import { parseIsoDate } from "@/server/finance/period";

const NUMERIC = new Set(["money", "number", "percent"]);

function Cell({ column, value }: { column: Column; value: string | number | null | undefined }) {
  if (value === null || value === undefined || value === "") return <span className="text-muted">—</span>;
  switch (column.type) {
    case "money":
      return <span className={cx(typeof value === "number" && value < 0 && "text-bad")}>{typeof value === "number" ? eur(value) : value}</span>;
    case "percent":
      return <>{value}%</>;
    case "date": {
      const d = typeof value === "string" ? parseIsoDate(value) : null;
      return <>{d ? formatDate(d) : value}</>;
    }
    case "status":
      return <StatusBadge status={String(value)} />;
    case "id":
      // Full id is kept in exports; on screen a short, copyable fragment is enough.
      return <span className="font-mono text-xs text-muted" title={String(value)}>…{String(value).slice(-8)}</span>;
    case "lines":
      return (
        <div className="space-y-0.5">
          {String(value).split("\n").map((line, i) => <div key={i} className="whitespace-nowrap">{line}</div>)}
        </div>
      );
    default:
      if (column.key === "month" && typeof value === "string" && /^\d{4}-\d{2}$/.test(value)) return <>{formatPeriod(value, "short")}</>;
      return <>{value}</>;
  }
}

/** Render a ReportTable (the same structure used for CSV/XLSX export). Export-only columns are hidden. */
export function ReportTableView({ table, maxRows = 500 }: { table: ReportTable; maxRows?: number }) {
  if (table.rows.length === 0) return <p className="px-5 py-6 text-sm text-muted">No rows for the selected filters.</p>;
  const columns = table.columns.filter((c) => c.screen !== false);
  return (
    <>
      <Table>
        <thead>
          <tr>{columns.map((c) => <Th key={c.key} align={NUMERIC.has(c.type ?? "") ? "right" : "left"}>{c.label}</Th>)}</tr>
        </thead>
        <tbody>
          {table.rows.slice(0, maxRows).map((r, i) => (
            <tr key={i} className="hover:bg-canvas/60">
              {columns.map((c) => (
                <Td key={c.key} align={NUMERIC.has(c.type ?? "") ? "right" : "left"} wrap={c.wrap} label={c.label}>
                  <Cell column={c} value={r[c.key]} />
                </Td>
              ))}
            </tr>
          ))}
        </tbody>
      </Table>
      {table.rows.length > maxRows && <p className="px-5 py-3 text-xs text-muted">Showing the first {maxRows} of {table.rows.length} rows. Export to see all.</p>}
    </>
  );
}
