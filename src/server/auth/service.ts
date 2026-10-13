/**
 * Account lifecycle: invitations, sign-in, password reset, email change, (de)activation.
 * These functions never touch cookies — the action layer turns a returned userId into a session.
 */
import type { Role } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db";
import { audit } from "../audit";
import { AppError, badRequest, conflict, forbidden, notFound } from "../errors";
import { defaultBillingEnd, defaultBillingStart, isPeriod, parseIsoDate } from "../finance/period";
import { queueEmail } from "../notifications/email";
import { absoluteUrl } from "../notifications/notify";
import { inviteEmail, passwordResetEmail, securityNoticeEmail, simpleEmail } from "../notifications/templates";
import { hashPassword, normalizeEmail, passwordProblems, randomToken, sha256, verifyPassword } from "./crypto";
import { assertAdmin, type Ctx } from "./ctx";
import { rateLimit } from "./rate-limit";
import { revokeAllSessions } from "./session";

const INVITE_TTL_HOURS = 72;
const RESET_TTL_MINUTES = 60;
const VERIFY_TTL_HOURS = 24;

async function issueToken(type: "INVITE" | "PASSWORD_RESET" | "EMAIL_VERIFY", data: { email: string; userId?: string; membershipId?: string; createdById?: string }, ttlMs: number) {
  const token = randomToken();
  // Only one live token of a type per email: older ones stop working.
  await prisma.authToken.updateMany({ where: { email: data.email, type, usedAt: null }, data: { usedAt: new Date() } });
  const row = await prisma.authToken.create({
    data: { type, tokenHash: sha256(token), email: data.email, userId: data.userId, membershipId: data.membershipId, createdById: data.createdById, expiresAt: new Date(Date.now() + ttlMs) },
  });
  return { token, row };
}

async function consumeToken(type: "INVITE" | "PASSWORD_RESET" | "EMAIL_VERIFY", token: string) {
  const row = await prisma.authToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!row || row.type !== type || row.usedAt || row.expiresAt.getTime() < Date.now()) {
    throw badRequest("This link is invalid or has expired. Ask for a new one.");
  }
  return row;
}

/** Look up a token without consuming it (for rendering the accept/reset page). */
export async function peekToken(type: "INVITE" | "PASSWORD_RESET" | "EMAIL_VERIFY", token: string) {
  const row = await prisma.authToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!row || row.type !== type || row.usedAt || row.expiresAt.getTime() < Date.now()) return null;
  const user = row.userId ? await prisma.user.findUnique({ where: { id: row.userId }, select: { name: true, email: true } }) : null;
  return { email: row.email, name: user?.name ?? "" };
}

// ───────────── Invitations ─────────────

export const inviteSchema = z.object({
  email: z.string().trim().email().max(200),
  name: z.string().trim().min(1).max(100),
  displayName: z.string().trim().min(1).max(50),
  role: z.enum(["ADMIN", "RESIDENT"]),
  moveInDate: z.string().refine((s) => parseIsoDate(s) !== null, "Enter a valid date"),
  billingStart: z.string().optional().refine((s) => !s || isPeriod(s), "Use YYYY-MM"),
});

export async function inviteResident(ctx: Ctx, raw: z.input<typeof inviteSchema>) {
  assertAdmin(ctx);
  const input = inviteSchema.parse(raw);
  const email = normalizeEmail(input.email);
  const moveIn = parseIsoDate(input.moveInDate)!;

  const result = await prisma.$transaction(async (tx) => {
    let user = await tx.user.findUnique({ where: { email } });
    if (user) {
      const activeHere = await tx.membership.findFirst({ where: { userId: user.id, apartmentId: ctx.apartmentId, status: "ACTIVE" } });
      if (activeHere) throw conflict("This person already lives in the apartment.");
      const elsewhere = await tx.membership.findFirst({ where: { userId: user.id, apartmentId: { not: ctx.apartmentId } } });
      if (elsewhere) throw conflict("This email belongs to an account in another apartment.");
    } else {
      user = await tx.user.create({ data: { email, name: input.name, status: "INVITED" } });
    }
    const membership = await tx.membership.create({
      data: {
        apartmentId: ctx.apartmentId,
        userId: user.id,
        role: input.role as Role,
        displayName: input.displayName,
        moveInDate: moveIn,
        billingStart: input.billingStart || defaultBillingStart(moveIn),
      },
    });
    await audit(tx, {
      apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: "resident.invited", entityType: "Membership", entityId: membership.id,
      membershipId: membership.id, summary: `${ctx.displayName} invited ${input.displayName} (${input.role.toLowerCase()})`,
      after: { email, role: input.role, billingStart: membership.billingStart },
    });
    return { user, membership };
  });

  if (result.user.status !== "ACTIVE") await sendInvite(ctx, result.membership.id);
  return result.membership;
}

