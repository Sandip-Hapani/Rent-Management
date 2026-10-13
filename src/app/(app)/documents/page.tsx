import Link from "next/link";
import type { DocumentCategory } from "@prisma/client";
import { requirePageCtx } from "@/server/auth/context";
import { DOCUMENT_CATEGORY_LABELS, listDocuments } from "@/server/documents/service";
import { Badge, ButtonLink, Card, EmptyState, PageHeader, StatusBadge, Table, Td, Th } from "@/components/ui";
import { fileSize, formatDate } from "@/lib/format";

export const metadata = { title: "Documents" };

export default async function DocumentsPage({ searchParams }: { searchParams: Promise<{ category?: string; q?: string }> }) {
  const ctx = await requirePageCtx();
  const sp = await searchParams;
  const category = sp.category && sp.category in DOCUMENT_CATEGORY_LABELS ? (sp.category as DocumentCategory) : undefined;
  const docs = await listDocuments(ctx, { category, q: sp.q?.slice(0, 100) });
  const needAck = docs.filter((d) => d.requiresAck && d.status === "PUBLISHED" && !d.acknowledged).length;

  return (
    <>
      <PageHeader
        title="Documents"
        description="Rental agreements, price-change letters, bills and other apartment documents."
        actions={ctx.isAdmin && <ButtonLink href="/documents/new">Upload document</ButtonLink>}
      />
      {needAck > 0 && !ctx.isAdmin && <p className="mb-4 rounded-lg border border-amber-200 bg-warn-soft px-4 py-2 text-sm text-amber-900">{needAck} document{needAck === 1 ? "" : "s"} need{needAck === 1 ? "s" : ""} your acknowledgement.</p>}
      <form className="mb-4 flex flex-wrap gap-2" action="/documents">
        <label className="sr-only" htmlFor="q">Search</label>
        <input id="q" name="q" defaultValue={sp.q} placeholder="Search titles" className="rounded-lg border border-line bg-surface px-3 py-2 text-sm" />
        <label className="sr-only" htmlFor="category">Category</label>
        <select id="category" name="category" defaultValue={category ?? ""} className="rounded-lg border border-line bg-surface px-3 py-2 text-sm">
          <option value="">All categories</option>
          {Object.entries(DOCUMENT_CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button className="rounded-lg border border-line bg-surface px-3 py-2 text-sm hover:bg-canvas">Filter</button>
      </form>
      <Card>
        {docs.length === 0 ? (
          <EmptyState title="No documents yet" action={ctx.isAdmin ? <ButtonLink href="/documents/new">Upload the rental agreement</ButtonLink> : undefined}>
            {ctx.isAdmin ? "Upload contracts and notices here instead of sharing them on WhatsApp." : "Published documents will appear here."}
          </EmptyState>
        ) : (
          <Table>
            <thead><tr><Th>Title</Th><Th>Category</Th><Th>Version</Th><Th>Effective</Th><Th>Updated</Th><Th /></tr></thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id} className="hover:bg-canvas/60">
                  <Td wrap>
                    <Link href={`/documents/${d.id}`} className="font-medium text-accent hover:underline">{d.title}</Link>
                    {d.currentVersion && <span className="block text-xs text-muted">{d.currentVersion.file.mimeType === "application/pdf" ? "PDF" : "Image"} · {fileSize(d.currentVersion.file.sizeBytes)}</span>}
                  </Td>
                  <Td className="text-muted">{DOCUMENT_CATEGORY_LABELS[d.category]}</Td>
                  <Td>v{d.currentVersion?.versionNumber ?? 1}{d._count.versions > 1 && <span className="text-xs text-muted"> of {d._count.versions}</span>}</Td>
                  <Td className="text-muted">{d.currentVersion?.effectiveDate ? formatDate(d.currentVersion.effectiveDate) : "—"}</Td>
                  <Td className="text-muted">{formatDate(d.updatedAt)}</Td>
                  <Td>
                    <span className="flex flex-wrap gap-1">
                      {ctx.isAdmin && d.status !== "PUBLISHED" && <StatusBadge status={d.status} />}
                      {ctx.isAdmin && d.visibility !== "ALL_RESIDENTS" && <Badge>{d.visibility === "ADMINS_ONLY" ? "Admins only" : "Selected residents"}</Badge>}
                      {d.requiresAck && (d.acknowledged ? <Badge tone="good">Acknowledged</Badge> : !ctx.isAdmin && <Badge tone="warn">Please acknowledge</Badge>)}
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
