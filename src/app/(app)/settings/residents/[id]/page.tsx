import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageAdmin } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { getMemberSummary } from "@/server/finance/queries";
import { isoDate } from "@/server/finance/period";
import { CATEGORIES } from "@/server/finance/types";
import { ActionForm, ConfirmAction, SubmitButton } from "@/components/forms";
import { Alert, ButtonLink, Card, CardHeader, DL, Field, Input, Select, StatusBadge, Table, Td, Textarea, Th } from "@/components/ui";
import { categoryLabel, eur, formatDate, formatPeriod } from "@/lib/format";
import { adjustmentAction, applyDepositAction, payoutAction, reconcileAction, resendInviteAction, reverseAdjustmentAction, reversePayoutAction, setActiveAction, updateMembershipAction } from "@/app/actions/admin";

export const metadata = { title: "Resident" };

export default async function ResidentPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePageAdmin();
  const { id } = await params;
  const m = await prisma.membership.findFirst({ where: { id, apartmentId: ctx.apartmentId }, include: { user: true } });
  if (!m) notFound();
  const [s, adjustments, payouts] = await Promise.all([
    getMemberSummary(ctx, m.id),
    prisma.adjustment.findMany({ where: { membershipId: m.id }, include: { period: true, reversedBy: true }, orderBy: { createdAt: "desc" } }),
    prisma.payout.findMany({ where: { membershipId: m.id }, orderBy: { date: "desc" } }),
  ]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/settings/residents" className="text-sm text-accent hover:underline">← Residents</Link>
          <h2 className="text-xl font-semibold">{m.displayName} <span className="text-base font-normal text-muted">· {m.user.name}</span></h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <ButtonLink variant="secondary" href={`/account?m=${m.id}`}>Financial view</ButtonLink>
          <ButtonLink variant="secondary" href={`/account/statement?m=${m.id}`}>Statement</ButtonLink>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Account" />
          <div className="space-y-4 p-5">
            <DL items={[["Email", m.user.email], ["Account", <StatusBadge key="s" status={m.user.status} />], ["Email verified", m.user.emailVerifiedAt ? formatDate(m.user.emailVerifiedAt) : "No"], ["Last sign-in", m.user.lastLoginAt ? formatDate(m.user.lastLoginAt) : "Never"]]} />
            <div className="flex flex-wrap gap-2">
              {m.user.status === "INVITED" && <ActionForm action={resendInviteAction}><input type="hidden" name="membershipId" value={m.id} /><SubmitButton variant="secondary">Resend invitation</SubmitButton></ActionForm>}
              {m.userId !== ctx.userId && (m.user.status === "DEACTIVATED" ? (
                <ConfirmAction action={setActiveAction} hidden={{ membershipId: m.id, active: "true" }} label="Reactivate account" title="Reactivate this account?" reason={{ label: "Reason" }} />
              ) : (
                <ConfirmAction action={setActiveAction} hidden={{ membershipId: m.id, active: "false" }} label="Deactivate account" variant="ghost" confirmVariant="danger" title="Deactivate this account?" description="They are signed out and can't log in. Their financial history is kept." reason={{ label: "Reason", required: true }} confirmLabel="Deactivate" />
              ))}
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Stay and billing" description="Billing months decide which months this resident is charged for." />
          <div className="p-5">
            <ActionForm action={updateMembershipAction}>
              <input type="hidden" name="membershipId" value={m.id} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Short name" htmlFor="displayName"><Input id="displayName" name="displayName" defaultValue={m.displayName} required /></Field>
                <Field label="Role" htmlFor="role"><Select id="role" name="role" defaultValue={m.role}><option value="RESIDENT">Resident</option><option value="ADMIN">Administrator</option></Select></Field>
                <Field label="Move-in date" htmlFor="moveInDate"><Input id="moveInDate" name="moveInDate" type="date" defaultValue={isoDate(m.moveInDate)} required /></Field>
                <Field label="Move-out date" htmlFor="moveOutDate"><Input id="moveOutDate" name="moveOutDate" type="date" defaultValue={m.moveOutDate ? isoDate(m.moveOutDate) : ""} /></Field>
                <Field label="First billed month" htmlFor="billingStart"><Input id="billingStart" name="billingStart" type="month" defaultValue={m.billingStart} required /></Field>
                <Field label="Last billed month" htmlFor="billingEnd" hint="Blank: derived from move-out date"><Input id="billingEnd" name="billingEnd" type="month" defaultValue={m.billingEnd ?? ""} /></Field>
              </div>
              <Field label="Notes (admin only)" htmlFor="notes"><Textarea id="notes" name="notes" defaultValue={m.notes ?? ""} /></Field>
              <Field label="Reason for the change" htmlFor="reason"><Input id="reason" name="reason" placeholder="e.g. moved out end of November" /></Field>
              <SubmitButton>Save</SubmitButton>
            </ActionForm>
          </div>
        </Card>

        <Card>
          <CardHeader title="Reconciliation" description="Mark the account reconciled once historical charges and payments have been checked." />
          <div className="space-y-3 p-5">
            <DL items={[["Status", <StatusBadge key="r" status={m.reconciliationStatus} />], ["Outstanding to date", eur(s.totalOutstanding)], ["Unallocated credit", eur(s.unallocatedCredit)], ["Pending submissions", `${s.pendingSubmissionCount} (${eur(s.pendingSubmissionCents)})`]]} />
            {m.reconciliationStatus === "UNRECONCILED" ? (
              <ConfirmAction action={reconcileAction} hidden={{ membershipId: m.id, reconciled: "true" }} label="Mark as reconciled" variant="primary" title="Mark as reconciled?" description="Confirm the opening balance, historical charges and imported payments have been checked." reason={{ label: "Note", required: true, placeholder: "e.g. checked against bank statements Jun 2024 – Oct 2026" }} />
            ) : (
              <ConfirmAction action={reconcileAction} hidden={{ membershipId: m.id, reconciled: "false" }} label="Re-open reconciliation" title="Mark as not reconciled?" reason={{ label: "Reason", required: true }} />
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Deposits" />
          <div className="space-y-4 p-5">
            <DL items={[["Required", eur(s.depositDue)], ["Paid (verified)", eur(s.depositPaid)], ["Refunded / applied", eur(s.depositReturned)], ["Held", eur(s.depositHeld)]]} />
            <p className="text-xs text-muted">Add a deposit obligation under Monthly obligations → manual charge (category &ldquo;Security deposit&rdquo; or &ldquo;Rent buffer&rdquo;).</p>
            <details>
              <summary className="cursor-pointer text-sm font-medium text-accent">Record a refund</summary>
              <ActionForm action={payoutAction} resetOnSuccess className="mt-3">
                <input type="hidden" name="membershipId" value={m.id} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Type" htmlFor="kind"><Select id="kind" name="kind"><option value="DEPOSIT_REFUND">Deposit refund</option><option value="CREDIT_REFUND">Credit refund (overpayment)</option></Select></Field>
                  <Field label="Deposit" htmlFor="pcat"><Select id="pcat" name="category"><option value="SECURITY_DEPOSIT">Security deposit</option><option value="RENT_BUFFER">Rent buffer</option></Select></Field>
                  <Field label="Amount (€)" htmlFor="pamount"><Input id="pamount" name="amount" inputMode="decimal" required /></Field>
                  <Field label="Date" htmlFor="pdate"><Input id="pdate" name="date" type="date" required /></Field>
                </div>
                <Field label="Description" htmlFor="pdesc"><Input id="pdesc" name="description" required /></Field>
                <SubmitButton>Record refund</SubmitButton>
              </ActionForm>
            </details>
            <details>
              <summary className="cursor-pointer text-sm font-medium text-accent">Apply deposit to an obligation</summary>
              <ActionForm action={applyDepositAction} resetOnSuccess className="mt-3">
                <input type="hidden" name="membershipId" value={m.id} />
                <Alert tone="warn">Only with the resident&apos;s agreement. This reduces the deposit held and credits the chosen month.</Alert>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="From" htmlFor="dc"><Select id="dc" name="depositCategory"><option value="SECURITY_DEPOSIT">Security deposit</option><option value="RENT_BUFFER">Rent buffer</option></Select></Field>
                  <Field label="Amount (€)" htmlFor="da"><Input id="da" name="amount" inputMode="decimal" required /></Field>
                  <Field label="Month" htmlFor="dp"><Input id="dp" name="period" type="month" required /></Field>
                  <Field label="Towards" htmlFor="dt"><Select id="dt" name="targetCategory">{CATEGORIES.filter((c) => c !== "SECURITY_DEPOSIT" && c !== "RENT_BUFFER").map((c) => <option key={c} value={c}>{categoryLabel(c)}</option>)}</Select></Field>
                </div>
                <Field label="Reason" htmlFor="dr"><Input id="dr" name="reason" required /></Field>
                <SubmitButton>Apply deposit</SubmitButton>
              </ActionForm>
            </details>
            {payouts.length > 0 && (
              <ul className="divide-y divide-line rounded-lg border border-line text-sm">
                {payouts.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2 px-3 py-2">
                    <span className={p.reversedAt ? "text-muted line-through" : ""}>{formatDate(p.date)} · {p.kind.replace(/_/g, " ").toLowerCase()} · {eur(p.amountCents)}<span className="block text-xs text-muted">{p.description}</span></span>
                    {!p.reversedAt && <ConfirmAction action={reversePayoutAction} hidden={{ payoutId: p.id }} label="Reverse" variant="ghost" className="!text-xs" title="Reverse this refund?" reason={{ label: "Reason", required: true }} />}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="Adjustments" description="Opening balances, credits, settlements (e.g. Splitwise) and corrections. Positive amounts increase what is owed." />
          <div className="grid gap-6 p-5 lg:grid-cols-2">
            <ActionForm action={adjustmentAction} resetOnSuccess>
              <input type="hidden" name="membershipId" value={m.id} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Type" htmlFor="akind">
                  <Select id="akind" name="kind">
                    <option value="OPENING_BALANCE">Opening balance</option><option value="SETTLEMENT">Settlement (e.g. Splitwise)</option><option value="CREDIT">Credit</option><option value="DEBIT">Extra charge</option><option value="WRITE_OFF">Write-off</option><option value="CORRECTION">Correction</option>
                  </Select>
                </Field>
                <Field label="Direction" htmlFor="adir"><Select id="adir" name="direction"><option value="debit">Resident owes more (+)</option><option value="credit">Resident owes less (−)</option></Select></Field>
                <Field label="Month" htmlFor="aper"><Input id="aper" name="period" type="month" required /></Field>
                <Field label="Category" htmlFor="acat"><Select id="acat" name="category">{CATEGORIES.map((c) => <option key={c} value={c}>{categoryLabel(c)}</option>)}</Select></Field>
                <Field label="Amount (€)" htmlFor="aamt"><Input id="aamt" name="amount" inputMode="decimal" required /></Field>
              </div>
              <Field label="Reason" htmlFor="areason"><Input id="areason" name="reason" required minLength={3} /></Field>
              <SubmitButton>Record adjustment</SubmitButton>
            </ActionForm>
            {adjustments.length === 0 ? <p className="text-sm text-muted">No adjustments.</p> : (
              <Table>
                <thead><tr><Th>Month</Th><Th>Type</Th><Th align="right">Amount</Th><Th /></tr></thead>
                <tbody>
                  {adjustments.map((a) => (
                    <tr key={a.id}>
                      <Td>{formatPeriod(a.period.period, "short")}<span className="block text-xs text-muted">{categoryLabel(a.category)}</span></Td>
                      <Td wrap className="text-sm">{a.kind.replace(/_/g, " ").toLowerCase()}<span className="block text-xs text-muted">{a.reason}</span></Td>
                      <Td align="right">{eur(a.amountCents)}</Td>
                      <Td>{!a.reversedBy && a.kind !== "REVERSAL" && a.kind !== "DEPOSIT_APPLIED" && <ConfirmAction action={reverseAdjustmentAction} hidden={{ adjustmentId: a.id }} label="Reverse" variant="ghost" className="!text-xs" title="Reverse this adjustment?" description="An opposite entry is recorded; the original stays." reason={{ label: "Reason", required: true }} />}{a.reversedBy && <span className="text-xs text-muted">reversed</span>}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}