/** (Re)send an invitation link for a membership whose user hasn't activated yet. */
export async function sendInvite(ctx: Ctx, membershipId: string) {
  assertAdmin(ctx);
  const membership = await prisma.membership.findFirst({ where: { id: membershipId, apartmentId: ctx.apartmentId }, include: { user: true } });
  if (!membership) throw notFound();
  if (membership.user.status === "ACTIVE") throw badRequest("This account is already active.");
  if (membership.user.status === "DEACTIVATED") throw badRequest("Reactivate the account first.");
  await rateLimit(`invite:${membershipId}`, 5, 3600);
  const { token, row } = await issueToken("INVITE", { email: membership.user.email, userId: membership.userId, membershipId, createdById: ctx.userId }, INVITE_TTL_HOURS * 3_600_000);
  await queueEmail(prisma, {
    apartmentId: ctx.apartmentId, userId: membership.userId, toEmail: membership.user.email, kind: "INVITE", dedupeKey: `invite:${row.id}`,
    content: inviteEmail({ name: membership.user.name, apartmentName: ctx.apartmentName, invitedBy: ctx.displayName, url: absoluteUrl(`/invite/${token}`), expiresHours: INVITE_TTL_HOURS }),
  });
  return { inviteUrl: absoluteUrl(`/invite/${token}`) };
}

/** Accept an invitation: sets the password, verifies the email and activates the account. */
export async function acceptInvite(token: string, password: string, ip: string): Promise<string> {
  await rateLimit(`accept:${ip}`, 20, 900);
  const row = await consumeToken("INVITE", token);
  const user = row.userId ? await prisma.user.findUnique({ where: { id: row.userId } }) : null;
  if (!user || user.status === "DEACTIVATED") throw badRequest("This invitation is no longer valid.");
  const problems = passwordProblems(password, [user.name, user.email.split("@")[0]!]);
  if (problems.length) throw badRequest(problems.join(" "));
  const passwordHash = await hashPassword(password);
  await prisma.$transaction(async (tx) => {
    await tx.authToken.update({ where: { id: row.id }, data: { usedAt: new Date() } });
    await tx.user.update({ where: { id: user.id }, data: { passwordHash, status: "ACTIVE", emailVerifiedAt: user.emailVerifiedAt ?? new Date() } });
    const m = row.membershipId ? await tx.membership.findUnique({ where: { id: row.membershipId } }) : null;
    await audit(tx, { apartmentId: m?.apartmentId ?? null, actorUserId: user.id, action: "account.activated", entityType: "User", entityId: user.id, membershipId: m?.id, summary: `${m?.displayName ?? user.name} activated their account` });
  });
  return user.id;
}

// ───────────── Sign-in ─────────────

const INVALID_LOGIN = "Incorrect email or password.";

export async function login(emailRaw: string, password: string, ip: string): Promise<string> {
  const email = normalizeEmail(emailRaw);
  await rateLimit(`login-ip:${ip}`, 30, 900);
  await rateLimit(`login-email:${email}`, 8, 900);
  const user = await prisma.user.findUnique({ where: { email } });
  const ok = await verifyPassword(user?.passwordHash, password);
  if (!user || !ok) throw new AppError(INVALID_LOGIN, "UNAUTHENTICATED");
  if (user.status !== "ACTIVE") throw new AppError("This account is not active. Contact the apartment administrator.", "FORBIDDEN");
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  return user.id;
}

// ───────────── Password reset ─────────────

