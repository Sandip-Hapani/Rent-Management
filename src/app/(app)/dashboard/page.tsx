import Link from "next/link";
import { requirePageCtx } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { getApartmentOverview, getCollectionSeries, getMemberSummary } from "@/server/finance/queries";
import { recentActivity } from "@/server/notifications/queries";
import { CollectionChart } from "@/components/collection-chart";
import { Alert, ButtonLink, Card, CardHeader, EmptyState, PageHeader, Stat, StatusBadge, cx } from "@/components/ui";
import { categoryLabel, eur, formatDate, formatPeriod, relativeTime } from "@/lib/format";

export const metadata = { title: "Dashboard" };

const RANGES = [6, 12, 24] as const;

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ range?: string; member?: string; welcome?: string }> }) {
  const ctx = await requirePageCtx();
  const sp = await searchParams;
  const range = RANGES.find((r) => String(r) === sp.range) ?? 12;
  const chartMember = ctx.isAdmin ? (sp.member || undefined) : ctx.membershipId;

  const [overview, me, chart, activity, priceChanges, members] = await Promise.all([
    getApartmentOverview(ctx),
    getMemberSummary(ctx, ctx.membershipId),
    getCollectionSeries(ctx, range, chartMember),
    recentActivity(ctx, 10),
    prisma.priceChange.findMany({ where: { apartmentId: ctx.apartmentId }, orderBy: { publishedAt: "desc" }, take: 3 }),
    ctx.isAdmin ? prisma.membership.findMany({ where: { apartmentId: ctx.apartmentId }, orderBy: { moveInDate: "asc" }, select: { id: true, displayName: true } }) : Promise.resolve([]),
  ]);
  const collectedPct = overview.expected > 0 ? Math.round((overview.confirmed / overview.expected) * 100) : null;
  const qs = (o: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ range: String(range), member: sp.member, ...o })) if (v) p.set(k, v);
    return `?${p.toString()}`;
  };

  return (
    <>
      <PageHeader
        title={`Hi ${ctx.displayName}`}
        description={`${formatPeriod(overview.period)} · next rent due ${overview.nextDueDate ? formatDate(overview.nextDueDate) : "—"}`}
        actions={ctx.membershipActive && <ButtonLink href="/payments/new">Record a payment</ButtonLink>}
      />
      {sp.welcome && <div className="mb-4"><Alert tone="good" title="Your account is active.">This is your dashboard. Your balance and payment history are under My Account.</Alert></div>}
      {me.reconciliationStatus === "UNRECONCILED" && me.months.length > 0 && (
        <div className="mb-4"><Alert tone="warn" title="Balance not yet reconciled">Historical payments are still being checked by the administrator. Figures may change once older months are confirmed.</Alert></div>
      )}

      {/* Personal figures first */}
      <section aria-labelledby="mine" className="mb-6">
        <h2 id="mine" className="mb-3 text-sm font-medium text-muted">Your account</h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Due this month" value={eur(me.current.due)} hint={me.current.dueDate ? `Due ${formatDate(me.current.dueDate)}` : "No obligation yet"} href={`/account/month/${me.asOf}`} />
          <Stat label="Paid this month" value={eur(me.current.confirmed)} hint={me.current.pending ? `${eur(me.current.pending)} waiting for verification` : "Verified payments"} tone={me.current.confirmed > 0 ? "good" : "neutral"} />
          <Stat label="Still to pay (month)" value={eur(Math.max(0, me.current.outstanding))} hint={<StatusBadge status={me.current.status} />} tone={me.current.outstanding > 0 ? (me.current.status === "OVERDUE" ? "bad" : "warn") : "good"} />
          <Stat label="Total outstanding" value={eur(Math.max(0, me.totalOutstanding))} hint={me.overdueMonths.length ? `${me.overdueMonths.length} earlier month(s) open` : me.unallocatedCredit > 0 ? `${eur(me.unallocatedCredit)} credit` : "All earlier months settled"} tone={me.totalOutstanding > 0 ? "bad" : "good"} href="/account" />
        </div>
      </section>

      {/* Apartment-wide */}
      <section aria-labelledby="apt" className="mb-6">
        <h2 id="apt" className="mb-3 text-sm font-medium text-muted">Apartment · {formatPeriod(overview.period)}</h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Expected" value={eur(overview.expected)} hint="Rent, electricity & shared costs" />
          <Stat label="Confirmed" value={eur(overview.confirmed)} hint={collectedPct !== null ? `${collectedPct}% collected` : "—"} tone="good" />
          {ctx.isAdmin ? (
            <>
              <Stat label="Outstanding" value={eur(overview.outstanding)} hint={`${eur(overview.totalOutstandingToDate)} across all months`} tone={overview.outstanding > 0 ? "warn" : "good"} href="/reports?type=balances-resident" />
              <Stat label="Residents" value={`${overview.fullyPaid}/${overview.memberCount} paid`} hint={`${overview.withPending} pending · ${overview.overdue} overdue`} tone={overview.overdue ? "bad" : "neutral"} href="/payments?status=OPEN" />
            </>
          ) : (
            <>
              <Stat label="Residents fully paid" value={`${overview.fullyPaid} of ${overview.memberCount}`} />
              <Stat label="Pending verification" value={eur(overview.pending)} hint="Submitted, not yet confirmed" />
            </>
          )}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title={ctx.isAdmin ? "Expected vs confirmed collection" : "Your charges vs confirmed payments"}
            description={chartMember && ctx.isAdmin ? `Showing ${members.find((m) => m.id === chartMember)?.displayName ?? "resident"}` : ctx.isAdmin ? "All residents" : "Per month"}
            action={
              <div className="flex flex-wrap items-center gap-2">
                {ctx.isAdmin && (
                  <form className="flex items-center gap-1" action="/dashboard">
                    <input type="hidden" name="range" value={range} />
                    <label className="sr-only" htmlFor="member">Resident</label>
                    <select id="member" name="member" defaultValue={sp.member ?? ""} className="rounded-lg border border-line bg-surface px-2 py-1.5 text-xs">
                      <option value="">All residents</option>
                      {members.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
                    </select>
                    <button className="rounded-lg border border-line px-2 py-1.5 text-xs hover:bg-canvas">Apply</button>
                  </form>
                )}
                <div className="flex rounded-lg border border-line p-0.5" role="group" aria-label="Range">
                  {RANGES.map((r) => (
                    <Link key={r} href={qs({ range: String(r) })} aria-current={r === range ? "true" : undefined} className={cx("rounded-md px-2 py-1 text-xs", r === range ? "bg-accent text-white" : "text-muted hover:bg-canvas")}>
                      {r}m
                    </Link>
                  ))}
                </div>
              </div>
            }
          />
          <CollectionChart series={chart.series} rejectedCount={chart.rejectedCount} showMembers={ctx.isAdmin && !chartMember} />
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Price changes" action={<Link href="/notifications?tab=prices" className="text-xs text-accent hover:underline">History</Link>} />
            {priceChanges.length === 0 ? (
              <p className="px-5 py-6 text-sm text-muted">No price changes published yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {priceChanges.map((pc) => (
                  <li key={pc.id} className="px-5 py-3 text-sm">
                    <p className="font-medium">{categoryLabel(pc.category)} from {formatPeriod(pc.effectiveFrom)}</p>
                    <p className="mt-0.5 line-clamp-2 text-muted">{pc.reason}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader title="Recent activity" />
            {activity.length === 0 ? (
              <EmptyState title="Nothing yet" />
            ) : (
              <ol className="divide-y divide-line">
                {activity.map((a) => (
                  <li key={a.id} className="px-5 py-2.5 text-sm">
                    <p>{a.summary}</p>
                    <time className="text-xs text-muted" dateTime={a.createdAt.toISOString()}>{relativeTime(a.createdAt)}</time>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
