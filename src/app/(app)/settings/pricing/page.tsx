import Link from "next/link";
import { requirePageAdmin } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { ButtonLink, Card, CardHeader, EmptyState, StatusBadge, Table, Td, Th } from "@/components/ui";
import { categoryLabel, eur, formatPeriod } from "@/lib/format";

export const metadata = { title: "Prices & rules" };

const methodLabel: Record<string, string> = { EQUAL_SPLIT: "Equal split", FIXED_PER_MEMBER: "Fixed per resident", CUSTOM: "Custom amounts", PERCENTAGE: "Percentage" };

export default async function PricingPage() {
  const ctx = await requirePageAdmin();
  const rules = await prisma.chargeRule.findMany({ where: { apartmentId: ctx.apartmentId, status: { not: "ARCHIVED" } }, include: { _count: { select: { shares: true } } }, orderBy: [{ category: "asc" }, { effectiveFrom: "desc" }] });
  const groups = { current: rules.filter((r) => r.status === "PUBLISHED"), drafts: rules.filter((r) => r.status === "DRAFT"), history: rules.filter((r) => r.status === "SUPERSEDED") };
  const amount = (r: (typeof rules)[number]) => (r.method === "FIXED_PER_MEMBER" ? `${eur(r.perMemberAmountCents ?? 0)} each` : r.totalAmountCents != null ? `${eur(r.totalAmountCents)} total` : `${r._count.shares} custom`);

  const table = (rows: typeof rules, actions: boolean) => (
    <Table>
      <thead><tr><Th>Rule</Th><Th>Category</Th><Th>Split</Th><Th align="right">Amount</Th><Th>Period</Th><Th>Status</Th>{actions && <Th />}</tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <Td><Link href={`/settings/pricing/${r.id}`} className="font-medium text-accent hover:underline">{r.name}</Link><span className="block text-xs text-muted">v{r.version}</span></Td>
            <Td>{categoryLabel(r.category)}</Td>
            <Td>{methodLabel[r.method]}</Td>
            <Td align="right">{amount(r)}</Td>
            <Td className="whitespace-nowrap">{formatPeriod(r.effectiveFrom, "short")} – {r.effectiveTo ? formatPeriod(r.effectiveTo, "short") : "ongoing"}</Td>
            <Td><StatusBadge status={r.status} /></Td>
            {actions && <Td><Link className="text-sm text-accent hover:underline" href={`/settings/pricing/new?replace=${r.id}`}>Change price</Link></Td>}
          </tr>
        ))}
      </tbody>
    </Table>
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Current prices" description="Each category has its own effective dates. Changing a price creates a new version; past months are never rewritten." action={<ButtonLink href="/settings/pricing/new">New charge rule</ButtonLink>} />
        {groups.current.length === 0 ? <EmptyState title="No prices configured" action={<ButtonLink href="/settings/pricing/new">Set up rent</ButtonLink>}>Start with rent and electricity. Obligations are generated from these rules every month.</EmptyState> : table(groups.current, true)}
      </Card>
      {groups.drafts.length > 0 && <Card><CardHeader title="Drafts" description="Not yet in effect. Open one to preview and publish." />{table(groups.drafts, false)}</Card>}
      {groups.history.length > 0 && <Card><CardHeader title="Previous prices" />{table(groups.history, false)}</Card>}
    </div>
  );
}
