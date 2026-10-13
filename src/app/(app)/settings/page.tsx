import Link from "next/link";
import { requirePageAdmin } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Alert, Card, CardHeader, Field, Input } from "@/components/ui";
import { settingsAction } from "@/app/actions/admin";

export const metadata = { title: "Apartment settings" };

export default async function SettingsPage() {
  const ctx = await requirePageAdmin();
  const [a, rules, residents, periods] = await Promise.all([
    prisma.apartment.findUniqueOrThrow({ where: { id: ctx.apartmentId } }),
    prisma.chargeRule.count({ where: { apartmentId: ctx.apartmentId, status: "PUBLISHED" } }),
    prisma.membership.count({ where: { apartmentId: ctx.apartmentId, status: "ACTIVE" } }),
    prisma.financialPeriod.count({ where: { apartmentId: ctx.apartmentId, status: "FINALIZED" } }),
  ]);
  const steps = [
    { done: residents >= 2, label: "Invite the residents", href: "/settings/residents" },
    { done: rules > 0, label: "Configure rent and electricity", href: "/settings/pricing" },
    { done: periods > 0, label: "Generate and finalise a month", href: "/settings/periods" },
    { done: a.historicalImportDone, label: "Import the historical spreadsheet", href: "/settings/import" },
  ];
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader title="General" />
        <div className="p-5">
          <ActionForm action={settingsAction}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Apartment name" htmlFor="name"><Input id="name" name="name" defaultValue={a.name} required maxLength={100} /></Field>
              <Field label="Address (optional)" htmlFor="address"><Input id="address" name="address" defaultValue={a.address ?? ""} maxLength={300} /></Field>
              <Field label="Rent due day of month" htmlFor="rentDueDay" hint="Applies to months generated from now on."><Input id="rentDueDay" name="rentDueDay" type="number" min={1} max={28} defaultValue={a.rentDueDay} required /></Field>
              <Field label="Grace days before overdue" htmlFor="graceDays"><Input id="graceDays" name="graceDays" type="number" min={0} max={31} defaultValue={a.graceDays} required /></Field>
              <Field label="Max upload size (MB)" htmlFor="maxUploadMb"><Input id="maxUploadMb" name="maxUploadMb" type="number" min={1} max={25} defaultValue={Math.round(a.maxUploadBytes / 1024 / 1024)} required /></Field>
              <Field label="Time zone" htmlFor="tz" hint="Fixed for German apartments."><Input id="tz" value={a.timezone} disabled readOnly /></Field>
            </div>
            <SubmitButton>Save settings</SubmitButton>
          </ActionForm>
        </div>
      </Card>
      <Card>
        <CardHeader title="Setup checklist" />
        <ol className="divide-y divide-line">
          {steps.map((s, i) => (
            <li key={s.href} className="flex items-center gap-3 px-5 py-3 text-sm">
              <span className={s.done ? "grid size-6 place-items-center rounded-full bg-good text-xs text-white" : "grid size-6 place-items-center rounded-full border border-line text-xs text-muted"} aria-hidden>{s.done ? "✓" : i + 1}</span>
              <Link href={s.href} className={s.done ? "text-muted" : "font-medium text-accent hover:underline"}>{s.label}</Link>
              <span className="sr-only">{s.done ? "(done)" : "(to do)"}</span>
            </li>
          ))}
        </ol>
        {!a.historicalImportDone && <div className="p-4"><Alert tone="info">Until historical data is reconciled, residents see a &ldquo;not yet reconciled&rdquo; notice on their balances.</Alert></div>}
      </Card>
    </div>
  );
}
