"use server";

import { redirect } from "next/navigation";
import type { ActionResult } from "@/server/errors";
import { badRequest } from "@/server/errors";
import { requireCtx } from "@/server/auth/context";
import { isPeriod } from "@/server/finance/period";
import { parseEuroToCents } from "@/server/finance/money";
import type { AllocationRequest } from "@/server/finance/allocation";
import {
  attachEvidence, createPayment, deleteDraftPayment, markUnderReview, reallocatePayment, rejectPayment, removeEvidence,
  requestClarification, reversePayment, updatePayment, verifyPayment,
} from "@/server/payments/service";
import { bool, file, money, optStr, run, str } from "./util";

type R = ActionResult<unknown> | null;

function paymentInput(fd: FormData) {
  const periods = fd.getAll("periods").map(String).filter(isPeriod);
  return {
    amountCents: money(fd, "amount"),
    transferDate: str(fd, "transferDate"),
    bank: optStr(fd, "bank"),
    description: optStr(fd, "description"),
    intendedPeriods: [...new Set(periods)].sort(),
    includesDeposit: bool(fd, "includesDeposit"),
    includesElectricity: bool(fd, "includesElectricity"),
    residentNote: optStr(fd, "residentNote"),
  };
}

/** Allocation rows posted as alloc:<chargeId> = "12,50". Blank / zero rows are ignored. */
function allocations(fd: FormData): AllocationRequest[] {
  const out: AllocationRequest[] = [];
  for (const [k, v] of fd.entries()) {
    if (!k.startsWith("alloc:") || typeof v !== "string" || !v.trim()) continue;
    const cents = parseEuroToCents(v);
    if (cents === null || cents < 0) throw badRequest("Allocation amounts must be valid euro amounts.");
    if (cents > 0) out.push({ chargeId: k.slice(6), amountCents: cents });
  }
  return out;
}

export async function submitPaymentAction(_: R, fd: FormData) {
  let createdId: string | null = null;
  const res = await run(async () => {
    const ctx = await requireCtx();
    const submit = str(fd, "intent") !== "draft";
    const forMember = optStr(fd, "membershipId");
    const p = await createPayment(ctx, paymentInput(fd), { submit, membershipId: forMember });
    createdId = p.id;
    for (const f of fd.getAll("evidence")) if (f instanceof File && f.size > 0) await attachEvidence(ctx, p.id, f);
  });
  if (res.ok && createdId) redirect(`/payments/${createdId}?created=1`);
  return res;
}

export async function updatePaymentAction(_: R, fd: FormData) {
  return run(async () => {
    const ctx = await requireCtx();
    const id = str(fd, "paymentId");
    await updatePayment(ctx, id, paymentInput(fd), { submit: str(fd, "intent") !== "draft" });
    for (const f of fd.getAll("evidence")) if (f instanceof File && f.size > 0) await attachEvidence(ctx, id, f);
  }, { message: "Saved." });
}

export async function uploadEvidenceAction(_: R, fd: FormData) {
  return run(async () => {
    const f = file(fd, "evidence");
    if (!f) throw badRequest("Choose a file to upload.");
    await attachEvidence(await requireCtx(), str(fd, "paymentId"), f);
  }, { message: "File uploaded." });
}

export async function removeEvidenceAction(_: R, fd: FormData) {
  return run(async () => removeEvidence(await requireCtx(), str(fd, "paymentId"), str(fd, "fileId")));
}

export async function deleteDraftAction(_: R, fd: FormData) {
  const res = await run(async () => deleteDraftPayment(await requireCtx(), str(fd, "paymentId")));
  if (res.ok) redirect("/payments");
  return res;
}

export async function startReviewAction(_: R, fd: FormData) {
  return run(async () => markUnderReview(await requireCtx(), str(fd, "paymentId")));
}

export async function verifyPaymentAction(_: R, fd: FormData) {
  return run(async () => verifyPayment(await requireCtx(), str(fd, "paymentId"), allocations(fd), optStr(fd, "adminNote")), { message: "Payment verified." });
}

export async function reallocateAction(_: R, fd: FormData) {
  return run(async () => reallocatePayment(await requireCtx(), str(fd, "paymentId"), allocations(fd), str(fd, "reason")), { message: "Allocation updated." });
}

export async function rejectPaymentAction(_: R, fd: FormData) {
  return run(async () => rejectPayment(await requireCtx(), str(fd, "paymentId"), str(fd, "reason")));
}

export async function clarifyPaymentAction(_: R, fd: FormData) {
  return run(async () => requestClarification(await requireCtx(), str(fd, "paymentId"), str(fd, "reason")));
}

export async function reversePaymentAction(_: R, fd: FormData) {
  return run(async () => reversePayment(await requireCtx(), str(fd, "paymentId"), str(fd, "reason")));
}
