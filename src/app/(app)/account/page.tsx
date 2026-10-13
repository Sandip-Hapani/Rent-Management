import Link from "next/link";
import { requirePageCtx } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { getMemberSummary } from "@/server/finance/queries";
import { CATEGORIES, DEPOSIT_CATEGORIES } from "@/server/finance/types";
import { orNotFound } from "@/lib/page";
import { Alert, ButtonLink, Card, CardHeader, EmptyState, PageHeader, Stat, StatusBadge, Table, Td, Th, buttonClass, cx } from "@/components/ui";
import { categoryLabel, eur, fileSize, formatDate, formatPeriod } from "@/lib/format";

export const metadata = { title: "My Account" };

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ m?: string }> }) {
  const ctx = await requirePageCtx();
  const { m } = await searchParams;
  const membershipId = ctx.isAdmin && m ? m : ctx.membershipId;
  const s = await orNotFound(getMemberSummary(ctx, membershipId));
  const viewingOther = membershipId !== ctx.membershipId;
  const memberQ = viewingOther ? `?m=${membershipId}` : "";

  const [pending, evidence, members] = await Promise.all([
    prisma.payment.findMany({ where: { membershipId, status: { in: ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "CLARIFICATION_REQUESTED"] } }, orderBy: { createdAt: "desc" } }),
    prisma.fileObject.findMany({ where: { ownerMembershipId: membershipId, purpose: "PAYMENT_EVIDENCE", deletedAt: null }, orderBy: { createdAt: "desc" }, take: 20, include: { evidence: { select: { paymentId: true } } } }),
    ctx.isAdmin ? prisma.membership.findMany({ where: { apartmentId: ctx.apartmentId }, orderBy: { moveInDate: "asc" }, select: { id: true, displayName: true } }) : Promise.resolve([]),
  ]);

  const openMonths = s.months.filter((x) => x.outstanding > 0 || x.pending > 0);
  const otherCats = (by: (typeof s.months)[number]["byCategory"]) =>
    Object.entries(by).filter(([c]) => c !== "RENT" && c !== "ELECTRICITY").reduce((a, [, l]) => a + (l?.due ?? 0), 0);

  return (
    <>
      <PageHeader
        title={viewingOther ? `${s.displayName}'s account` : "My account"}
        description="Charges, verified payments and balances. Only verified payments reduce what you owe."
        actions={
          <>
            {ctx.isAdmin && (
              <form action="/account" className="flex gap-1">
                <label htmlFor="m" className="sr-only">Resident</label>
                <select id="m" name="m" defaultValue={membershipId} className="rounded-lg border border-line bg-surface px-2 py-2 text-sm">
                  {members.map((x) => <option key={x.id} value={x.id}>{x.displayName}</option>)}
                </select>
                <button className={buttonClass("secondary")}>View</button>
              </form>
            )}
            <ButtonLink variant="secondary" href={`/account/statement${memberQ}`}>Statement</ButtonLink>
            {!viewingOther && ctx.membershipActive && <ButtonLink href="/payments/new">Record a payment</ButtonLink>}
          </>
        }
      />

      {s.reconciliationStatus === "UNRECONCILED" && s.months.length > 0 && (
        <div className="mb-4"><Alert tone="warn" title="Not yet reconciled">Older months are still being checked against historical records, so these figures may change.</Alert></div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={`Obligation · ${formatPeriod(s.asOf, "short")}`} value={eur(s.current.due)} hint={s.current.dueDate ? `Due ${formatDate(s.current.dueDate)}` : "Not generated yet"} />
        <Stat label="Paid this month" value={eur(s.current.confirmed)} tone={s.current.confirmed ? "good" : "neutral"} hint="Verified only" />
        <Stat label="Outstanding this month" value={eur(Math.max(0, s.current.outstanding))} hint={<StatusBadge status={s.current.status} />} tone={s.current.outstanding > 0 ? "warn" : "good"} />
        <Stat label="Total outstanding" value={eur(Math.max(0, s.totalOutstanding))} tone={s.totalOutstanding > 0 ? "bad" : "good"} hint={s.unallocatedCredit > 0 ? `${eur(s.unallocatedCredit)} credit not yet applied` : `${s.overdueMonths.length} earlier month(s) open`} />
        <Stat label="Total paid (verified)" value={eur(s.totalVerifiedPayments)} hint="Since you joined" />
        <Stat label="Waiting for verification" value={eur(s.pendingSubmissionCents)} hint={`${s.pendingSubmissionCount} submission(s)`} tone={s.pendingSubmissionCount ? "warn" : "neutral"} href={`/payments${viewingOther ? `?member=${membershipId}` : ""}`} />
        <Stat label="Deposit held" value={eur(s.depositHeld)} hint={s.depositDue ? `${eur(s.depositPaid)} of ${eur(s.depositDue)} paid` : "No deposit recorded"} />
        <Stat label="Unallocated credit" value={eur(Math.max(0, s.unallocatedCredit))} hint="Overpayments kept on account" />
      </div>

      <Card className="mb-6">
        <CardHeader title="Months with a balance" description="Select a month for its charges, payments, receipts and adjustments." />
        {openMonths.length === 0 ? (
          <EmptyState title="Nothing outstanding">Every month with charges is fully covered by verified payments.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr><Th>Month</Th><Th align="right">Rent</Th><Th align="right">Electricity</Th><Th align="right">Other</Th><Th align="right">Payments allocated</Th><Th align="right">Pending</Th><Th align="right">Remaining due</Th><Th>Status</Th></tr>
            </thead>
            <tbody>
              {openMonths.map((mo) => (
                <tr key={mo.period} className="hover:bg-canvas/60">
                  <Td><Link className="font-medium text-accent hover:underline" href={`/account/month/${mo.period}${memberQ}`}>{formatPeriod(mo.period)}</Link></Td>
                  <Td align="right">{eur(mo.byCategory.RENT?.due ?? 0)}</Td>
                  <Td align="right">{eur(mo.byCategory.ELECTRICITY?.due ?? 0)}</Td>
                  <Td align="right">{eur(otherCats(mo.byCategory))}</Td>
                  <Td align="right">{eur(mo.confirmed)}</Td>
                  <Td align="right">{mo.pending ? eur(mo.pending) : "—"}</Td>
                  <Td align="right" className={cx("font-semibold", mo.outstanding > 0 && "text-bad")}>{eur(mo.outstanding)}</Td>
                  <Td><StatusBadge status={mo.status} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Where your payments went" description="Verified payments by category since joining" />
          <Table>
            <tbody>
              {CATEGORIES.filter((c) => s.paidByCategory[c] > 0 || c === "RENT" || c === "ELECTRICITY").map((c) => (
                <tr key={c}>
                  <Td>{categoryLabel(c)}{DEPOSIT_CATEGORIES.includes(c) && <span className="ml-2 text-xs text-muted">(held, not rent)</span>}</Td>
                  <Td align="right">{eur(s.paidByCategory[c])}</Td>
                </tr>
              ))}
              {s.unallocatedCredit > 0 && <tr><Td>Unallocated credit</Td><Td align="right">{eur(s.unallocatedCredit)}</Td></tr>}
              <tr className="font-semibold"><Td>Total verified</Td><Td align="right">{eur(s.totalVerifiedPayments)}</Td></tr>
            </tbody>
          </Table>
        </Card>

        <Card>
          <CardHeader title="Submissions in progress" action={<Link href="/payments" className="text-xs text-accent hover:underline">All payments</Link>} />
          {pending.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted">No payments waiting for verification.</p>
          ) : (
            <ul className="divide-y divide-line">
              {pending.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                  <Link href={`/payments/${p.id}`} className="min-w-0">
                    <span className="num block font-medium">{eur(p.amountCents)}</span>
                    <span className="block truncate text-xs text-muted">{formatDate(p.transferDate)} · {p.intendedPeriods.map((x) => formatPeriod(x, "short")).join(", ") || "no month selected"}</span>
                  </Link>
                  <StatusBadge status={p.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader title="Uploaded receipts" description="Screenshots and PDFs attached to your payment records" />
        {evidence.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted">No receipts uploaded yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {evidence.map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                <a href={`/api/files/${f.id}`} className="truncate text-accent hover:underline">{f.originalName}</a>
                <span className="shrink-0 text-xs text-muted">
                  {fileSize(f.sizeBytes)} · {formatDate(f.createdAt)}
                  {f.evidence[0] && <> · <Link className="hover:underline" href={`/payments/${f.evidence[0].paymentId}`}>payment</Link></>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
