import Link from "next/link";
import { requirePageCtx } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { DOCUMENT_CATEGORY_LABELS, getDocument } from "@/server/documents/service";
import { orNotFound } from "@/lib/page";
import { ActionForm, ConfirmAction, SubmitButton } from "@/components/forms";
import { Alert, Badge, Card, CardHeader, Field, Input, PageHeader, StatusBadge, Textarea, buttonClass } from "@/components/ui";
import { fileSize, formatDate, formatDateTime } from "@/lib/format";
import { acknowledgeAction, addVersionAction, archiveDocumentAction, publishDocumentAction } from "@/app/actions/misc";

export const metadata = { title: "Document" };

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePageCtx();
  const { id } = await params;
  const doc = await orNotFound(getDocument(ctx, id));
  const current = doc.versions.find((v) => v.id === doc.currentVersionId) ?? doc.versions[0];
  const myAck = current?.acknowledgements.some((a) => a.membershipId === ctx.membershipId);
  const residents = ctx.isAdmin && doc.requiresAck ? await prisma.membership.findMany({ where: { apartmentId: ctx.apartmentId, status: "ACTIVE" }, select: { id: true, displayName: true } }) : [];
  const isImage = current?.file.mimeType.startsWith("image/");

  return (
    <>
      <PageHeader
        title={doc.title}
        description={<><Link href="/documents" className="text-accent hover:underline">← Documents</Link> · {DOCUMENT_CATEGORY_LABELS[doc.category]}</>}
        actions={
          current && (
            <>
              <a className={buttonClass("secondary")} href={`/api/files/${current.file.id}?inline=1`} target="_blank" rel="noopener">Open</a>
              <a className={buttonClass("primary")} href={`/api/files/${current.file.id}`}>Download</a>
            </>
          )
        }
      />
      {ctx.isAdmin && doc.status !== "PUBLISHED" && (
        <div className="mb-4"><Alert tone="warn" title={`This document is ${doc.status.toLowerCase()}.`}>Residents can&apos;t see it until it&apos;s published.</Alert></div>
      )}
      {doc.requiresAck && current && !ctx.isAdmin && (
        <div className="mb-4">
          {myAck ? (
            <Alert tone="good">You confirmed you have seen version {current.versionNumber}.</Alert>
          ) : (
            <Alert tone="warn" title="Please confirm you have seen this document">
              <ActionForm action={acknowledgeAction} className="mt-2">
                <input type="hidden" name="documentId" value={doc.id} />
                <p className="text-xs">This only records that you have seen it. It is not a signature or agreement.</p>
                <SubmitButton>I have seen this document</SubmitButton>
              </ActionForm>
            </Alert>
          )}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {doc.description && <Card className="p-5 text-sm whitespace-pre-line">{doc.description}</Card>}
          {current && (
            <Card className="overflow-hidden">
              {isImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/files/${current.file.id}?inline=1`} alt={doc.title} className="max-h-[70vh] w-full bg-canvas object-contain" />
              ) : (
                <iframe title={`Preview of ${doc.title}`} src={`/api/files/${current.file.id}?inline=1`} className="h-[70vh] w-full bg-canvas" />
              )}
            </Card>
          )}
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader title="Versions" description="Newest first. Earlier versions are always kept." />
            <ol className="divide-y divide-line">
              {doc.versions.map((v) => (
                <li key={v.id} className="px-5 py-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">Version {v.versionNumber}</span>
                    {v.id === doc.currentVersionId && doc.status === "PUBLISHED" ? <Badge tone="good">Current</Badge> : !v.publishedAt ? <Badge tone="warn">Unpublished</Badge> : <Badge>Previous</Badge>}
                  </div>
                  <p className="mt-0.5 text-muted">{v.changeSummary ?? "—"}</p>
                  <p className="text-xs text-muted">
                    Uploaded {formatDate(v.createdAt)}{v.effectiveDate && ` · effective ${formatDate(v.effectiveDate)}`} · {fileSize(v.file.sizeBytes)}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-3 text-xs">
                    <a href={`/api/files/${v.file.id}`} className="text-accent hover:underline">Download</a>
                    {ctx.isAdmin && !v.publishedAt && (
                      <ConfirmAction action={publishDocumentAction} hidden={{ documentId: doc.id, versionId: v.id }} label="Publish" variant="ghost" className="!p-0 !text-xs !text-accent" title={`Publish version ${v.versionNumber}?`} description="It becomes the current version and residents are notified." confirmLabel="Publish" />
                    )}
                  </div>
                  {ctx.isAdmin && doc.requiresAck && v.publishedAt && (
                    <p className="mt-1 text-xs text-muted">Seen by {v.acknowledgements.length}/{residents.length}: {v.acknowledgements.map((a) => a.membership.displayName).join(", ") || "nobody yet"}</p>
                  )}
                </li>
              ))}
            </ol>
          </Card>

          {ctx.isAdmin && (
            <>
              <Card>
                <CardHeader title="Upload a new version" />
                <div className="p-5">
                  <ActionForm action={addVersionAction} resetOnSuccess>
                    <input type="hidden" name="documentId" value={doc.id} />
                    <Field label="What changed?" htmlFor="changeSummary"><Textarea id="changeSummary" name="changeSummary" required maxLength={1000} /></Field>
                    <Field label="Effective date" htmlFor="effectiveDate"><Input id="effectiveDate" name="effectiveDate" type="date" /></Field>
                    <Field label="File" htmlFor="vfile"><input id="vfile" name="file" type="file" required accept="application/pdf,image/png,image/jpeg,image/webp" className="block w-full text-sm" /></Field>
                    <div className="flex flex-wrap gap-2">
                      <SubmitButton name="intent" value="publish" pendingText="Uploading…">Upload &amp; publish</SubmitButton>
                      <SubmitButton name="intent" value="draft" variant="secondary" pendingText="Uploading…">Upload only</SubmitButton>
                    </div>
                  </ActionForm>
                </div>
              </Card>
              <Card className="space-y-2 p-5 text-sm">
                <p><span className="text-muted">Visibility:</span> {doc.visibility === "ALL_RESIDENTS" ? "All residents" : doc.visibility === "ADMINS_ONLY" ? "Administrators only" : `Selected: ${doc.access.map((a) => a.membership.displayName).join(", ")}`}</p>
                <p><span className="text-muted">Status:</span> <StatusBadge status={doc.status} /></p>
                <p className="text-xs text-muted">Created {formatDateTime(doc.createdAt)}</p>
                <div className="flex flex-wrap gap-2 pt-2">
                  {doc.status !== "PUBLISHED" && current && <ConfirmAction action={publishDocumentAction} hidden={{ documentId: doc.id }} label="Publish" variant="primary" title="Publish this document?" description="Residents who can see it will be notified." confirmLabel="Publish" />}
                  {doc.status !== "ARCHIVED" && <ConfirmAction action={archiveDocumentAction} hidden={{ documentId: doc.id }} label="Archive" variant="ghost" title="Archive this document?" description="Residents will no longer see it. All versions are kept." confirmLabel="Archive" />}
                </div>
              </Card>
            </>
          )}
        </div>
      </div>
    </>
  );
}
