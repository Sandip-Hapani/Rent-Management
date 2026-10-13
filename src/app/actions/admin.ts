"use server";

import { redirect } from "next/navigation";
import type { ActionResult } from "@/server/errors";
import { badRequest } from "@/server/errors";
import { requireAdminCtx } from "@/server/auth/context";
import { inviteResident, sendInvite, setAccountActive, updateMembership } from "@/server/auth/service";
import {
  applyDeposit, createAdjustment, createManualCharge, createPayout, deleteDraftRule, finalizePeriod, generatePeriod, publishRule, reverseAdjustment,
  reversePayout, saveDraftRule, setReconciliationStatus, updateApartmentSettings, updateDraftCharge, voidCharge,
} from "@/server/finance/admin";
import { CATEGORIES, type Category } from "@/server/finance/types";
import { saveReminderSchedule } from "@/server/notifications/queries";
import { tick } from "@/server/jobs";
import { bool, int, intList, money, moneyOrNull, optStr, run, str } from "./util";

type R = ActionResult<unknown> | null;

const category = (fd: FormData, k = "category"): Category => {
  const c = str(fd, k);
  if (!(CATEGORIES as readonly string[]).includes(c)) throw badRequest("Choose a category.");
  return c as Category;
};

// ───────────── Residents ─────────────

export async function inviteAction(_: R, fd: FormData) {
  return run(async () => {
    await inviteResident(await requireAdminCtx(), {
      email: str(fd, "email"), name: str(fd, "name"), displayName: str(fd, "displayName") || str(fd, "name").split(" ")[0]!, role: str(fd, "role") === "ADMIN" ? "ADMIN" : "RESIDENT",
      moveInDate: str(fd, "moveInDate"), billingStart: optStr(fd, "billingStart"),
    });
  }, { message: "Invitation sent." });
}

export async function resendInviteAction(_: R, fd: FormData) {
  return run(async () => { await sendInvite(await requireAdminCtx(), str(fd, "membershipId")); }, { message: "Invitation sent again." });
}

export async function setActiveAction(_: R, fd: FormData) {
  return run(async () => setAccountActive(await requireAdminCtx(), str(fd, "membershipId"), str(fd, "active") === "true", str(fd, "reason") || "—"));
}

export async function updateMembershipAction(_: R, fd: FormData) {
  return run(async () => {
    await updateMembership(await requireAdminCtx(), str(fd, "membershipId"), {
      displayName: str(fd, "displayName"), role: str(fd, "role") === "ADMIN" ? "ADMIN" : "RESIDENT", moveInDate: str(fd, "moveInDate"), moveOutDate: optStr(fd, "moveOutDate"),
      billingStart: str(fd, "billingStart"), billingEnd: optStr(fd, "billingEnd"), notes: optStr(fd, "notes"),
    }, str(fd, "reason") || "Membership details updated");
  }, { message: "Saved." });
}

export async function reconcileAction(_: R, fd: FormData) {
  return run(async () => setReconciliationStatus(await requireAdminCtx(), str(fd, "membershipId"), str(fd, "reconciled") === "true", str(fd, "reason")));
}

// ───────────── Pricing ─────────────

function ruleInput(fd: FormData) {
  const method = str(fd, "method") as "EQUAL_SPLIT" | "FIXED_PER_MEMBER" | "CUSTOM" | "PERCENTAGE";
  const shares: { membershipId: string; amountCents: number | null; basisPoints: number | null }[] = [];
  for (const id of fd.getAll("participant").map(String)) {
    if (method === "CUSTOM") shares.push({ membershipId: id, amountCents: moneyOrNull(fd, `share:${id}`) ?? 0, basisPoints: null });
    else if (method === "PERCENTAGE") {
      const pct = Number(str(fd, `share:${id}`).replace(",", "."));
      shares.push({ membershipId: id, amountCents: null, basisPoints: Number.isFinite(pct) ? Math.round(pct * 100) : -1 });
    } else shares.push({ membershipId: id, amountCents: null, basisPoints: null });
  }
  // For EQUAL / FIXED: no participants ticked means "everyone active" (empty shares).
  const allTicked = str(fd, "allMembers") === "on";
  return {
    name: str(fd, "name"),
    category: category(fd),
    method,
    totalAmountCents: method === "EQUAL_SPLIT" || method === "PERCENTAGE" ? money(fd, "total", "Monthly total") : null,
    perMemberAmountCents: method === "FIXED_PER_MEMBER" ? money(fd, "perMember", "Amount per resident") : null,
    effectiveFrom: str(fd, "effectiveFrom"),
    effectiveTo: optStr(fd, "effectiveTo") ?? null,
    reason: optStr(fd, "reason"),
    previousRuleId: optStr(fd, "previousRuleId") ?? null,
    shares: (method === "EQUAL_SPLIT" || method === "FIXED_PER_MEMBER") && allTicked ? [] : shares,
  };
}

export async function saveRuleAction(_: R, fd: FormData) {
  let id: string | null = null;
  const res = await run(async () => {
    const r = await saveDraftRule(await requireAdminCtx(), ruleInput(fd), optStr(fd, "ruleId"));
    id = r.id;
  });
  if (res.ok && id) redirect(`/settings/pricing/${id}`);
  return res;
}

export async function deleteRuleAction(_: R, fd: FormData) {
  const res = await run(async () => deleteDraftRule(await requireAdminCtx(), str(fd, "ruleId")));
  if (res.ok) redirect("/settings/pricing");
  return res;
}

