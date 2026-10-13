import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageAdmin } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { previewRule } from "@/server/finance/admin";
import { centsToDecimalString } from "@/server/finance/money";
import { CATEGORIES } from "@/server/finance/types";
import { ActionForm, ConfirmAction, SubmitButton } from "@/components/forms";
import { RuleForm } from "@/components/rule-form";
import { Alert, ButtonLink, Card, CardHeader, DL, Field, StatusBadge, Table, Td, Textarea, Th, cx } from "@/components/ui";
import { categoryLabel, eur, formatDateTime, formatPeriod } from "@/lib/format";
import { deleteRuleAction, publishRuleAction, saveRuleAction } from "@/app/actions/admin";

export const metadata = { title: "Charge rule" };

const de = (c: number | null | undefined) => (c == null ? undefined : centsToDecimalString(c).replace(".", ","));

export default async function RulePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePageAdmin();
  const { id } = await params;
  const rule = await prisma.chargeRule.findFirst({ where: { id, apartmentId: ctx.apartmentId }, include: { shares: { include: { membership: { select: { displayName: true } } } } } });
  if (!rule) notFound();
  const preview = await previewRule(ctx, rule.id);
  const prev = rule.previousRuleId ? await prisma.chargeRule.findUnique({ where: { id: rule.previousRuleId } }) : null;
  const members = await prisma.membership.findMany({ where: { apartmentId: ctx.apartmentId }, orderBy: { moveInDate: "asc" }, select: { id: true, displayName: true, status: true } });
  const total = preview.rows.reduce((a, r) => a + r.newCents, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/settings/pricing" className="text-sm text-accent hover:underline">← Prices & rules</Link>
          <h2 className="text-xl font-semibold">{rule.name} <span className="text-base font-normal text-muted">v{rule.version}</span></h2>
        </div>
        <div className="flex items-center gap-2"><StatusBadge status={rule.status} />{rule.status === "PUBLISHED" && <ButtonLink variant="secondary" href={`/settings/pricing/new?replace=${rule.id}`}>Change price</ButtonLink>}</div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title={rule.status === "DRAFT" ? `Preview for ${formatPeriod(rule.effectiveFrom)}` : `Charges in ${formatPeriod(rule.effectiveFrom)}`} description={prev ? `Compared with "${prev.name}" v${prev.version}` : "First version of this charge"} />
          {preview.warnings.length > 0 && <div className="space-y-2 p-4">{preview.warnings.map((w) => <Alert key={w} tone="warn">{w}</Alert>)}</div>}
          <Table>
            <thead><tr><Th>Resident</Th><Th align="right">Before</Th><Th align="right">After</Th><Th align="right">Change</Th></tr></thead>
            <tbody>
              {preview.rows.map((r) => (
                <tr key={r.membershipId}>
                  <Td>{r.displayName}</Td>
                  <Td align="right">{prev ? eur(r.previousCents) : "—"}</Td>
                  <Td align="right" className="font-medium">{eur(r.newCents)}</Td>
                  <Td align="right" className={cx(r.differenceCents > 0 ? "text-bad" : r.differenceCents < 0 ? "text-good" : "text-muted")}>{prev ? `${r.differenceCents > 0 ? "+" : ""}${eur(r.differenceCents)}` : "—"}</Td>
                </tr>
              ))}
              <tr className="font-semibold"><Td>Total</Td><Td align="right">{prev ? eur(preview.rows.reduce((a, r) => a + r.previousCents, 0)) : "—"}</Td><Td align="right">{eur(total)}</Td><Td /></tr>
            </tbody>
          </Table>
        </Card>

        <Card>
          <CardHeader title="Details" />
          <div className="space-y-4 p-5">
            <DL items={[
              ["Category", categoryLabel(rule.category)],
              ["Effective", `${formatPeriod(rule.effectiveFrom)} – ${rule.effectiveTo ? formatPeriod(rule.effectiveTo) : "ongoing"}`],
              ["Total", rule.totalAmountCents != null ? eur(rule.totalAmountCents) : "—"],
              ["Per resident", rule.perMemberAmountCents != null ? eur(rule.perMemberAmountCents) : "—"],
              ["Reason", rule.reason],
              ["Published", rule.publishedAt ? formatDateTime(rule.publishedAt) : "—"],
            ]} />
            {rule.status === "DRAFT" && (
              <div className="space-y-4 border-t border-line pt-4">
                <ActionForm action={publishRuleAction}>
                  <input type="hidden" name="ruleId" value={rule.id} />
                  <Field label="Reason for this change (shown to residents)" htmlFor="reason"><Textarea id="reason" name="reason" required defaultValue={rule.reason ?? ""} /></Field>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="notify" defaultChecked={!!prev} /> Email and notify every affected resident</label>
                  <SubmitButton>{prev ? "Confirm price change" : "Publish rule"}</SubmitButton>
                </ActionForm>
                <ConfirmAction action={deleteRuleAction} hidden={{ ruleId: rule.id }} label="Delete draft" variant="ghost" confirmVariant="danger" title="Delete this draft rule?" confirmLabel="Delete" />
              </div>
            )}
          </div>
        </Card>
      </div>

      {rule.status === "DRAFT" && (
        <Card className="max-w-3xl">
          <CardHeader title="Edit draft" />
          <div className="p-5">
            <RuleForm
              action={saveRuleAction}
              categories={CATEGORIES}
              lockCategory={!!rule.previousRuleId}
              members={members.map((m) => ({ id: m.id, displayName: m.displayName, active: m.status === "ACTIVE" }))}
              defaults={{
                ruleId: rule.id, name: rule.name, category: rule.category, method: rule.method, total: de(rule.totalAmountCents), perMember: de(rule.perMemberAmountCents),
                effectiveFrom: rule.effectiveFrom, effectiveTo: rule.effectiveTo ?? undefined, reason: rule.reason ?? undefined, previousRuleId: rule.previousRuleId ?? undefined,
                participants: rule.shares.map((s) => s.membershipId),
                shares: Object.fromEntries(rule.shares.map((s) => [s.membershipId, s.amountCents != null ? de(s.amountCents)! : s.basisPoints != null ? String(s.basisPoints / 100) : ""])),
              }}
            />
          </div>
        </Card>
      )}
    </div>
  );
}
