import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageAdmin } from "@/server/auth/context";
import { getPeriodReview } from "@/server/finance/admin";
import { centsToDecimalString } from "@/server/finance/money";
import { isPeriod } from "@/server/finance/period";
import { CATEGORIES } from "@/server/finance/types";
import { ActionForm, ConfirmAction, SubmitButton } from "@/components/forms";
import { Alert, Card, CardHeader, Field, Input, Select, StatusBadge, Table, Td, Th, cx } from "@/components/ui";
import { categoryLabel, eur, formatDate, formatPeriod } from "@/lib/format";
import { finalizePeriodAction, generatePeriodAction, manualChargeAction, updateDraftChargeAction, voidChargeAction } from "@/app/actions/admin";

export const metadata = { title: "Month review" };

export default async function PeriodReviewPage({ params }: { params: Promise<{ period: string }> }) {
  const ctx = await requirePageAdmin();
  const { period } = await params;
  if (!isPeriod(period)) notFound();
  const r = await getPeriodReview(ctx, period);
  const names = new Map(r.members.map((m) => [m.id, m.displayName]));
  const drafts = r.charges.filter((c) => c.status === "DRAFT");
  const byMember = new Map<string, typeof r.charges>();
  for (const c of r.charges) byMember.set(c.membershipId, [...(byMember.get(c.membershipId) ?? []), c]);
  const totalDraft = drafts.reduce((a, c) => a + c.amountCents, 0);
  const totalFinal = r.charges.filter((c) => c.status === "FINAL").reduce((a, c) => a + c.amountCents, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/settings/periods" className="text-sm text-accent hover:underline">← Months</Link>
          <h2 className="text-xl font-semibold">{formatPeriod(period)}</h2>
          {r.fp && <p className="text-sm text-muted">Due {formatDate(r.fp.dueDate)}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {r.fp && <StatusBadge status={r.fp.status} />}
          <ActionForm action={generatePeriodAction} className="!space-y-0"><input type="hidden" name="period" value={period} /><SubmitButton variant="secondary" pendingText="Generating…">{r.fp ? "Regenerate drafts" : "Generate drafts"}</SubmitButton></ActionForm>
          {drafts.length > 0 && (
            <ConfirmAction
              action={finalizePeriodAction}
              hidden={{ period }}
              label={`Finalise ${drafts.length} charge${drafts.length === 1 ? "" : "s"}`}
              variant="primary"
              title={`Finalise ${formatPeriod(period)}?`}
              description={<>Residents will see these obligations ({eur(totalDraft)} in total). Final charges can only be voided or adjusted afterwards, never edited.</>}
              confirmLabel="Finalise"
            />
          )}
        </div>
      </div>

      {r.ruleChecks.some((c) => !c.ok) && (
        <Alert tone="bad" title="Split doesn't add up">{r.ruleChecks.filter((c) => !c.ok).map((c) => `${c.name}: ${eur(c.total)} generated vs ${eur(c.expected ?? 0)} configured`).join("; ")}</Alert>
      )}
      {r.ruleChecks.length > 0 && r.ruleChecks.every((c) => c.ok) && <Alert tone="good">Every split reconciles exactly with its apartment-wide total.</Alert>}

      <Card>
        <CardHeader title="Obligations" description={`${eur(totalFinal)} final · ${eur(totalDraft)} draft`} />
        {r.charges.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted">No charges. Generate drafts from the price rules, or add a manual charge below.</p>
        ) : (
          <Table>
            <thead><tr><Th>Resident</Th><Th>Item</Th><Th align="right">Amount</Th><Th>Status</Th><Th /></tr></thead>
            <tbody>
              {[...byMember.entries()].map(([memberId, cs]) =>
                cs.map((c, i) => (
                  <tr key={c.id} className={cx(c.status === "VOID" && "text-muted")}>
                    <Td className="font-medium">{i === 0 ? names.get(memberId) : ""}</Td>
                    <Td wrap>{categoryLabel(c.category)}<span className="block text-xs text-muted">{c.rule ? `${c.rule.name} v${c.ruleVersion}` : c.description ?? "Manual"}{c.status === "VOID" && ` · void: ${c.voidReason}`}</span></Td>
                    <Td align="right">
                      {c.status === "DRAFT" ? (
                        <ActionForm action={updateDraftChargeAction} className="flex !space-y-0 items-center justify-end gap-1">
                          <input type="hidden" name="chargeId" value={c.id} />
                          <label className="sr-only" htmlFor={`amt-${c.id}`}>Amount</label>
                          <input id={`amt-${c.id}`} name="amount" defaultValue={centsToDecimalString(c.amountCents).replace(".", ",")} className="num w-24 rounded-md border border-line px-2 py-1 text-right" />
                          <SubmitButton variant="ghost" pendingText="…">Save</SubmitButton>
                        </ActionForm>
                      ) : <span className={cx(c.status === "VOID" && "line-through")}>{eur(c.amountCents)}</span>}
                    </Td>
                    <Td><StatusBadge status={c.status} /></Td>
                    <Td>{c.status !== "VOID" && <ConfirmAction action={voidChargeAction} hidden={{ chargeId: c.id }} label={c.status === "DRAFT" ? "Remove" : "Void"} variant="ghost" className="!text-xs" confirmVariant="danger" title={c.status === "DRAFT" ? "Remove this draft charge?" : "Void this final charge?"} description={c.status === "FINAL" ? "Any payments allocated to it become credit on the resident's account." : undefined} reason={{ label: "Reason", required: true }} confirmLabel={c.status === "DRAFT" ? "Remove" : "Void"} />}</Td>
                  </tr>
                )),
              )}
            </tbody>
          </Table>
        )}
      </Card>

      <Card className="max-w-3xl">
        <CardHeader title="Add a manual charge" description="For deposits, operating-cost settlements (Betriebskosten) or one-off shared expenses." />
        <div className="p-5">
          <ActionForm action={manualChargeAction} resetOnSuccess>
            <input type="hidden" name="period" value={period} />
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Resident" htmlFor="membershipId"><Select id="membershipId" name="membershipId">{r.members.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}</Select></Field>
              <Field label="Category" htmlFor="category"><Select id="category" name="category" defaultValue="OPERATING_COSTS">{CATEGORIES.map((c) => <option key={c} value={c}>{categoryLabel(c)}</option>)}</Select></Field>
              <Field label="Amount (€)" htmlFor="amount"><Input id="amount" name="amount" inputMode="decimal" required /></Field>
            </div>
            <Field label="Description" htmlFor="description"><Input id="description" name="description" required maxLength={300} placeholder="Betriebskostenabrechnung 2025" /></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="asDraft" /> Add as draft (finalise with the month)</label>
            <SubmitButton>Add charge</SubmitButton>
          </ActionForm>
        </div>
      </Card>
    </div>
  );
}
