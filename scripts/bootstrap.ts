/**
 * Runs during deployment (npm run build:deploy) after migrations.
 * Creates the default administrator from INITIAL_ADMIN_* variables if none exists yet.
 * Never prints the password; safe to run on every deploy.
 */
import "dotenv/config";
import { prisma } from "../src/server/db";
import { ensureInitialAdmin } from "../src/server/bootstrap";

async function main() {
  const result = await ensureInitialAdmin(prisma, {
    email: process.env.INITIAL_ADMIN_EMAIL,
    name: process.env.INITIAL_ADMIN_NAME,
    password: process.env.INITIAL_ADMIN_PASSWORD,
    apartmentName: process.env.INITIAL_APARTMENT_NAME,
    moveInDate: process.env.INITIAL_ADMIN_MOVE_IN,
    // Vercel limits request bodies to 4.5 MB, so uploads must stay below that.
    maxUploadBytes: process.env.VERCEL ? 4 * 1024 * 1024 : undefined,
  });
  if (result.status === "created") {
    console.log(`[bootstrap] Default administrator ${result.email} created${result.apartmentCreated ? " (with a new apartment)" : ""}.`);
  } else {
    console.log(`[bootstrap] Skipped: ${result.reason}.`);
  }
}

main()
  .catch((e) => {
    console.error(`[bootstrap] ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
