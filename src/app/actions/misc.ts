"use server";

import { redirect } from "next/navigation";
import type { ActionResult } from "@/server/errors";
import { badRequest } from "@/server/errors";
import { requireAdminCtx, requireCtx } from "@/server/auth/context";
import { acknowledgeDocument, addVersion, archiveDocument, createAnnouncement, createDocument, publishDocument } from "@/server/documents/service";
import { markRead, setPreferences } from "@/server/notifications/queries";
import { cancelBatch, commitBatch, mapAlias, resolveRow, stageImport, verifyImportedWithFullMatch } from "@/server/imports/service";
import { bool, file, money, optStr, run, str } from "./util";

type R = ActionResult<unknown> | null;

// ───────────── Documents ─────────────

export async function createDocumentAction(_: R, fd: FormData) {
  let id: string | null = null;
  const res = await run(async () => {
    const f = file(fd, "file");
    if (!f) throw badRequest("Choose a file to upload.");
    const visibility = str(fd, "visibility") as "ALL_RESIDENTS" | "SELECTED" | "ADMINS_ONLY";
    const d = await createDocument(
      await requireAdminCtx(),
      { title: str(fd, "title"), category: str(fd, "category") as never, description: optStr(fd, "description"), visibility, selectedMembershipIds: fd.getAll("members").map(String), requiresAck: bool(fd, "requiresAck"), priceChangeId: optStr(fd, "priceChangeId") },
      { effectiveDate: optStr(fd, "effectiveDate"), changeSummary: optStr(fd, "changeSummary") },
      f,
      str(fd, "intent") === "publish",
    );
    id = d.id;
  });
  if (res.ok && id) redirect(`/documents/${id}`);
  return res;
}

export async function addVersionAction(_: R, fd: FormData) {
  return run(async () => {
    const f = file(fd, "file");
    if (!f) throw badRequest("Choose a file to upload.");
    await addVersion(await requireAdminCtx(), str(fd, "documentId"), { effectiveDate: optStr(fd, "effectiveDate"), changeSummary: optStr(fd, "changeSummary") }, f, str(fd, "intent") === "publish");
  }, { message: "New version uploaded." });
}

export async function publishDocumentAction(_: R, fd: FormData) {
  return run(async () => publishDocument(await requireAdminCtx(), str(fd, "documentId"), optStr(fd, "versionId")), { message: "Published and residents notified." });
}

export async function archiveDocumentAction(_: R, fd: FormData) {
  return run(async () => archiveDocument(await requireAdminCtx(), str(fd, "documentId")));
}

export async function acknowledgeAction(_: R, fd: FormData) {
  return run(async () => acknowledgeDocument(await requireCtx(), str(fd, "documentId")), { message: "Thanks — your acknowledgement was recorded." });
}

export async function announcementAction(_: R, fd: FormData) {
  return run(async () => { await createAnnouncement(await requireAdminCtx(), str(fd, "title"), str(fd, "body")); }, { message: "Announcement published." });
}

// ───────────── Notifications ─────────────

export async function markReadAction(_: R, fd: FormData) {
  return run(async () => {
    const ids = fd.getAll("id").map(String);
    await markRead(await requireCtx(), ids.length ? ids : "all");
  });
}

export async function preferencesAction(_: R, fd: FormData) {
  return run(async () => {
    const prefs: Record<string, boolean> = {};
    for (const t of fd.getAll("type").map(String)) prefs[t] = fd.get(`email:${t}`) === "on";
    await setPreferences(await requireCtx(), prefs);
  }, { message: "Preferences saved." });
}

// ───────────── Historical import ─────────────

export async function stageImportAction(_: R, fd: FormData) {
  let id: string | null = null;
  const res = await run(async () => {
    const f = file(fd, "file");
    if (!f) throw badRequest("Choose the Excel file.");
    const b = await stageImport(await requireAdminCtx(), f, bool(fd, "force"));
    id = b.id;
  });
  if (res.ok && id) redirect(`/settings/import/${id}`);
  return res;
}

export async function resolveRowAction(_: R, fd: FormData) {
  return run(async () => {
    const decision = str(fd, "decision") as "PENDING" | "IMPORT" | "SKIP";
    await resolveRow(await requireAdminCtx(), str(fd, "rowId"), {
      membershipId: optStr(fd, "membershipId") ?? null, period: str(fd, "period"), amountCents: money(fd, "amount"), transferDate: str(fd, "transferDate"), decision, skipReason: optStr(fd, "skipReason"),
    });
  }, { message: "Row saved." });
}

export async function mapAliasAction(_: R, fd: FormData) {
  return run(async () => {
    const n = await mapAlias(await requireAdminCtx(), str(fd, "batchId"), str(fd, "nameRaw"), str(fd, "membershipId"));
    return { ok: true as const, message: `Name mapped; ${n} row(s) updated.` };
  });
}

export async function commitImportAction(_: R, fd: FormData) {
  return run(async () => {
    const r = await commitBatch(await requireAdminCtx(), str(fd, "batchId"));
    return { ok: true as const, message: `${r.imported} imported, ${r.skipped} skipped, ${r.summary.unresolved} still unresolved.` };
  });
}

export async function cancelImportAction(_: R, fd: FormData) {
  return run(async () => cancelBatch(await requireAdminCtx(), str(fd, "batchId")));
}

export async function bulkVerifyImportAction(_: R, fd: FormData) {
  return run(async () => {
    const r = await verifyImportedWithFullMatch(await requireAdminCtx(), str(fd, "batchId"));
    return { ok: true as const, message: `${r.verified} payment(s) verified; ${r.leftForReview} left for manual review.` };
  });
}
