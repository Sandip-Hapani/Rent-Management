import { requirePageAdmin } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { buildReport, REPORT_TITLES, REPORT_TYPES, type ReportType } from "@/server/reports/service";
import { addMonths, currentPeriod, isPeriod } from "@/server/finance/period";
import { ReportTableView } from "@/components/report-table";
import { Card, CardHeader, PageHeader, buttonClass, cx } from "@/components/ui";
import Link from "next/link";

export const metadata = { title: "Reports" };

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ type?: string; from?: string; to?: string; member?: string }> }) {
  const ctx = await requirePageAdmin();
  const sp = await searchParams;
  const type: ReportType = (REPORT_TYPES as readonly string[]).includes(sp.type ?? "") ? (sp.type as ReportType) : "collection";
  const to = isPeriod(sp.to) ? sp.to : currentPeriod(ctx.timezone);
  const from = isPeriod(sp.from) ? sp.from : addMonths(to, -11);
  const filters = { from, to, membershipId: sp.member || undefined };
  const [table, members] = await Promise.all([
    buildReport(ctx, type, filters),
    prisma.membership.findMany({ where: { apartmentId: ctx.apartmentId }, orderBy: { moveInDate: "asc" }, select: { id: true, displayName: true } }),
  ]);
  const q = new URLSearchParams({ from, to, ...(filters.membershipId ? { member: filters.membershipId } : {}) });

  return (
    <>
      <PageHeader title="Reports" description="All figures come from the same ledger as the dashboards. Deposits are reported separately from income." />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Reports" className="flex flex-wrap gap-1.5">
          {REPORT_TYPES.map((t) => (
            <Link key={t} href={`/reports?type=${t}&${q}`} aria-current={t === type ? "page" : undefined} className={cx("rounded-full border px-3 py-1.5 text-sm whitespace-nowrap", t === type ? "border-accent bg-accent-soft font-medium text-accent-strong" : "border-line bg-surface text-muted hover:text-ink")}>
              {REPORT_TITLES[t]}
            </Link>
          ))}
        </nav>
        <form action="/account/statement" className="flex items-center gap-1.5">
          <label htmlFor="stm" className="text-sm text-muted">Statement for</label>
          <select id="stm" name="m" className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm">
            {members.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
          </select>
          <button className={buttonClass("secondary", "py-1.5")}>Open</button>
        </form>
      </div>
      <div>
        <Card className="min-w-0">
          <CardHeader
            title={table.title}
            action={
              <div className="flex gap-2">
                <a className={buttonClass("secondary")} href={`/api/reports/${type}?${q}&format=csv`}>CSV</a>
                <a className={buttonClass("secondary")} href={`/api/reports/${type}?${q}&format=xlsx`}>Excel</a>
              </div>
            }
          />
          <form className="flex flex-wrap items-end gap-3 border-b border-line px-5 py-3" action="/reports">
            <input type="hidden" name="type" value={type} />
            <label className="text-sm">From <input type="month" name="from" defaultValue={from} className="ml-1 rounded-lg border border-line bg-surface px-2 py-1.5" /></label>
            <label className="text-sm">To <input type="month" name="to" defaultValue={to} className="ml-1 rounded-lg border border-line bg-surface px-2 py-1.5" /></label>
            <label className="text-sm">Resident
              <select name="member" defaultValue={filters.membershipId ?? ""} className="ml-1 rounded-lg border border-line bg-surface px-2 py-1.5">
                <option value="">All</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
              </select>
            </label>
            <button className={buttonClass("secondary")}>Apply</button>
          </form>
          <ReportTableView table={table} />
        </Card>
      </div>
    </>
  );
}
