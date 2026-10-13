import Link from "next/link";
import { requirePageAdmin } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { getBatch } from "@/server/imports/service";
import { BLOCKING, ISSUE_LABELS, REVIEW, type IssueCode } from "@/server/imports/parse";
import { centsToDecimalString } from "@/server/finance/money";
import { isoDate } from "@/server/finance/period";
import { orNotFound } from "@/lib/page";
import { ActionForm, ConfirmAction, SubmitButton } from "@/components/forms";
import { Alert, Badge, Card, CardHeader, Stat, StatusBadge, Tabs, cx } from "@/components/ui";
import { eur, formatDate, formatDateTime, formatPeriod } from "@/lib/format";
import { bulkVerifyImportAction, cancelImportAction, commitImportAction, mapAliasAction, resolveRowAction } from "@/app/actions/misc";

export const metadata = { title: "Review import" };

function IssueBadge({ code }: { code: string }) {
  const tone = BLOCKING.includes(code as IssueCode) ? "bad" : REVIEW.includes(code as IssueCode) ? "warn" : "neutral";
  return <Badge tone={tone}>{ISSUE_LABELS[code as IssueCode] ?? code}</Badge>;
}

export default async function ImportBatchPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ show?: string }> }) {
  const ctx = await requirePageAdmin();
  const { id } = await params;
  const { show = "review" } = await searchParams;
  const { batch, summary } = await orNotFound(getBatch(ctx, id));
  const members = await prisma.membership.findMany({ where: { apartmentId: ctx.apartmentId }, orderBy: { moveInDate: "asc" }, select: { id: true, displayName: true } });
  const names = new Map(members.map((m) => [m.id, m.displayName]));
  const open = batch.status === "STAGED";
  const unmatched = [...new Set(batch.rows.filter((r) => r.nameRaw && (r.issues.includes("UNKNOWN_RESIDENT") || r.issues.includes("AMBIGUOUS_RESIDENT")) && r.status !== "IMPORTED").map((r) => r.nameRaw!))];
  const rows = batch.rows.filter((r) => (show === "review" ? r.status === "NEEDS_REVIEW" || (r.decision === "PENDING" && r.status !== "IMPORTED" && r.status !== "SKIPPED") : show === "ready" ? r.status === "READY" : show === "done" ? r.status === "IMPORTED" || r.status === "SKIPPED" : true));
  const importedPending = await prisma.payment.count({ where: { source: "IMPORT", status: "SUBMITTED", importRow: { batchId: batch.id } } });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/settings/import" className="text-sm text-accent hover:underline">← Imports</Link>
          <h2 className="text-xl font-semibold">{batch.fileName}</h2>
          <p className="text-sm text-muted">Uploaded {formatDateTime(batch.createdAt)} · <StatusBadge status={batch.status} /></p>
        </div>
        <div className="flex flex-wrap gap-2">
          {open && summary.readyToImport + summary.toSkip > 0 && (
            <ConfirmAction action={commitImportAction} hidden={{ batchId: batch.id }} variant="primary" label={`Commit ${summary.readyToImport} row(s)`} title="Commit this import?" description={<>{summary.readyToImport} row(s) become <strong>submitted</strong> payments (not verified) and {summary.toSkip} row(s) are marked skipped. {summary.unresolved} unresolved row(s) stay open for later.</>} confirmLabel="Commit" />
          )}
          {importedPending > 0 && (
            <ConfirmAction action={bulkVerifyImportAction} hidden={{ batchId: batch.id }} label={`Verify fully matched (${importedPending})`} title="Verify imported payments?" description="Only payments whose proposed allocation exactly matches finalised charges for their month are verified. Everything else stays in the review queue. Do this after the historical months have been generated and finalised." confirmLabel="Verify matched" />
          )}
          {open && summary.imported === 0 && <ConfirmAction action={cancelImportAction} hidden={{ batchId: batch.id }} label="Cancel import" variant="ghost" title="Cancel this import?" description="The staged rows are kept for reference but nothing is imported." confirmLabel="Cancel import" />}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <Stat label="Rows" value={summary.total} />
        <Stat label="Ready" value={summary.readyToImport} tone="good" />
        <Stat label="To skip" value={summary.toSkip} />
        <Stat label="Possible duplicates" value={summary.duplicates} tone={summary.duplicates ? "warn" : "neutral"} />
        <Stat label="Unresolved" value={summary.unresolved} tone={summary.unresolved ? "bad" : "good"} />
        <Stat label="Imported" value={summary.imported} />
      </div>

      {unmatched.length > 0 && open && (
        <Card>
          <CardHeader title="Names to match" description="Map each spelling to a resident once; it's remembered for future imports." />
          <ul className="divide-y divide-line">
            {unmatched.map((n) => {
              const suggestion = batch.rows.find((r) => r.nameRaw === n)?.membershipId;
              return (
                <li key={n} className="px-5 py-3">
                  <ActionForm action={mapAliasAction} className="flex flex-wrap items-center gap-3 !space-y-0">
                    <input type="hidden" name="batchId" value={batch.id} />
                    <input type="hidden" name="nameRaw" value={n} />
                    <span className="min-w-40 font-medium">&ldquo;{n}&rdquo;</span>
                    <span className="text-muted">is</span>
                    <label className="sr-only" htmlFor={`alias-${n}`}>Resident</label>
                    <select id={`alias-${n}`} name="membershipId" defaultValue={suggestion ?? ""} required className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm">
                      <option value="" disabled>Choose…</option>
                      {members.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
                    </select>
                    <SubmitButton variant="secondary" pendingText="…">Map</SubmitButton>
                  </ActionForm>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Tabs
        active={show}
        items={[
          { key: "review", label: "Needs a decision", href: `?show=review`, count: summary.unresolved },
          { key: "ready", label: "Ready", href: `?show=ready` },
          { key: "done", label: "Imported / skipped", href: `?show=done` },
          { key: "all", label: "All rows", href: `?show=all` },
        ]}
      />
      {rows.length === 0 ? (
        <Alert tone="good">Nothing in this view.</Alert>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => {
            const locked = !open || r.status === "IMPORTED";
            return (
              <Card key={r.id} className={cx("p-4", r.status === "SKIPPED" && "opacity-70")}>
                <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">Row {r.rowNumber} · {r.nameRaw ?? "(no name)"} · {r.amountCents != null ? eur(r.amountCents) : "no amount"}{r.amountParts.length > 1 && <span className="text-sm font-normal text-muted"> = {r.amountParts.map((p) => eur(p)).join(" + ")}</span>}</p>
                    <p className="text-sm text-muted">
                      {r.monthName ?? "?"} → {r.period ? formatPeriod(r.period) : "?"} · transfer {r.transferDate ? formatDate(r.transferDate) : "?"} · submitted {r.submittedAt ? formatDateTime(r.submittedAt) : "?"} · {r.bank ?? "no bank"}
                    </p>
                    {r.description && <p className="text-sm">“{r.description}”</p>}
                    {r.note && <p className="text-sm text-warn">Note: {r.note}</p>}
                    {r.duplicateOfRow && <p className="text-sm text-warn">Looks like row {r.duplicateOfRow}.</p>}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <StatusBadge status={r.status} />
                    {r.issues.map((i) => <IssueBadge key={i} code={i} />)}
                    {r.payment && <Link className="text-xs text-accent hover:underline" href={`/payments/${r.payment.id}`}>payment →</Link>}
                  </div>
                </div>
                {!locked && (
                  <ActionForm action={resolveRowAction} className="grid gap-2 !space-y-0 sm:grid-cols-6 sm:items-end">
                    <input type="hidden" name="rowId" value={r.id} />
                    <label className="text-xs text-muted">Resident
                      <select name="membershipId" defaultValue={r.membershipId ?? ""} className="mt-0.5 block w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink">
                        <option value="">—</option>
                        {members.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
                      </select>
                    </label>
                    <label className="text-xs text-muted">Month<input name="period" type="month" required defaultValue={r.period ?? ""} className="mt-0.5 block w-full rounded-md border border-line px-2 py-1.5 text-sm text-ink" /></label>
                    <label className="text-xs text-muted">Amount (€)<input name="amount" required defaultValue={r.amountCents != null ? centsToDecimalString(r.amountCents).replace(".", ",") : ""} className="num mt-0.5 block w-full rounded-md border border-line px-2 py-1.5 text-sm text-ink" /></label>
                    <label className="text-xs text-muted">Transfer date<input name="transferDate" type="date" required defaultValue={r.transferDate ? isoDate(r.transferDate) : ""} className="mt-0.5 block w-full rounded-md border border-line px-2 py-1.5 text-sm text-ink" /></label>
                    <label className="text-xs text-muted">Decision
                      <select name="decision" defaultValue={r.decision} className="mt-0.5 block w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink">
                        <option value="PENDING">Undecided</option><option value="IMPORT">Import</option><option value="SKIP">Skip</option>
                      </select>
                    </label>
                    <label className="text-xs text-muted">Skip reason<input name="skipReason" defaultValue={r.skipReason ?? ""} placeholder="if skipping" className="mt-0.5 block w-full rounded-md border border-line px-2 py-1.5 text-sm text-ink" /></label>
                    <div className="sm:col-span-6"><SubmitButton variant="secondary" pendingText="…">Save row</SubmitButton>{r.membershipId && !r.issues.includes("UNKNOWN_RESIDENT") && <span className="ml-3 text-xs text-muted">Resident: {names.get(r.membershipId)}</span>}</div>
                  </ActionForm>
                )}
                {r.status === "SKIPPED" && r.skipReason && <p className="text-sm text-muted">Skipped: {r.skipReason}</p>}
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer text-muted">Original row</summary>
                  <pre className="mt-1 overflow-x-auto rounded bg-canvas p-2">{JSON.stringify(r.raw, null, 2)}</pre>
                </details>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
