import { requirePageAdmin } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { addMonths, currentPeriod } from "@/server/finance/period";
import { centsToDecimalString } from "@/server/finance/money";
import { CATEGORIES } from "@/server/finance/types";
import { RuleForm } from "@/components/rule-form";
import { Alert, Card, CardHeader } from "@/components/ui";
import { categoryLabel, formatPeriod } from "@/lib/format";
import { saveRuleAction } from "@/app/actions/admin";

export const metadata = { title: "New charge rule" };

const de = (c: number | null | undefined) => (c == null ? undefined : centsToDecimalString(c).replace(".", ","));

export default async function NewRulePage({ searchParams }: { searchParams: Promise<{ replace?: string }> }) {
  const ctx = await requirePageAdmin();
  const { replace } = await searchParams;
  const [members, prev] = await Promise.all([
    prisma.membership.findMany({ where: { apartmentId: ctx.apartmentId }, orderBy: { moveInDate: "asc" }, select: { id: true, displayName: true, status: true } }),
    replace ? prisma.chargeRule.findFirst({ where: { id: replace, apartmentId: ctx.apartmentId, status: "PUBLISHED" }, include: { shares: true } }) : Promise.resolve(null),
  ]);
  const next = addMonths(currentPeriod(ctx.timezone), 1);
  return (
    <Card className="max-w-3xl">
      <CardHeader
        title={prev ? `Change price: ${prev.name}` : "New charge rule"}
        description={prev ? `Currently in effect since ${formatPeriod(prev.effectiveFrom)}. The new version replaces it from the month you choose.` : "Defines a recurring monthly obligation."}
      />
      <div className="p-5 sm:p-6">
        {prev && <div className="mb-4"><Alert tone="info">Finalised months are never changed. If the new price should apply to a month that is already finalised, correct it with an adjustment.</Alert></div>}
        <RuleForm
          action={saveRuleAction}
          categories={CATEGORIES}
          lockCategory={!!prev}
          members={members.map((m) => ({ id: m.id, displayName: m.displayName, active: m.status === "ACTIVE" }))}
          defaults={prev ? {
            name: prev.name, category: prev.category, method: prev.method, total: de(prev.totalAmountCents), perMember: de(prev.perMemberAmountCents), effectiveFrom: next, previousRuleId: prev.id,
            participants: prev.shares.map((s) => s.membershipId),
            shares: Object.fromEntries(prev.shares.map((s) => [s.membershipId, s.amountCents != null ? de(s.amountCents)! : s.basisPoints != null ? String(s.basisPoints / 100) : ""])),
          } : { effectiveFrom: next, name: "", category: "RENT" }}
        />
        {!prev && <p className="mt-4 text-xs text-muted">Tip: create one rule per category (e.g. {categoryLabel("RENT")}, {categoryLabel("ELECTRICITY")}). One-off amounts such as deposits are added as manual charges.</p>}
      </div>
    </Card>
  );
}
