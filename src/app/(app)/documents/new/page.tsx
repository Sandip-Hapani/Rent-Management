import { requirePageAdmin } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { DOCUMENT_CATEGORY_LABELS } from "@/server/documents/service";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, Field, Input, PageHeader, Select, Textarea } from "@/components/ui";
import { createDocumentAction } from "@/app/actions/misc";
import { categoryLabel, formatPeriod } from "@/lib/format";

export const metadata = { title: "Upload document" };

export default async function NewDocumentPage() {
  const ctx = await requirePageAdmin();
  const [members, apartment, priceChanges] = await Promise.all([
    prisma.membership.findMany({ where: { apartmentId: ctx.apartmentId, status: "ACTIVE" }, orderBy: { moveInDate: "asc" }, select: { id: true, displayName: true } }),
    prisma.apartment.findUniqueOrThrow({ where: { id: ctx.apartmentId } }),
    prisma.priceChange.findMany({ where: { apartmentId: ctx.apartmentId }, orderBy: { publishedAt: "desc" }, take: 20 }),
  ]);
  return (
    <>
      <PageHeader title="Upload document" description="Publishing notifies the residents who can see it." />
      <Card className="max-w-3xl p-5 sm:p-6">
        <ActionForm action={createDocumentAction}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Title" htmlFor="title" className="sm:col-span-2"><Input id="title" name="title" required maxLength={150} placeholder="Rental agreement" /></Field>
            <Field label="Category" htmlFor="category">
              <Select id="category" name="category" required>{Object.entries(DOCUMENT_CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
            </Field>
            <Field label="Effective date (optional)" htmlFor="effectiveDate"><Input id="effectiveDate" name="effectiveDate" type="date" /></Field>
            {priceChanges.length > 0 && (
              <Field label="Related price change (optional)" htmlFor="priceChangeId" className="sm:col-span-2">
                <Select id="priceChangeId" name="priceChangeId" defaultValue="">
                  <option value="">None</option>
                  {priceChanges.map((pc) => <option key={pc.id} value={pc.id}>{categoryLabel(pc.category)} from {formatPeriod(pc.effectiveFrom)}</option>)}
                </Select>
              </Field>
            )}
            <Field label="Description" htmlFor="description" className="sm:col-span-2"><Textarea id="description" name="description" maxLength={2000} /></Field>
            <Field label="File" htmlFor="file" hint={`PDF, PNG, JPEG or WebP, up to ${Math.round(apartment.maxUploadBytes / 1024 / 1024)} MB.`} className="sm:col-span-2">
              <input id="file" name="file" type="file" required accept="application/pdf,image/png,image/jpeg,image/webp" className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-accent-soft file:px-3 file:py-2 file:text-sm file:font-medium file:text-accent-strong" />
            </Field>
          </div>
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-medium">Who can see it?</legend>
            <label className="flex items-center gap-2 text-sm"><input type="radio" name="visibility" value="ALL_RESIDENTS" defaultChecked /> All residents</label>
            <label className="flex items-center gap-2 text-sm"><input type="radio" name="visibility" value="SELECTED" /> Selected residents:</label>
            <div className="ml-6 flex flex-wrap gap-3">
              {members.map((m) => <label key={m.id} className="flex items-center gap-1.5 text-sm"><input type="checkbox" name="members" value={m.id} /> {m.displayName}</label>)}
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="radio" name="visibility" value="ADMINS_ONLY" /> Administrators only</label>
          </fieldset>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="requiresAck" className="mt-0.5" />
            <span>Ask residents to confirm they have seen it <span className="block text-xs text-muted">An acknowledgement only records that a resident opened the document. It is not a signature.</span></span>
          </label>
          <div className="flex gap-2 border-t border-line pt-4">
            <SubmitButton name="intent" value="publish" pendingText="Uploading…">Upload and publish</SubmitButton>
            <SubmitButton name="intent" value="draft" variant="secondary" pendingText="Uploading…">Save as draft</SubmitButton>
          </div>
        </ActionForm>
      </Card>
    </>
  );
}
