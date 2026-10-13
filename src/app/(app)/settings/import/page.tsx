import Link from "next/link";
import { requirePageAdmin } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { summarize } from "@/server/imports/service";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Alert, Card, CardHeader, Field, StatusBadge, Table, Td, Th } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { stageImportAction } from "@/app/actions/misc";

export const metadata = { title: "Historical import" };

export default async function ImportPage() {
  const ctx = await requirePageAdmin();
  const [apartment, batches] = await Promise.all([
    prisma.apartment.findUniqueOrThrow({ where: { id: ctx.apartmentId } }),
    prisma.importBatch.findMany({ where: { apartmentId: ctx.apartmentId }, orderBy: { createdAt: "desc" }, include: { rows: { select: { status: true, decision: true, issues: true, membershipId: true } } } }),
  ]);
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader title="Imports" />
        {batches.length === 0 ? <p className="px-5 py-6 text-sm text-muted">No imports yet.</p> : (
          <Table>
            <thead><tr><Th>File</Th><Th>Uploaded</Th><Th align="right">Rows</Th><Th align="right">Imported</Th><Th align="right">Skipped</Th><Th align="right">Unresolved</Th><Th>Status</Th></tr></thead>
            <tbody>
              {batches.map((b) => {
                const s = summarize(b.rows);
                return (
                  <tr key={b.id}>
                    <Td><Link href={`/settings/import/${b.id}`} className="font-medium text-accent hover:underline">{b.fileName}</Link>{b.forced && <span className="block text-xs text-warn">re-import</span>}</Td>
                    <Td className="whitespace-nowrap">{formatDateTime(b.createdAt)}</Td>
                    <Td align="right">{s.total}</Td><Td align="right">{s.imported}</Td><Td align="right">{s.skipped}</Td><Td align="right">{s.unresolved}</Td>
                    <Td><StatusBadge status={b.status} /></Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
      <Card>
        <CardHeader title="Import the Google-Form spreadsheet" description="Upload the .xlsx export. Rows are checked and staged first; nothing is created until you commit." />
        <div className="space-y-4 p-5">
          {apartment.historicalImportDone && <Alert tone="warn" title="Historical data was already imported.">Importing again may create duplicates. Tick the box below only if you&apos;re sure.</Alert>}
          <ActionForm action={stageImportAction}>
            <Field label="Excel file (.xlsx)" htmlFor="file"><input id="file" name="file" type="file" required accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="block w-full text-sm" /></Field>
            {apartment.historicalImportDone && <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="force" /> Yes, run another import</label>}
            <SubmitButton pendingText="Reading file…">Upload and check</SubmitButton>
          </ActionForm>
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted">
            <li>Imported transfers become <em>submitted</em> payments. Nothing is marked as paid automatically.</li>
            <li>Duplicates, unknown names, date mismatches and manual notes are flagged for your decision.</li>
            <li>The original rows are kept for auditing.</li>
          </ul>
        </div>
      </Card>
    </div>
  );
}
