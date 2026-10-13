import { requirePageAdmin } from "@/server/auth/context";
import { auditLog } from "@/server/notifications/queries";
import { Card, CardHeader, EmptyState, Table, Td, Th } from "@/components/ui";
import { formatDateTime } from "@/lib/format";

export const metadata = { title: "Audit log" };

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ q?: string; type?: string }> }) {
  const ctx = await requirePageAdmin();
  const sp = await searchParams;
  const events = await auditLog(ctx, { q: sp.q?.slice(0, 100), entityType: sp.type || undefined });
  const types = ["Payment", "Charge", "Adjustment", "Payout", "ChargeRule", "FinancialPeriod", "Membership", "User", "Document", "ImportBatch", "ImportRow", "Apartment", "ReminderSchedule"];
  return (
    <Card>
      <CardHeader title="Audit log" description="Every financial change and administrative action, with who did it and why. Entries can't be edited." />
      <form className="flex flex-wrap gap-2 border-b border-line px-5 py-3" action="/settings/audit">
        <label className="sr-only" htmlFor="q">Search</label>
        <input id="q" name="q" defaultValue={sp.q} placeholder="Search" className="rounded-lg border border-line bg-surface px-3 py-2 text-sm" />
        <label className="sr-only" htmlFor="type">Type</label>
        <select id="type" name="type" defaultValue={sp.type ?? ""} className="rounded-lg border border-line bg-surface px-3 py-2 text-sm">
          <option value="">All types</option>
          {types.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <button className="rounded-lg border border-line bg-surface px-3 py-2 text-sm hover:bg-canvas">Filter</button>
      </form>
      {events.length === 0 ? <EmptyState title="No events" /> : (
        <Table>
          <thead><tr><Th>When</Th><Th>Event</Th><Th>Reason</Th><Th>Details</Th></tr></thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <Td className="whitespace-nowrap">{formatDateTime(e.createdAt)}</Td>
                <Td wrap>{e.summary}</Td>
                <Td wrap className="text-sm text-muted">{e.reason ?? ""}</Td>
                <Td>
                  <details className="text-xs">
                    <summary className="cursor-pointer text-accent">Show</summary>
                    <p className="mt-1 font-mono text-muted">{e.action}</p>
                    {(e.before || e.after) && <pre className="mt-1 max-w-md rounded bg-canvas p-2 break-all whitespace-pre-wrap">{JSON.stringify({ before: e.before, after: e.after }, null, 2)}</pre>}
                  </details>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
