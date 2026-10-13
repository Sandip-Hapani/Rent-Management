/**
 * Bootstrap the first administrator.
 *
 *   npm run create-admin -- --email you@example.com --name "Your Name" [--display You] [--apartment "Flat name"] [--move-in 2024-06-01]
 *
 * Creates the apartment (if none exists), an invited admin account and prints a one-time
 * invitation link (also emailed if SMTP is configured). No password is ever passed on the command line.
 */
import "dotenv/config";
import { parseArgs } from "node:util";
import { prisma } from "../src/server/db";
import { normalizeEmail, randomToken, sha256 } from "../src/server/auth/crypto";
import { defaultBillingStart, parseIsoDate } from "../src/server/finance/period";
import { queueEmail, processOutbox } from "../src/server/notifications/email";
import { inviteEmail } from "../src/server/notifications/templates";
import { env } from "../src/server/env";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    name: { type: "string" },
    display: { type: "string" },
    apartment: { type: "string" },
    "move-in": { type: "string" },
  },
});

async function main() {
  if (!values.email || !values.name) {
    console.error('Usage: npm run create-admin -- --email you@example.com --name "Your Name" [--display Short] [--apartment "Flat"] [--move-in YYYY-MM-DD]');
    process.exit(1);
  }
  const email = normalizeEmail(values.email);
  const moveIn = parseIsoDate(values["move-in"] ?? new Date().toISOString().slice(0, 10));
  if (!moveIn) throw new Error("--move-in must be YYYY-MM-DD");

  let apartment = await prisma.apartment.findFirst();
  if (!apartment) {
    apartment = await prisma.apartment.create({ data: { name: values.apartment ?? "Our apartment" } });
    await prisma.reminderSchedule.create({ data: { apartmentId: apartment.id } });
    console.log(`Created apartment "${apartment.name}".`);
  }

  let user = await prisma.user.findUnique({ where: { email } });
  if (user?.status === "ACTIVE") {
    const m = await prisma.membership.findFirst({ where: { userId: user.id, apartmentId: apartment.id } });
    if (m) {
      await prisma.membership.update({ where: { id: m.id }, data: { role: "ADMIN" } });
      console.log(`${email} already has an active account; it now has the administrator role.`);
      return;
    }
  }
  user ??= await prisma.user.create({ data: { email, name: values.name, status: "INVITED" } });
  let membership = await prisma.membership.findFirst({ where: { userId: user.id, apartmentId: apartment.id } });
  membership ??= await prisma.membership.create({
    data: { apartmentId: apartment.id, userId: user.id, role: "ADMIN", displayName: values.display ?? values.name.split(" ")[0]!, moveInDate: moveIn, billingStart: defaultBillingStart(moveIn) },
  });
  if (membership.role !== "ADMIN") membership = await prisma.membership.update({ where: { id: membership.id }, data: { role: "ADMIN" } });

  const token = randomToken();
  await prisma.authToken.updateMany({ where: { email, type: "INVITE", usedAt: null }, data: { usedAt: new Date() } });
  const row = await prisma.authToken.create({ data: { type: "INVITE", tokenHash: sha256(token), email, userId: user.id, membershipId: membership.id, expiresAt: new Date(Date.now() + 72 * 3_600_000) } });
  const url = `${env().APP_URL}/invite/${token}`;
  await prisma.auditEvent.create({ data: { apartmentId: apartment.id, action: "admin.bootstrapped", entityType: "Membership", entityId: membership.id, membershipId: membership.id, summary: `Administrator account created for ${membership.displayName} via CLI` } });
  await queueEmail(prisma, { apartmentId: apartment.id, userId: user.id, toEmail: email, kind: "INVITE", dedupeKey: `invite:${row.id}`, content: inviteEmail({ name: user.name, apartmentName: apartment.name, invitedBy: "The setup script", url, expiresHours: 72 }) });
  const r = await processOutbox({ limit: 5 });

  console.log(`\nAdministrator invitation for ${email} (valid 72 hours):\n\n  ${url}\n`);
  console.log(r.sent ? "The link was also emailed." : "Email not sent (check SMTP settings) — open the link above directly.");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
