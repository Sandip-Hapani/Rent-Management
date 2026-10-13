import Link from "next/link";
import { requirePageCtx } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { listPayments } from "@/server/payments/service";
import { ButtonLink, Card, EmptyState, PageHeader, StatusBadge, Table, Tabs, Td, Th, Badge } from "@/components/ui";
import { eur, formatDate, formatPeriod } from "@/lib/format";

export const metadata = { title: "Payments" };

const TABS = [
  { key: "OPEN", label: "Awaiting review" },
  { key: "VERIFIED", label: "Verified" },
  { key: "DRAFT", label: "Drafts" },
  { key: "REJECTED", label: "Rejected" },
  { key: "ALL", label: "All" },
] as const;

export default async function PaymentsPage({ searchParams }: { searchParams: Promise<{ status?: string; member?: string }> }) {
  const ctx = await requirePageCtx();
  const sp = await searchParams;
  const tab = TABS.find((t) => t.key === sp.status)?.key ?? (ctx.isAdmin ? "OPEN" : "ALL");
  const payments = await listPayments(ctx, { status: tab === "ALL" ? undefined : tab, membershipId: sp.member });
  const counts = ctx.isAdmin ? await prisma.payment.count({ where: { apartmentId: ctx.apartmentId, status: { in: ["SUBMITTED", "UNDER_REVIEW", "CLARIFICATION_REQUESTED"] } } }) : 0;
  const members = ctx.isAdmin ? await prisma.membership.findMany({ where: { apartmentId: ctx.apartmentId }, orderBy: { moveInDate: "asc" }, select: { id: true, displayName: true } }) : [];
  const href = (status: string) => `/payments?status=${status}${sp.member ? `&member=${sp.member}` : ""}`;

  return (
    <>
      <PageHeader
        title={ctx.isAdmin ? "Payments" : "My payments"}
        description={ctx.isAdmin ? "Review submitted transfers and keep the ledger accurate." : "Transfers you've recorded and their verification status."}
        actions={ctx.membershipActive && <ButtonLink href="/payments/new">Record a payment</ButtonLink>}
      />
      <Tabs active={tab} items={TABS.map((t) => ({ key: t.key, label: t.label, href: href(t.key), count: t.key === "OPEN" ? counts : undefined }))} />
      {ctx.isAdmin && (
        <form className="mb-4 flex gap-2" action="/payments">
          <input type="hidden" name="status" value={tab} />
          <label className="sr-only" htmlFor="member">Resident</label>
          <select id="member" name="member" defaultValue={sp.member ?? ""} className="rounded-lg border border-line bg-surface px-3 py-2 text-sm">
            <option value="">All residents</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
          </select>
          <button className="rounded-lg border border-line bg-surface px-3 py-2 text-sm hover:bg-canvas">Filter</button>
        </form>
      )}
      <Card>
        {payments.length === 0 ? (
          <EmptyState title={tab === "OPEN" ? "Nothing to review" : "No payments here"} action={ctx.membershipActive && !ctx.isAdmin ? <ButtonLink href="/payments/new">Record a payment</ButtonLink> : undefined}>
            {tab === "OPEN" ? "All submitted payments have been handled." : "Recorded transfers will appear here."}
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Transfer date</Th>
                {ctx.isAdmin && <Th>Resident</Th>}
                <Th align="right">Amount</Th>
                <Th>For</Th>
                <Th>Bank</Th>
                <Th>Status</Th>
                <Th align="center">Files</Th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id} className="hover:bg-canvas/60">
                  <Td><Link href={`/payments/${p.id}`} className="font-medium text-accent hover:underline">{formatDate(p.transferDate)}</Link></Td>
                  {ctx.isAdmin && <Td>{p.membership.displayName}</Td>}
                  <Td align="right" className="font-medium">{eur(p.amountCents)}</Td>
                  <Td className="text-muted">{p.intendedPeriods.map((x) => formatPeriod(x, "short")).join(", ") || "—"}</Td>
                  <Td className="text-muted">{p.bank ?? "—"}</Td>
                  <Td>
                    <span className="flex flex-wrap gap-1"><StatusBadge status={p.status} />{p.source === "IMPORT" && <Badge>Imported</Badge>}{p.source === "SELF_SETTLED" && <Badge>Self-settled</Badge>}</span>
                  </Td>
                  <Td align="center">{p._count.evidence || "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