export async function publishRuleAction(_: R, fd: FormData) {
  return run(async () => { await publishRule(await requireAdminCtx(), str(fd, "ruleId"), { reason: str(fd, "reason"), notifyResidents: bool(fd, "notify") }); }, { message: "Published." });
}

// ───────────── Periods & charges ─────────────

export async function generatePeriodAction(_: R, fd: FormData) {
  return run(async () => {
    const r = await generatePeriod(await requireAdminCtx(), str(fd, "period"));
    return { ok: true as const, message: `${r.created} draft charge(s) created${r.skipped ? `, ${r.skipped} already final` : ""}.${r.warnings.length ? ` Warnings: ${r.warnings.join(" ")}` : ""}` };
  });
}

export async function finalizePeriodAction(_: R, fd: FormData) {
  return run(async () => { await finalizePeriod(await requireAdminCtx(), str(fd, "period")); }, { message: "Month finalised. Residents can now see their obligations." });
}

export async function updateDraftChargeAction(_: R, fd: FormData) {
  return run(async () => { await updateDraftCharge(await requireAdminCtx(), str(fd, "chargeId"), money(fd, "amount")); }, { message: "Saved." });
}

export async function manualChargeAction(_: R, fd: FormData) {
  return run(async () => {
    await createManualCharge(await requireAdminCtx(), { membershipId: str(fd, "membershipId"), period: str(fd, "period"), category: category(fd), amountCents: money(fd, "amount"), description: str(fd, "description"), finalize: !bool(fd, "asDraft") });
  }, { message: "Charge added." });
}

export async function voidChargeAction(_: R, fd: FormData) {
  return run(async () => { await voidCharge(await requireAdminCtx(), str(fd, "chargeId"), str(fd, "reason")); });
}

export async function adjustmentAction(_: R, fd: FormData) {
  return run(async () => {
    const kind = str(fd, "kind") as "OPENING_BALANCE" | "CREDIT" | "DEBIT" | "SETTLEMENT" | "WRITE_OFF" | "CORRECTION";
    const amount = money(fd, "amount");
    const direction = str(fd, "direction") === "credit" ? -1 : 1;
    await createAdjustment(await requireAdminCtx(), { membershipId: str(fd, "membershipId"), period: str(fd, "period"), category: category(fd), kind, amountCents: Math.abs(amount) * direction, reason: str(fd, "reason") });
  }, { message: "Adjustment recorded." });
}

export async function reverseAdjustmentAction(_: R, fd: FormData) {
  return run(async () => { await reverseAdjustment(await requireAdminCtx(), str(fd, "adjustmentId"), str(fd, "reason")); });
}

export async function payoutAction(_: R, fd: FormData) {
  return run(async () => {
    const kind = str(fd, "kind") === "CREDIT_REFUND" ? "CREDIT_REFUND" : "DEPOSIT_REFUND";
    const cat = str(fd, "category");
    await createPayout(await requireAdminCtx(), { membershipId: str(fd, "membershipId"), kind, category: kind === "DEPOSIT_REFUND" ? (cat === "RENT_BUFFER" ? "RENT_BUFFER" : "SECURITY_DEPOSIT") : null, amountCents: money(fd, "amount"), date: str(fd, "date"), description: str(fd, "description") });
  }, { message: "Refund recorded." });
}

export async function reversePayoutAction(_: R, fd: FormData) {
  return run(async () => reversePayout(await requireAdminCtx(), str(fd, "payoutId"), str(fd, "reason")));
}

export async function applyDepositAction(_: R, fd: FormData) {
  return run(async () => {
    await applyDeposit(await requireAdminCtx(), { membershipId: str(fd, "membershipId"), depositCategory: str(fd, "depositCategory") === "RENT_BUFFER" ? "RENT_BUFFER" : "SECURITY_DEPOSIT", amountCents: money(fd, "amount"), targetPeriod: str(fd, "period"), targetCategory: category(fd, "targetCategory"), reason: str(fd, "reason") });
  }, { message: "Deposit applied." });
}

// ───────────── Settings & reminders ─────────────

export async function settingsAction(_: R, fd: FormData) {
  return run(async () => updateApartmentSettings(await requireAdminCtx(), { name: str(fd, "name"), address: optStr(fd, "address"), rentDueDay: int(fd, "rentDueDay"), graceDays: int(fd, "graceDays"), maxUploadMb: int(fd, "maxUploadMb") }), { message: "Settings saved." });
}

export async function reminderScheduleAction(_: R, fd: FormData) {
  return run(async () => saveReminderSchedule(await requireAdminCtx(), {
    enabled: bool(fd, "enabled"), daysBeforeDue: intList(fd, "daysBeforeDue"), onDueDate: bool(fd, "onDueDate"), daysAfterDue: intList(fd, "daysAfterDue"),
    repeatEveryDays: str(fd, "repeatEveryDays") ? int(fd, "repeatEveryDays") : null, maxReminders: int(fd, "maxReminders"), excludeFullyPaid: bool(fd, "excludeFullyPaid"),
    mentionPending: bool(fd, "mentionPending"), stopWhenVerified: bool(fd, "stopWhenVerified"), sendHourLocal: int(fd, "sendHourLocal"),
  }), { message: "Reminder schedule saved." });
}

export async function runJobsNowAction(_: R) {
  return run(async () => {
    await requireAdminCtx();
    const r = await tick();
    return { ok: true as const, message: `Reminders queued: ${r.reminders.queued}, skipped: ${r.reminders.skipped}. Emails sent: ${r.outbox.sent}, failed: ${r.outbox.failed}.` };
  });
}