/** Always resolves the same way whether or not the email exists (no account enumeration). */
export async function requestPasswordReset(emailRaw: string, ip: string): Promise<void> {
  const email = normalizeEmail(emailRaw);
  await rateLimit(`reset-ip:${ip}`, 10, 3600);
  await rateLimit(`reset-email:${email}`, 3, 3600);
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.status !== "ACTIVE") return;
  const { token, row } = await issueToken("PASSWORD_RESET", { email, userId: user.id }, RESET_TTL_MINUTES * 60_000);
  await queueEmail(prisma, {
    userId: user.id, toEmail: email, kind: "PASSWORD_RESET", dedupeKey: `reset:${row.id}`, preferenceType: "ACCOUNT_SECURITY",
    content: passwordResetEmail({ name: user.name, url: absoluteUrl(`/reset-password/${token}`), expiresMinutes: RESET_TTL_MINUTES }),
  });
}

export async function resetPassword(token: string, password: string, ip: string): Promise<string> {
  await rateLimit(`reset-complete:${ip}`, 20, 900);
  const row = await consumeToken("PASSWORD_RESET", token);
  const user = row.userId ? await prisma.user.findUnique({ where: { id: row.userId } }) : null;
  if (!user || user.status !== "ACTIVE") throw badRequest("This link is invalid or has expired.");
  const problems = passwordProblems(password, [user.name, user.email.split("@")[0]!]);
  if (problems.length) throw badRequest(problems.join(" "));
  const passwordHash = await hashPassword(password);
  await prisma.$transaction([
    prisma.authToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
    prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
  ]);
  await revokeAllSessions(user.id);
  await queueEmail(prisma, {
    userId: user.id, toEmail: user.email, kind: "SECURITY", dedupeKey: `pw-reset-done:${row.id}`, preferenceType: "ACCOUNT_SECURITY",
    content: securityNoticeEmail({ name: user.name, what: "Your password was reset and all devices were signed out.", url: absoluteUrl("/login") }),
  });
  return user.id;
}

export async function changePassword(ctx: Ctx, current: string, next: string): Promise<void> {
  await rateLimit(`change-pw:${ctx.userId}`, 10, 900);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.userId } });
  if (!(await verifyPassword(user.passwordHash, current))) throw badRequest("Your current password is incorrect.");
  const problems = passwordProblems(next, [user.name, user.email.split("@")[0]!]);
  if (problems.length) throw badRequest(problems.join(" "));
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(next) } });
  await revokeAllSessions(user.id, ctx.sessionId ?? undefined);
  await queueEmail(prisma, {
    userId: user.id, toEmail: user.email, kind: "SECURITY", dedupeKey: `pw-change:${user.id}:${Date.now()}`, preferenceType: "ACCOUNT_SECURITY",
    content: securityNoticeEmail({ name: user.name, what: "Your password was changed. Other devices were signed out.", url: absoluteUrl("/login") }),
  });
}

// ───────────── Email change (verified) ─────────────

export async function requestEmailChange(ctx: Ctx, newEmailRaw: string, password: string): Promise<void> {
  const newEmail = normalizeEmail(z.string().email().parse(newEmailRaw));
  await rateLimit(`email-change:${ctx.userId}`, 5, 3600);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.userId } });
  if (!(await verifyPassword(user.passwordHash, password))) throw badRequest("Your password is incorrect.");
  if (await prisma.user.findUnique({ where: { email: newEmail } })) throw conflict("That email address is already in use.");
  const { token, row } = await issueToken("EMAIL_VERIFY", { email: newEmail, userId: user.id }, VERIFY_TTL_HOURS * 3_600_000);
  await queueEmail(prisma, {
    userId: user.id, toEmail: newEmail, kind: "EMAIL_VERIFY", dedupeKey: `verify:${row.id}`,
    content: simpleEmail({ name: user.name, subject: "Confirm your new email address", lines: ["Confirm this address to use it for signing in and notifications."], url: absoluteUrl(`/verify-email/${token}`), action: "Confirm email address" }),
  });
}

export async function confirmEmailChange(token: string): Promise<void> {
  const row = await consumeToken("EMAIL_VERIFY", token);
  if (!row.userId) throw badRequest("Invalid link.");
  const user = await prisma.user.findUniqueOrThrow({ where: { id: row.userId } });
  if (await prisma.user.findFirst({ where: { email: row.email, id: { not: user.id } } })) throw conflict("That email address is already in use.");
  await prisma.$transaction([
    prisma.authToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
    prisma.user.update({ where: { id: user.id }, data: { email: row.email, emailVerifiedAt: new Date() } }),
  ]);
  await queueEmail(prisma, {
    userId: user.id, toEmail: user.email, kind: "SECURITY", dedupeKey: `email-changed:${row.id}`, preferenceType: "ACCOUNT_SECURITY",
    content: securityNoticeEmail({ name: user.name, what: `The sign-in email for your account was changed to ${row.email}.`, url: absoluteUrl("/login") }),
  });
}

