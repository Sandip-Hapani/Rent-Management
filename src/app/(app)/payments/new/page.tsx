import { redirect } from "next/navigation";
import { requirePageCtx } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { getMemberSummary } from "@/server/finance/queries";
import { addMonths } from "@/server/finance/period";
import { PaymentForm } from "@/components/payment-form";
import { Card, PageHeader } from "@/components/ui";
import { submitPaymentAction } from "@/app/actions/payments";

export const metadata = { title: "Record a payment" };

export default async function NewPaymentPage() {
  const ctx = await requirePageCtx();
  if (!ctx.membershipActive) redirect("/payments");
  const [summary, apartment, members] = await Promise.all([
    getMemberSummary(ctx, ctx.membershipId),
    prisma.apartment.findUniqueOrThrow({ where: { id: ctx.apartmentId } }),
    ctx.isAdmin ? prisma.membership.findMany({ where: { apartmentId: ctx.apartmentId, status: "ACTIVE" }, orderBy: { moveInDate: "asc" }, select: { id: true, displayName: true } }) : Promise.resolve([]),
  ]);
  // Open months plus the current and next month (people often pay in advance).
  const months = summary.months.filter((m) => m.outstanding > 0 || m.period >= summary.asOf);
  for (const p of [summary.asOf, addMonths(summary.asOf, 1)]) if (!months.some((m) => m.period === p)) months.push({ period: p, outstanding: 0, status: "NO_CHARGES" } as (typeof months)[number]);
  months.sort((a, b) => a.period.localeCompare(b.period));

  return (
    <>
      <PageHeader title="Record a payment" description="Enter a transfer you've already made from your bank. This app doesn't move money; the administrator verifies the record." />
      <Card className="max-w-3xl p-5 sm:p-6">
        <PaymentForm
          action={submitPaymentAction}
          months={months.map((m) => ({ period: m.period, outstanding: m.outstanding, status: m.status }))}
          members={ctx.isAdmin ? [members.find((m) => m.id === ctx.membershipId)!, ...members.filter((m) => m.id !== ctx.membershipId)].filter(Boolean) : undefined}
          maxUploadMb={Math.round(apartment.maxUploadBytes / 1024 / 1024)}
        />
      </Card>
    </>
  );
}
