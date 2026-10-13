import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageCtx } from "@/server/auth/context";
import { getMemberSummary, getMonthDetail } from "@/server/finance/queries";
import { isPeriod } from "@/server/finance/period";
import { orNotFound } from "@/lib/page";
import { Card, CardHeader, EmptyState, PageHeader, StatusBadge, Table, Td, Th, cx } from "@/components/ui";
import { categoryLabel, eur, formatDate, formatPeriod } from "@/lib/format";

export const metadata = { title: "Month detail" };

export default async function MonthPage({ params, searchParams }: { params: Promise<{ period: string }>; searchParams: Promise<{ m?: string }> }) {
  const ctx = await requirePageCtx();
  const { period } = await params;
  if (!isPeriod(period)) notFound();
  const { m } = await searchParams;
  const membershipId = ctx.isAdmin && m ? m : ctx.membershipId;
  const [detail, summary] = await Promise.all([orNotFound(getMonthDetail(ctx, membershipId, period)), orNotFound(getMemberSummary(ctx, membershipId))]);
  const month = summary.months.find((x) => x.period === period);
  const back = membershipId === ctx.membershipId ? "/account" : `/account?m=${membershipId}`;

  return (
    <>
      <PageHeader
        title={formatPeriod(period)}
        description={<><Link href={back} className="text-accent hover:underline">← {membershipId === ctx.membershipId ? "My account" : `${detail.membership.displayName}'s account`}</Link>{detail.dueDate && <> · due {formatDate(detail.dueDate)}</>}</>}
        actions={month && <StatusBadge status={month.status} />}
      />

      <Card className="mb-6">
        <CardHeader title="Charges and balance" description="Amounts as they applied in this month. Later price changes never alter them." />
        {detail.charges.length === 0 && detail.adjustments.length === 0 ? (
          <EmptyState title="No charges for this month" />
        ) : (
          <Table>
            <thead><tr><Th>Item</Th><Th align="right">Amount</Th><Th align="right">Paid (verified)</Th><Th align="right">Pending</Th><Th align="right">Remaining</Th></tr></thead>
            <tbody>
              {detail.charges.map((c) => {
                const paid = c.allocations.filter((a) => a.state === "ACTIVE" && a.payment.status === "VERIFIED").reduce((s, a) => s + a.amountCents, 0);
                const pend = c.allocations.filter((a) => a.state === "PROPOSED").reduce((s, a) => s + a.amountCents, 0);
                return (
                  <tr key={c.id} className={cx(c.status === "VOID" && "text-muted line-through")}>
                    <Td wrap>
                      {categoryLabel(c.category)}
                      {c.description && <span className="block text-xs text-muted">{c.description}</span>}
                      {c.status === "VOID" && <span className="block text-xs no-underline">Voided: {c.voidReason}</span>}
                    </Td>
                    <Td align="right">{eur(c.amountCents)}</Td>
                    <Td align="right">{eur(c.status === "VOID" ? 0 : paid)}</Td>
                    <Td align="right">{pend ? eur(pend) : "—"}</Td>
                    <Td align="right" className="font-medium">{c.status === "VOID" ? "—" : eur(c.amountCents - paid)}</Td>
                  </tr>
                );
              })}
              {detail.adjustments.map((a) => (
                <tr key={a.id}>
                  <Td wrap>
                    Adjustment · {categoryLabel(a.category)} <span className="text-xs text-muted">({a.kind.toLowerCase().replace(/_/g, " ")})</span>
                    <span className="block text-xs text-muted">{a.reason}</span>
                  </Td>
                  <Td align="right">{eur(a.amountCents)}</Td>
                  <Td align="right">—</Td><Td align="right">—</Td>
                  <Td align="right">{eur(a.amountCents)}</Td>
                </tr>
              ))}
              {month && (
                <tr className="font-semibold">
                  <Td>Total</Td>
                  <Td align="right">{eur(month.due)}</Td>
                  <Td align="right">{eur(month.confirmed)}</Td>
                  <Td align="right">{month.pending ? eur(month.pending) : "—"}</Td>
                  <Td align="right" className={cx(month.outstanding > 0 && "text-bad")}>{eur(month.outstanding)}</Td>
                </tr>
              )}
            </tbody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader title="Payments for this month" />
        {(() => {
          const rows = detail.charges.flatMap((c) => c.allocations.map((a) => ({ a, c })));
          if (rows.length === 0) return <p className="px-5 py-6 text-sm text-muted">No payments have been allocated to this month yet.</p>;
          return (
            <Table>
              <thead><tr><Th>Transfer</Th><Th>For</Th><Th align="right">Allocated</Th><Th>Status</Th><Th>Receipts</Th></tr></thead>
              <tbody>
                {rows.map(({ a, c }) => (
                  <tr key={a.id}>
                    <Td><Link href={`/payments/${a.payment.id}`} className="text-accent hover:underline">{formatDate(a.payment.transferDate)}</Link><span className="block text-xs text-muted">{a.payment.bank ?? ""} {eur(a.payment.amountCents)} total</span></Td>
                    <Td>{categoryLabel(c.category)}</Td>
                    <Td align="right">{eur(a.amountCents)}</Td>
                    <Td><StatusBadge status={a.state === "PROPOSED" ? a.payment.status : "VERIFIED"} /></Td>
                    <Td>{a.payment.evidence.length ? a.payment.evidence.map((e) => <a key={e.fileId} href={`/api/files/${e.fileId}`} className="block truncate text-accent hover:underline">{e.file.originalName}</a>) : <span className="text-muted">—</span>}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          );
        })()}
      </Card>
    </>
  );
}