// ───────────── Activation / deactivation ─────────────

export async function setAccountActive(ctx: Ctx, membershipId: string, active: boolean, reason: string): Promise<void> {
  assertAdmin(ctx);
  const m = await prisma.membership.findFirst({ where: { id: membershipId, apartmentId: ctx.apartmentId }, include: { user: true } });
  if (!m) throw notFound();
  if (m.userId === ctx.userId) throw forbidden("You can't deactivate your own account.");
  if (!active && m.role === "ADMIN") {
    const admins = await prisma.membership.count({ where: { apartmentId: ctx.apartmentId, role: "ADMIN", status: "ACTIVE", user: { status: "ACTIVE" } } });
    if (admins <= 1) throw forbidden("The apartment needs at least one active administrator.");
  }
  const status = active ? (m.user.passwordHash ? "ACTIVE" : "INVITED") : "DEACTIVATED";
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: m.userId }, data: { status } });
    await audit(tx, {
      apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: active ? "account.reactivated" : "account.deactivated", entityType: "User", entityId: m.userId,
      membershipId: m.id, summary: `${ctx.displayName} ${active ? "reactivated" : "deactivated"} ${m.displayName}'s account`, reason,
    });
  });
  if (!active) await revokeAllSessions(m.userId);
}

export const membershipUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(50),
  role: z.enum(["ADMIN", "RESIDENT"]),
  moveInDate: z.string().refine((s) => parseIsoDate(s) !== null, "Enter a valid date"),
  moveOutDate: z.string().optional().refine((s) => !s || parseIsoDate(s) !== null, "Enter a valid date"),
  billingStart: z.string().refine(isPeriod, "Use YYYY-MM"),
  billingEnd: z.string().optional().refine((s) => !s || isPeriod(s), "Use YYYY-MM"),
  notes: z.string().max(1000).optional(),
});

/** Update a membership's role and stay dates. Billing periods drive charge generation. */
export async function updateMembership(ctx: Ctx, membershipId: string, raw: z.input<typeof membershipUpdateSchema>, reason: string) {
  assertAdmin(ctx);
  const input = membershipUpdateSchema.parse(raw);
  const m = await prisma.membership.findFirst({ where: { id: membershipId, apartmentId: ctx.apartmentId } });
  if (!m) throw notFound();
  const moveOut = input.moveOutDate ? parseIsoDate(input.moveOutDate)! : null;
  const billingEnd = input.billingEnd || (moveOut ? defaultBillingEnd(moveOut) : null);
  if (billingEnd && billingEnd < input.billingStart) throw badRequest("Billing end must not be before billing start.");
  if (m.userId === ctx.userId && input.role !== "ADMIN") {
    const admins = await prisma.membership.count({ where: { apartmentId: ctx.apartmentId, role: "ADMIN", status: "ACTIVE" } });
    if (admins <= 1) throw forbidden("Assign another administrator before giving up your own admin role.");
  }
  const leftNow = moveOut !== null && moveOut.getTime() <= Date.now();
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.membership.update({
      where: { id: m.id },
      data: {
        displayName: input.displayName, role: input.role, moveInDate: parseIsoDate(input.moveInDate)!, moveOutDate: moveOut,
        billingStart: input.billingStart, billingEnd, notes: input.notes ?? m.notes, status: leftNow ? "LEFT" : "ACTIVE",
      },
    });
    await audit(tx, {
      apartmentId: ctx.apartmentId, actorUserId: ctx.userId, action: "membership.updated", entityType: "Membership", entityId: m.id, membershipId: m.id,
      summary: `${ctx.displayName} updated ${input.displayName}'s membership`, reason,
      before: { role: m.role, billingStart: m.billingStart, billingEnd: m.billingEnd, moveOutDate: m.moveOutDate, status: m.status },
      after: { role: u.role, billingStart: u.billingStart, billingEnd: u.billingEnd, moveOutDate: u.moveOutDate, status: u.status },
    });
    return u;
  });
  return updated;
}
