import { requirePageCtx } from "@/server/auth/context";
import { buildStatement } from "@/server/reports/service";
import { isPeriod } from "@/server/finance/period";
import { orNotFound } from "@/lib/page";
import { ReportTableView } from "@/components/report-table";
import { Card, CardHeader, DL, PageHeader, buttonClass } from "@/components/ui";
import { eur, formatPeriod } from "@/lib/format";
import { PrintButton } from "@/components/print-button";

export const metadata = { title: "Statement" };

export default async function StatementPage({ searchParams }: { searchParams: Promise<{ m?: string; from?: string; to?: string }> }) {
  const ctx = await requirePageCtx();
  const sp = await searchParams;
  const membershipId = ctx.isAdmin && sp.m ? sp.m : ctx.membershipId;
  const st = await orNotFound(buildStatement(ctx, membershipId, { from: isPeriod(sp.from) ? sp.from : undefined, to: isPeriod(sp.to) ? sp.to : undefined }));
  const q = new URLSearchParams({ from: st.from, to: st.to, ...(membershipId !== ctx.membershipId ? { m: membershipId } : {}) });

  return (
    <>
      <PageHeader
        title="Statement"
        description={`${st.membership.displayName} · ${formatPeriod(st.from)} – ${formatPeriod(st.to)}`}
        actions={
          <div className="no-print flex flex-wrap gap-2">
            <a className={buttonClass("secondary")} href={`/api/statement/${membershipId}?${q}&format=xlsx`}>Excel</a>
            <a className={buttonClass("secondary")} href={`/api/statement/${membershipId}?${q}&format=csv`}>CSV</a>
            <PrintButton />
          </div>
        }
      />
      <form className="no-print mb-6 flex flex-wrap items-end gap-3" action="/account/statement">
        {membershipId !== ctx.membershipId && <input type="hidden" name="m" value={membershipId} />}
        <label className="text-sm">From<input type="month" name="from" defaultValue={st.from} className="ml-2 rounded-lg border border-line bg-surface px-2 py-1.5" /></label>
        <label className="text-sm">To<input type="month" name="to" defaultValue={st.to} className="ml-2 rounded-lg border border-line bg-surface px-2 py-1.5" /></label>
        <button className={buttonClass("secondary")}>Update</button>
      </form>

      <Card className="mb-6 p-5">
        <DL
          items={[
            ["Total outstanding (to date)", eur(Math.max(0, st.summary.totalOutstanding))],
            ["Verified payments (all time)", eur(st.summary.totalVerifiedPayments)],
            ["Unallocated credit", eur(st.summary.unallocatedCredit)],
            ["Deposit held", eur(st.summary.depositHeld)],
            ["Pending verification", eur(st.summary.pendingSubmissionCents)],
            ["Generated", new Date().toISOString().slice(0, 10)],
          ]}
        />
      </Card>
      {st.tables.map((t) => (
        <Card key={t.title} className="mb-6 break-inside-avoid">
          <CardHeader title={t.title} />
          <ReportTableView table={t} maxRows={2000} />
        </Card>
      ))}
    </>
  );
}
