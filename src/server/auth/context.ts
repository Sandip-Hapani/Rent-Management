import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "../db";
import { forbidden, unauthenticated } from "../errors";
import { isProduction } from "../env";
import { createSession, deleteSessionToken, validateSessionToken, SESSION_TTL_DAYS } from "./session";
import { loadContextForUser, type Ctx } from "./ctx";

export type { Ctx } from "./ctx";

export const SESSION_COOKIE = isProduction() ? "__Host-rent_session" : "rent_session";

export async function setSessionCookie(userId: string): Promise<void> {
  const ua = (await headers()).get("user-agent");
  const { token, expiresAt } = await createSession(userId, ua);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProduction(),
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
    maxAge: SESSION_TTL_DAYS * 86_400,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await deleteSessionToken(token);
  store.delete(SESSION_COOKIE);
}

/** Current request's context, or null when signed out. Cached per request. */
export const getCtx = cache(async (): Promise<Ctx | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await validateSessionToken(token);
  if (!session) return null;
  return loadContextForUser(prisma, session.user.id, session.sessionId);
});

/** For pages: redirect to login when signed out. */
export async function requirePageCtx(): Promise<Ctx> {
  const ctx = await getCtx();
  if (!ctx) redirect("/login");
  return ctx;
}

export async function requirePageAdmin(): Promise<Ctx> {
  const ctx = await requirePageCtx();
  if (!ctx.isAdmin) redirect("/dashboard");
  return ctx;
}

/** For actions and route handlers: throw instead of redirecting. */
export async function requireCtx(): Promise<Ctx> {
  const ctx = await getCtx();
  if (!ctx) throw unauthenticated();
  return ctx;
}

export async function requireAdminCtx(): Promise<Ctx> {
  const ctx = await requireCtx();
  if (!ctx.isAdmin) throw forbidden();
  return ctx;
}
