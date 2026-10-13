import { prisma } from "../db";
import { AppError } from "../errors";

/**
 * Fixed-window rate limiter backed by Postgres (works across app and worker instances).
 * Throws RATE_LIMITED once more than `limit` hits happen in the current window.
 */
export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<void> {
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / (windowSeconds * 1000)) * windowSeconds * 1000);
  const bucket = await prisma.rateLimitBucket.upsert({
    where: { key_windowStart: { key, windowStart } },
    create: { key, windowStart, count: 1 },
    update: { count: { increment: 1 } },
  });
  if (bucket.count > limit) {
    throw new AppError("Too many attempts. Please wait a few minutes and try again.", "RATE_LIMITED");
  }
}

export async function pruneRateLimits(olderThanHours = 24): Promise<void> {
  await prisma.rateLimitBucket.deleteMany({ where: { windowStart: { lt: new Date(Date.now() - olderThanHours * 3_600_000) } } });
}
