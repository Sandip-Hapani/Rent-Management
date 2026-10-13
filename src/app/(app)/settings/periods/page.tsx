import Link from "next/link";
import { requirePageAdmin } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { addMonths, currentPeriod } from "@/server/finance/period";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, CardHeader, EmptyState, Field, Input, StatusBadge, Table, Td, Th } from "@/components/ui";
import { eur, formatDate, formatPeriod } from "@/lib/format";
import { generatePeriodAction } from "@/app/actions/admin";

export const metadata = { title: "Monthly obligations" };

export default async function PeriodsPage() {
  const ctx = await requirePageAdmin();
  const periods = await prisma.financialPeriod.findMany({
    where: { apartmentId: ctx.apartmentId },
    orderBy: { period: "desc" },
    include: { charges: { where: { status: { not: "VOID" } }, select: { amountCents: true, status: true } } },
  });
  const next = addMonths(currentPeriod(ctx.timezone), 1);
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader title="Months" description="Generate drafts from the price rules, review them, then finalise. Final charges can't be edited, only voided or adjusted." />
        {periods.length === 0 ? (
          <EmptyState title="No months yet">Generate the first month on the right once prices are configured.</EmptyState>
        ) : (
          <Table>
            <thead><tr><Th>Month</Th><Th>Due</Th><Th align="right">Draft</Th><Th align="right">Final</Th><Th>Status</Th></tr></thead>
            <tbody>
              {periods.map((p) => (
                <tr key={p.id} className="hover:bg-canvas/60">
                  <Td><Link href={`/settings/periods/${p.period}`} className="font-medium text-accent hover:underline">{formatPeriod(p.period)}</Link></Td>
                  <Td>{formatDate(p.dueDate)}</Td>
                  <Td align="right">{eur(p.charges.filter((c) => c.status === "DRAFT").reduce((a, c) => a + c.amountCents, 0))}</Td>
                  <Td align="right">{eur(p.charges.filter((c) => c.status === "FINAL").reduce((a, c) => a + c.amountCents, 0))}</Td>
                  <Td><StatusBadge status={p.status} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Card>
        <CardHeader title="Generate a month" description="Creates draft obligations for everyone billed that month. Safe to repeat; final charges are never duplicated." />
        <div className="p-5">
          <ActionForm action={generatePeriodAction}>
            <Field label="Month" htmlFor="period"><Input id="period" name="period" type="month" required defaultValue={next} /></Field>
            <SubmitButton pendingText="Generating…">Generate drafts</SubmitButton>
          </ActionForm>
        </div>
      </Card>
    </div>
  );
}
