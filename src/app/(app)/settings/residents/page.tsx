import Link from "next/link";
import { requirePageAdmin } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { formatPeriod } from "@/server/finance/period";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, CardHeader, Field, Input, Select, StatusBadge, Table, Td, Th } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { inviteAction } from "@/app/actions/admin";

export const metadata = { title: "Residents" };

export default async function ResidentsPage() {
  const ctx = await requirePageAdmin();
  const members = await prisma.membership.findMany({ where: { apartmentId: ctx.apartmentId }, include: { user: true }, orderBy: [{ status: "asc" }, { moveInDate: "asc" }] });
  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <Card className="xl:col-span-2">
        <CardHeader title="Residents" description="Anyone added here gets an individual login. Billing months decide who is charged." />
        <Table>
          <thead><tr><Th>Name</Th><Th>Role</Th><Th>Billed</Th><Th>Account</Th><Th>Balance check</Th></tr></thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} className="hover:bg-canvas/60">
                <Td>
                  <Link href={`/settings/residents/${m.id}`} className="font-medium text-accent hover:underline">{m.displayName}</Link>
                  <span className="block text-xs text-muted">{m.user.email}</span>
                </Td>
                <Td>{m.role === "ADMIN" ? "Administrator" : "Resident"}</Td>
                <Td className="text-sm whitespace-nowrap">{formatPeriod(m.billingStart, "short")} – {m.billingEnd ? formatPeriod(m.billingEnd, "short") : "now"}<span className="block text-xs text-muted">moved in {formatDate(m.moveInDate)}</span></Td>
                <Td><span className="flex flex-wrap gap-1"><StatusBadge status={m.user.status} />{m.status === "LEFT" && <StatusBadge status="LEFT" />}</span></Td>
                <Td><StatusBadge status={m.reconciliationStatus} /></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      <Card>
        <CardHeader title="Invite a resident" description="They receive an email link (valid 72 hours) to set their password." />
        <div className="p-5">
          <ActionForm action={inviteAction} resetOnSuccess>
            <Field label="Full name" htmlFor="name"><Input id="name" name="name" required maxLength={100} /></Field>
            <Field label="Short name" htmlFor="displayName" hint="Shown in lists, e.g. first name"><Input id="displayName" name="displayName" maxLength={50} /></Field>
            <Field label="Email" htmlFor="email"><Input id="email" name="email" type="email" required /></Field>
            <Field label="Move-in date" htmlFor="moveInDate"><Input id="moveInDate" name="moveInDate" type="date" required /></Field>
            <Field label="First billed month (optional)" htmlFor="billingStart" hint="Default: move-in month if on/before the 15th, otherwise the next month."><Input id="billingStart" name="billingStart" type="month" /></Field>
            <Field label="Role" htmlFor="role"><Select id="role" name="role" defaultValue="RESIDENT"><option value="RESIDENT">Resident</option><option value="ADMIN">Administrator</option></Select></Field>
            <SubmitButton pendingText="Inviting…">Send invitation</SubmitButton>
          </ActionForm>
        </div>
      </Card>
    </div>
  );
}
