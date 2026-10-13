import Link from "next/link";
import { requirePageCtx } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { getPaymentForCtx, openChargesFor } from "@/server/payments/service";
import { getMemberSummary } from "@/server/finance/queries";
import { isoDate } from "@/server/finance/period";
import { centsToDecimalString } from "@/server/finance/money";
import { orNotFound } from "@/lib/page";
import { AllocationEditor } from "@/components/allocation-editor";
import { ActionForm, ConfirmAction, SubmitButton } from "@/components/forms";
import { PaymentForm } from "@/components/payment-form";
import { Alert, Badge, Card, CardHeader, DL, PageHeader, StatusBadge, Table, Td, Th } from "@/components/ui";
import { categoryLabel, eur, fileSize, formatDate, formatDateTime, formatPeriod } from "@/lib/format";
import {
  clarifyPaymentAction, deleteDraftAction, reallocateAction, rejectPaymentAction, removeEvidenceAction, reversePaymentAction, startReviewAction, updatePaymentAction, uploadEvidenceAction, verifyPaymentAction,
} from "@/app/actions/payments";

export const metadata = { title: "Payment" };

export default async function PaymentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ created?: string }> }) {
  const ctx = await requirePageCtx();
  const { id } = await params;
  const { created } = await searchParams;
  const p = await orNotFound(getPaymentForCtx(ctx, id));
  const isOwner = p.membershipId === ctx.membershipId;
  const editable = (isOwner || ctx.isAdmin) && (p.status === "DRAFT" || p.status === "CLARIFICATION_REQUESTED");
  const reviewable = ctx.isAdmin && ["SUBMITTED", "UNDER_REVIEW", "CLARIFICATION_REQUESTED"].includes(p.status);
  const apartment = await prisma.apartment.findUniqueOrThrow({ where: { id: ctx.apartmentId } });
  const active = p.allocations.filter((a) => a.state === "ACTIVE");
  const proposed = p.allocations.filter((a) => a.state === "PROPOSED");
  const allocatedActive = active.reduce((s, a) => s + a.amountCents, 0);
  const reviewer = p.reviewedById ? await prisma.user.findUnique({ where: { id: p.reviewedById }, select: { name: true } }) : null;
  const history = await prisma.auditEvent.findMany({ where: { entityType: "Payment", entityId: p.id }, orderBy: { createdAt: "asc" }, select: { id: true, summary: true, createdAt: true, reason: true } });

  let editorCharges: { id: string; period: string; category: string; amountCents: number; openCents: number }[] = [];
  if (ctx.isAdmin && (reviewable || p.status === "VERIFIED")) {
    const open = await openChargesFor(prisma, p.membershipId, p.id);
    editorCharges = open
      .filter((c) => c.amountCents - c.alreadyAllocatedCents > 0 || p.allocations.some((a) => a.chargeId === c.id))
      .map((c) => ({ id: c.id, period: c.period, category: c.category, amountCents: c.amountCents, openCents: c.amountCents - c.alreadyAllocatedCents }))
      .sort((a, b) => a.period.localeCompare(b.period) || a.category.localeCompare(b.category));
  }
  const initial = Object.fromEntries((p.status === "VERIFIED" ? active : proposed).map((a) => [a.chargeId, a.amountCents]));

  let editMonths: { period: string; outstanding: number; status: string }[] = [];
  if (editable) {
    const s = await getMemberSummary(ctx, p.membershipId);
    editMonths = s.months.filter((m) => m.outstanding > 0 || m.period >= s.asOf || p.intendedPeriods.includes(m.period)).map((m) => ({ period: m.period, outstanding: m.outstanding, status: m.status }));
  }

  return (
    <>
      <PageHeader
        title={`${eur(p.amountCents)} · ${formatDate(p.transferDate)}`}
        description={<><Link href="/payments" className="text-accent hover:underline">← Payments</Link> · {p.membership.displayName} · ID <span className="font-mono text-xs">{p.id}</span></>}
        actions={<div className="flex flex-wrap gap-1"><StatusBadge status={p.status} />{p.source !== "APP" && <Badge>{p.source === "IMPORT" ? "Imported" : p.source === "SELF_SETTLED" ? "Self-settled" : "Entered by admin"}</Badge>}</div>}
      />

      <div className="mb-4 space-y-3">
        {created && <Alert tone="good" title={p.status === "DRAFT" ? "Draft saved" : "Payment submitted"}>{p.status === "DRAFT" ? "Submit it when you're ready." : "The administrator has been notified. Your balance updates once it's verified."}</Alert>}
        {p.status === "CLARIFICATION_REQUESTED" && <Alert tone="warn" title="The administrator has a question">{p.clarificationMessage}{isOwner && <span className="mt-1 block">Update the details or add a receipt below, then submit again.</span>}</Alert>}
        {p.status === "REJECTED" && <Alert tone="bad" title="Rejected">{p.rejectionReason}</Alert>}
        {p.status === "REVERSED" && <Alert tone="warn" title="Reversed">{p.reversalReason}</Alert>}
        {(p.status === "SUBMITTED" || p.status === "UNDER_REVIEW") && !ctx.isAdmin && <Alert tone="info">Waiting for verification. Submitted payments don&apos;t reduce your confirmed balance yet.</Alert>}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card className="p-5">
            <DL
              items={[
                ["Amount", eur(p.amountCents)],
                ["Transfer date", formatDate(p.transferDate)],
                ["Bank / provider", p.bank],
                ["Description", p.description],
                ["Intended months", p.intendedPeriods.map((x) => formatPeriod(x)).join(", ") || "—"],
                ["Includes", [p.includesElectricity && "electricity", p.includesDeposit && "deposit"].filter(Boolean).join(", ") || "—"],
                ["Submitted", p.submittedAt ? formatDateTime(p.submittedAt) : "—"],
                ["Reviewed", p.reviewedAt ? `${formatDateTime(p.reviewedAt)}${reviewer ? ` by ${reviewer.name}` : ""}` : "—"],
                ...(p.residentNote ? [["Resident note", p.residentNote] as [string, string]] : []),
                ...(p.adminNote && (ctx.isAdmin || p.status === "VERIFIED") ? [["Administrator note", p.adminNote] as [string, string]] : []),
              ]}
            />
          </Card>

          <Card>
            <CardHeader title="Allocation" description={p.status === "VERIFIED" ? `${eur(allocatedActive)} allocated · ${eur(p.amountCents - allocatedActive)} kept as credit` : "Proposed split — becomes final when verified"} />
            {(p.status === "VERIFIED" ? active : proposed).length === 0 ? (
              <p className="px-5 py-5 text-sm text-muted">{p.status === "VERIFIED" ? "Not allocated; the full amount is credit." : "No allocation proposed yet."}</p>
            ) : (
              <Table>
                <thead><tr><Th>Month</Th><Th>Category</Th><Th align="right">Amount</Th></tr></thead>
                <tbody>
                  {(p.status === "VERIFIED" ? active : proposed).map((a) => (
                    <tr key={a.id}><Td>{formatPeriod(a.charge.period.period)}</Td><Td>{categoryLabel(a.charge.category)}</Td><Td align="right">{eur(a.amountCents)}</Td></tr>
                  ))}
                </tbody>
              </Table>
            )}
            {p.allocations.some((a) => a.state === "REVERSED") && (
              <details className="border-t border-line px-5 py-3 text-sm">
                <summary className="cursor-pointer text-muted">Previous allocations (reversed)</summary>
                <ul className="mt-2 space-y-1">
                  {p.allocations.filter((a) => a.state === "REVERSED").map((a) => (
                    <li key={a.id} className="text-muted line-through">{formatPeriod(a.charge.period.period)} {categoryLabel(a.charge.category)} {eur(a.amountCents)}<span className="no-underline"> — {a.reversalReason}</span></li>
                  ))}
                </ul>
              </details>
            )}
          </Card>

          {reviewable && (
            <Card>
              <CardHeader
                title="Verify this payment"
                description="Check the receipt against the bank statement, then confirm how the money is allocated."
                action={p.status === "SUBMITTED" ? <ActionForm action={startReviewAction}><input type="hidden" name="paymentId" value={p.id} /><SubmitButton variant="ghost">Mark as under review</SubmitButton></ActionForm> : undefined}
              />
              <div className="p-5">
                <AllocationEditor action={verifyPaymentAction} paymentId={p.id} paymentCents={p.amountCents} charges={editorCharges} initial={initial} mode="verify" />
                <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
                  {p.status !== "CLARIFICATION_REQUESTED" && (
                    <ConfirmAction action={clarifyPaymentAction} hidden={{ paymentId: p.id }} label="Ask a question" title="Request clarification" description="The resident is notified and can update the record." reason={{ label: "Your question", required: true }} confirmLabel="Send" />
                  )}
                  <ConfirmAction action={rejectPaymentAction} hidden={{ paymentId: p.id }} label="Reject" variant="ghost" confirmVariant="danger" title="Reject this payment record?" description="Use this when the transfer can't be confirmed. The record is kept." reason={{ label: "Reason (shown to the resident)", required: true }} confirmLabel="Reject" />
                </div>
              </div>
            </Card>
          )}

          {ctx.isAdmin && p.status === "VERIFIED" && (
            <Card>
              <CardHeader title="Correct this payment" description="Corrections never delete history: old allocations are reversed and a new record is written." />
              <div className="space-y-4 p-5">
                <details>
                  <summary className="cursor-pointer text-sm font-medium text-accent">Change allocation</summary>
                  <div className="mt-4"><AllocationEditor action={reallocateAction} paymentId={p.id} paymentCents={p.amountCents} charges={editorCharges} initial={initial} mode="reallocate" /></div>
                </details>
                <ConfirmAction action={reversePaymentAction} hidden={{ paymentId: p.id }} label="Reverse payment" variant="secondary" confirmVariant="danger" title="Reverse this verified payment?" description="Use when the transfer was returned or recorded in error. Balances go back up; the record stays in the ledger." reason={{ label: "Reason", required: true }} confirmLabel="Reverse" />
              </div>
            </Card>
          )}

          {editable && (
            <Card>
              <CardHeader title={p.status === "DRAFT" ? "Edit draft" : "Update and resubmit"} />
              <div className="p-5">
                <PaymentForm
                  action={updatePaymentAction}
                  mode="edit"
                  months={editMonths}
                  maxUploadMb={Math.round(apartment.maxUploadBytes / 1024 / 1024)}
                  defaults={{ paymentId: p.id, amount: centsToDecimalString(p.amountCents).replace(".", ","), transferDate: isoDate(p.transferDate), bank: p.bank ?? "", description: p.description ?? "", periods: p.intendedPeriods, includesDeposit: p.includesDeposit, includesElectricity: p.includesElectricity, residentNote: p.residentNote ?? "" }}
                />
                {p.status === "DRAFT" && (
                  <div className="mt-4 border-t border-line pt-4">
                    <ConfirmAction action={deleteDraftAction} hidden={{ paymentId: p.id }} label="Delete draft" variant="ghost" confirmVariant="danger" title="Delete this draft?" confirmLabel="Delete" />
                  </div>
                )}
              </div>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Receipts" />
            {p.evidence.length === 0 ? (
              <p className="px-5 py-4 text-sm text-muted">No files attached.</p>
            ) : (
              <ul className="divide-y divide-line">
                {p.evidence.map((e) => (
                  <li key={e.id} className="px-5 py-3 text-sm">
                    <a href={`/api/files/${e.file.id}?inline=1`} target="_blank" rel="noopener" className="block truncate font-medium text-accent hover:underline">{e.file.originalName}</a>
                    <span className="text-xs text-muted">{fileSize(e.file.sizeBytes)} · {formatDate(e.file.createdAt)}{e.file.scanStatus === "PENDING" && " · scanning"}</span>
                    <span className="ml-2 inline-flex gap-2 text-xs">
                      <a href={`/api/files/${e.file.id}`} className="text-accent hover:underline">Download</a>
                      {(ctx.isAdmin || (isOwner && ["DRAFT", "SUBMITTED", "CLARIFICATION_REQUESTED"].includes(p.status))) && (
                        <ConfirmAction action={removeEvidenceAction} hidden={{ paymentId: p.id, fileId: e.file.id }} label="Remove" variant="ghost" className="!p-0 !text-xs" title="Remove this file?" confirmVariant="danger" confirmLabel="Remove" />
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {(isOwner || ctx.isAdmin) && !["VERIFIED", "REJECTED", "REVERSED"].includes(p.status) && p.evidence.length < 5 && (
              <div className="border-t border-line p-4">
                <ActionForm action={uploadEvidenceAction} resetOnSuccess>
                  <input type="hidden" name="paymentId" value={p.id} />
                  <label className="sr-only" htmlFor="ev">Add a receipt</label>
                  <input id="ev" name="evidence" type="file" required accept="application/pdf,image/png,image/jpeg,image/webp" className="block w-full text-sm file:mr-2 file:rounded-md file:border-0 file:bg-accent-soft file:px-2 file:py-1.5 file:text-accent-strong" />
                  <SubmitButton variant="secondary" pendingText="Uploading…">Upload</SubmitButton>
                </ActionForm>
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="History" />
            <ol className="divide-y divide-line">
              {history.map((h) => (
                <li key={h.id} className="px-5 py-2.5 text-sm">
                  <p>{h.summary}</p>
                  {h.reason && <p className="text-xs text-muted">“{h.reason}”</p>}
                  <time className="text-xs text-muted">{formatDateTime(h.createdAt)}</time>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </>
  );
}
