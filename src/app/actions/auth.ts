"use server";

import { redirect } from "next/navigation";
import type { ActionResult } from "@/server/errors";
import { clearSessionCookie, requireCtx, setSessionCookie } from "@/server/auth/context";
import { acceptInvite, changePassword, confirmEmailChange, login, requestEmailChange, requestPasswordReset, resetPassword } from "@/server/auth/service";
import { clientIp, run, str } from "./util";

type R = ActionResult<unknown> | null;

/** Only allow same-site relative redirects after login. */
function safeNext(next: string): string {
  return next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/dashboard";
}

export async function loginAction(_: R, fd: FormData) {
  let ok = false;
  const res = await run(async () => {
    const userId = await login(str(fd, "email"), String(fd.get("password") ?? ""), await clientIp());
    await setSessionCookie(userId);
    ok = true;
  });
  if (ok) redirect(safeNext(str(fd, "next")));
  return res;
}

export async function logoutAction() {
  await clearSessionCookie();
  redirect("/login");
}

export async function forgotPasswordAction(_: R, fd: FormData) {
  return run(async () => {
    await requestPasswordReset(str(fd, "email"), await clientIp());
  }, { message: "If an active account exists for that address, a reset link is on its way. Check your inbox." });
}

export async function resetPasswordAction(_: R, fd: FormData) {
  const password = String(fd.get("password") ?? "");
  if (password !== String(fd.get("confirm") ?? "")) return { ok: false, error: "The passwords don't match." } as const;
  let ok = false;
  const res = await run(async () => {
    const userId = await resetPassword(str(fd, "token"), password, await clientIp());
    await setSessionCookie(userId);
    ok = true;
  });
  if (ok) redirect("/dashboard");
  return res;
}

export async function acceptInviteAction(_: R, fd: FormData) {
  const password = String(fd.get("password") ?? "");
  if (password !== String(fd.get("confirm") ?? "")) return { ok: false, error: "The passwords don't match." } as const;
  let ok = false;
  const res = await run(async () => {
    const userId = await acceptInvite(str(fd, "token"), password, await clientIp());
    await setSessionCookie(userId);
    ok = true;
  });
  if (ok) redirect("/dashboard?welcome=1");
  return res;
}

export async function changePasswordAction(_: R, fd: FormData) {
  const next = String(fd.get("next") ?? "");
  if (next !== String(fd.get("confirm") ?? "")) return { ok: false, error: "The new passwords don't match." } as const;
  return run(async () => changePassword(await requireCtx(), String(fd.get("current") ?? ""), next), { message: "Password changed. Other devices were signed out." });
}

export async function requestEmailChangeAction(_: R, fd: FormData) {
  return run(async () => requestEmailChange(await requireCtx(), str(fd, "email"), String(fd.get("password") ?? "")), { message: "Check the new inbox for a confirmation link." });
}

export async function confirmEmailAction(_: R, fd: FormData) {
  return run(async () => confirmEmailChange(str(fd, "token")), { message: "Your email address has been updated." });
}
