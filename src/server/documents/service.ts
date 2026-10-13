/**
 * Document library with version history, visibility and acknowledgements.
 * Uploading a new version never deletes earlier ones.
 */
import type { DocumentCategory, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db";
import { audit } from "../audit";
import { assertAdmin, type Ctx } from "../auth/ctx";
import { rateLimit } from "../auth/rate-limit";
import { badRequest, conflict, notFound } from "../errors";
import { parseIsoDate } from "../finance/period";
import { absoluteUrl, activeResidents, notify } from "../notifications/notify";
import { simpleEmail } from "../notifications/templates";
import { storeUpload } from "../storage/upload";

export const DOCUMENT_CATEGORY_LABELS: Record<DocumentCategory, string> = {
  RENTAL_AGREEMENT: "Rental agreement",
  RENT_INCREASE: "Rent increase letter",
  ELECTRICITY_PRICE_CHANGE: "Electricity price change",
  ELECTRICITY_BILL: "Electricity bill",
  OPERATING_COST_STATEMENT: "Operating cost statement",
  LANDLORD_COMMUNICATION: "Landlord communication",
  PAYMENT_RECEIPT: "Payment receipt",
  OTHER: "Other",
};

export const documentSchema = z.object({
  title: z.string().trim().min(1).max(150),
  category: z.enum(Object.keys(DOCUMENT_CATEGORY_LABELS) as [DocumentCategory, ...DocumentCategory[]]),
  description: z.string().trim().max(2000).optional(),
  visibility: z.enum(["ALL_RESIDENTS", "SELECTED", "ADMINS_ONLY"]),
  selectedMembershipIds: z.array(z.string()).default([]),
  requiresAck: z.boolean().default(false),
  priceChangeId: z.string().optional(),
});

export const versionSchema = z.object({
  effectiveDate: z.string().optional().refine((s) => !s || parseIsoDate(s) !== null, "Enter a valid date"),
  changeSummary: z.string().trim().max(1000).optional(),
});

/** Where-clause for documents a member may see. */
function visibleTo(ctx: Ctx): Prisma.DocumentWhereInput {
  if (ctx.isAdmin) return { apartmentId: ctx.apartmentId };
  return {
    apartmentId: ctx.apartmentId,
    status: "PUBLISHED",
    OR: [{ visibility: "ALL_RESIDENTS" }, { visibility: "SELECTED", access: { some: { membershipId: ctx.membershipId } } }],
  };
}

export async function listDocuments(ctx: Ctx, filter: { category?: DocumentCategory; q?: string } = {}) {
  const docs = await prisma.document.findMany({
    where: {
      ...visibleTo(ctx),
      ...(filter.category ? { category: filter.category } : {}),
      ...(filter.q ? { title: { contains: filter.q, mode: "insensitive" } } : {}),
    },
    include: {
      currentVersion: { include: { file: { select: { id: true, mimeType: true, sizeBytes: true, originalName: true } }, acknowledgements: { where: { membershipId: ctx.membershipId } } } },
      _count: { select: { versions: true } },
    },
    orderBy: [{ updatedAt: "desc" }],
  });
  return docs.map((d) => ({ ...d, acknowledged: (d.currentVersion?.acknowledgements.length ?? 0) > 0 }));
}

export async function getDocument(ctx: Ctx, documentId: string) {
  const doc = await prisma.document.findFirst({
    where: { id: documentId, ...visibleTo(ctx) },
    include: {
      versions: {
        where: ctx.isAdmin ? {} : { publishedAt: { not: null } },
        include: { file: { select: { id: true, mimeType: true, sizeBytes: true, originalName: true, scanStatus: true } }, acknowledgements: { include: { membership: { select: { displayName: true } } } } },
        orderBy: { versionNumber: "desc" },
      },
      access: { include: { membership: { select: { displayName: true } } } },
    },
  });
  if (!doc) throw notFound();
  return doc;
}

/** Create a document with its first version (draft unless publish is true). */
export async function createDocument(ctx: Ctx, raw: z.input<typeof documentSchema>, version: z.input<typeof versionSchema>, file: File, publish: boolean) {
  assertAdmin(ctx);
  await rateLimit(`upload:${ctx.userId}`, 40, 3600);
  const input = documentSchema.parse(raw);
  const v = versionSchema.parse(version);
  if (input.visibility === "SELECTED" && input.selectedMembershipIds.length === 0) throw badRequest("Choose at least one resident.");
  const members = await prisma.membership.findMany({ where: { apartmentId: ctx.apartmentId, id: { in: input.selectedMembershipIds } } });
  if (members.length !== input.selectedMembershipIds.length) throw badRequest("Unknown resident selected.");
  if (input.priceChangeId && !(await prisma.priceChange.findFirst({ where: { id: input.priceChangeId, apartmentId: ctx.apartmentId } }))) throw badRequest("Unknown price change.");
  const stored = await storeUpload({ apartmentId: ctx.apartmentId, uploadedById: ctx.userId, purpose: "DOCUMENT", file });
  const doc = await prisma.$transaction(async (tx) => {
    const d = await tx.document.create({
      data: {
        apartmentId: ctx.apartmentId, title: input.title, category: input.category, description: input.description || null, visibility: input.visibility,
        requiresAck: input.requiresAck, priceChangeId: input.priceChangeId || null, createdById: ctx.userId,
        access: input.visibility === "SELECTED" ? { create: input.selectedMembershipIds.map((membershipId) => ({ membershipId })) } : undefined,
      },
    });
    const ver = await tx.documentVersion.create({
      data: { documentId: d.id, versionNumber: 1, fileId: stored.id, effectiveDate: v.effectiveDate ? parseIsoDate(v.effectiveDate) : null, changeSummary: v.changeSummary || "Initial version", uploadedById: ctx.userId },
    });
    await tx.document.update({ where: { id: d.id }, data: { currentVersionId: ver.id } });
    await audit(tx, { apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: "document.created", entityType: "Document", entityId: d.id, summary: `Document "${input.title}" uploaded` });
    return d;
  });
  if (publish) await publishDocument(ctx, doc.id);
  return doc;
}

/** Add a new version. Older versions are kept; the new one becomes current when published. */
export async function addVersion(ctx: Ctx, documentId: string, version: z.input<typeof versionSchema>, file: File, publish: boolean) {
  assertAdmin(ctx);
  await rateLimit(`upload:${ctx.userId}`, 40, 3600);
  const v = versionSchema.parse(version);
  if (!v.changeSummary) throw badRequest("Describe what changed in this version.");
  const doc = await prisma.document.findFirst({ where: { id: documentId, apartmentId: ctx.apartmentId }, include: { versions: { orderBy: { versionNumber: "desc" }, take: 1 } } });
  if (!doc) throw notFound();
  const stored = await storeUpload({ apartmentId: ctx.apartmentId, uploadedById: ctx.userId, purpose: "DOCUMENT", file });
  const next = (doc.versions[0]?.versionNumber ?? 0) + 1;
  const ver = await prisma.$transaction(async (tx) => {
    const created = await tx.documentVersion.create({
      data: { documentId: doc.id, versionNumber: next, fileId: stored.id, effectiveDate: v.effectiveDate ? parseIsoDate(v.effectiveDate) : null, changeSummary: v.changeSummary, uploadedById: ctx.userId },
    });
    if (doc.status === "DRAFT") await tx.document.update({ where: { id: doc.id }, data: { currentVersionId: created.id } });
    await audit(tx, { apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: "document.version_added", entityType: "Document", entityId: doc.id, summary: `Version ${next} of "${doc.title}" uploaded`, reason: v.changeSummary });
    return created;
  });
  if (publish) await publishDocument(ctx, doc.id, ver.id);
  return ver;
}

/** Publish a document (or a specific version): it becomes current and residents are notified. */
export async function publishDocument(ctx: Ctx, documentId: string, versionId?: string) {
  assertAdmin(ctx);
  const doc = await prisma.document.findFirst({ where: { id: documentId, apartmentId: ctx.apartmentId }, include: { access: true } });
  if (!doc) throw notFound();
  const ver = await prisma.documentVersion.findFirst({ where: { documentId: doc.id, ...(versionId ? { id: versionId } : { id: doc.currentVersionId ?? "" }) } });
  if (!ver) throw notFound("Version not found.");
  if (ver.publishedAt && doc.status === "PUBLISHED" && doc.currentVersionId === ver.id) throw conflict("This version is already published.");
  await prisma.$transaction(async (tx) => {
    await tx.documentVersion.update({ where: { id: ver.id }, data: { publishedAt: ver.publishedAt ?? new Date() } });
    await tx.document.update({ where: { id: doc.id }, data: { status: "PUBLISHED", currentVersionId: ver.id } });
    await audit(tx, {
      apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: "document.published", entityType: "Document", entityId: doc.id, isPublic: doc.visibility === "ALL_RESIDENTS",
      summary: ver.versionNumber > 1 ? `New version of "${doc.title}" published` : `"${doc.title}" was published`,
    });
  });
  if (doc.visibility === "ADMINS_ONLY") return;
  const recipients = (await activeResidents(prisma, ctx.apartmentId)).filter((r) => doc.visibility === "ALL_RESIDENTS" || doc.access.some((a) => a.membershipId === r.id));
  for (const r of recipients) {
    if (r.userId === ctx.userId) continue;
    await notify(prisma, {
      apartmentId: ctx.apartmentId, userId: r.userId, type: "DOCUMENT_PUBLISHED", link: `/documents/${doc.id}`,
      title: ver.versionNumber > 1 ? `Updated: ${doc.title}` : `New document: ${doc.title}`,
      body: doc.requiresAck ? "Please open it and confirm you have seen it." : ver.changeSummary ?? DOCUMENT_CATEGORY_LABELS[doc.category],
      dedupeKey: `doc-published:${ver.id}:${r.id}`,
      email: (u) => simpleEmail({ name: u.name, subject: ver.versionNumber > 1 ? `Updated document: ${doc.title}` : `New document: ${doc.title}`, lines: [`"${doc.title}" (${DOCUMENT_CATEGORY_LABELS[doc.category]}) is now in the apartment's document library.`, ...(ver.changeSummary ? [`What changed: ${ver.changeSummary}`] : []), ...(doc.requiresAck ? ["Please open it and confirm that you have seen it."] : [])], url: absoluteUrl(`/documents/${doc.id}`), action: "Open document" }),
    });
  }
}

export async function archiveDocument(ctx: Ctx, documentId: string) {
  assertAdmin(ctx);
  const doc = await prisma.document.findFirst({ where: { id: documentId, apartmentId: ctx.apartmentId } });
  if (!doc) throw notFound();
  await prisma.$transaction(async (tx) => {
    await tx.document.update({ where: { id: doc.id }, data: { status: "ARCHIVED" } });
    await audit(tx, { apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: "document.archived", entityType: "Document", entityId: doc.id, summary: `"${doc.title}" archived` });
  });
}

/** Record that the member has seen the current version. Not a signature. */
export async function acknowledgeDocument(ctx: Ctx, documentId: string) {
  const doc = await prisma.document.findFirst({ where: { id: documentId, ...visibleTo(ctx), status: "PUBLISHED" } });
  if (!doc || !doc.currentVersionId) throw notFound();
  if (!doc.requiresAck) throw badRequest("This document doesn't need an acknowledgement.");
  await prisma.documentAcknowledgement.upsert({
    where: { versionId_membershipId: { versionId: doc.currentVersionId, membershipId: ctx.membershipId } },
    create: { versionId: doc.currentVersionId, membershipId: ctx.membershipId },
    update: {},
  });
  await audit(prisma, { apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: "document.acknowledged", entityType: "Document", entityId: doc.id, membershipId: ctx.membershipId, summary: `${ctx.displayName} confirmed they have seen "${doc.title}"` });
}

export async function createAnnouncement(ctx: Ctx, title: string, body: string) {
  assertAdmin(ctx);
  const t = z.string().trim().min(1).max(150).parse(title);
  const b = z.string().trim().min(1).max(5000).parse(body);
  const a = await prisma.$transaction(async (tx) => {
    const a = await tx.announcement.create({ data: { apartmentId: ctx.apartmentId, title: t, body: b, createdById: ctx.userId } });
    await audit(tx, { apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: "announcement.published", entityType: "Announcement", entityId: a.id, isPublic: true, summary: `Announcement: ${t}` });
    return a;
  });
  for (const r of await activeResidents(prisma, ctx.apartmentId)) {
    if (r.userId === ctx.userId) continue;
    await notify(prisma, {
      apartmentId: ctx.apartmentId, userId: r.userId, type: "ANNOUNCEMENT", link: "/notifications", title: t, body: b.slice(0, 300), dedupeKey: `announcement:${a.id}:${r.id}`,
      email: (u) => simpleEmail({ name: u.name, subject: t, lines: b.split(/\n{2,}/), url: absoluteUrl("/notifications") }),
    });
  }
  return a;
}
