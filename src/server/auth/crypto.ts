import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

// OWASP-recommended Argon2id parameters (19 MiB, 2 iterations, 1 lane).
const ARGON2 = { memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;

export const PASSWORD_MIN_LENGTH = 10;

export function passwordProblems(password: string, context: string[] = []): string[] {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) problems.push(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);
  if (password.length > 200) problems.push("Use at most 200 characters.");
  const lower = password.toLowerCase();
  if (context.some((c) => c && c.length >= 3 && lower.includes(c.toLowerCase()))) problems.push("Don't include your name or email.");
  if (/^(.)\1+$/.test(password)) problems.push("Avoid repeating a single character.");
  return problems;
}

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2);
}

export async function verifyPassword(hashed: string | null | undefined, password: string): Promise<boolean> {
  if (!hashed) {
    // Spend comparable time to avoid user-enumeration by timing.
    await hash(password, ARGON2);
    return false;
  }
  try {
    return await verify(hashed, password);
  } catch {
    return false;
  }
}

/** URL-safe random token (256 bits). */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
