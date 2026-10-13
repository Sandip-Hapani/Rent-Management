import "server-only";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { badRequest, toActionError, type ActionResult } from "@/server/errors";
import { parseEuroToCents } from "@/server/finance/money";

/** Run a server-action body, converting thrown errors into a safe ActionResult. */
export async function run<T>(fn: () => Promise<T | ActionResult<T> | void>, opts: { message?: string; revalidate?: string | string[] } = {}): Promise<ActionResult<unknown>> {
  try {
    const out = await fn();
    for (const p of [opts.revalidate ?? "/"].flat()) revalidatePath(p, "layout");
    if (out && typeof out === "object" && "ok" in out) return out as ActionResult<unknown>;
    return { ok: true, message: opts.message, data: out ?? undefined };
  } catch (e) {
    if (e instanceof ZodError) {
      const first = e.issues[0];
      return { ok: false, error: first ? `${first.path.join(".") ? `${first.path.join(".")}: ` : ""}${first.message}` : "Invalid input." };
    }
    return toActionError(e);
  }
}

export async function clientIp(): Promise<string> {
  const h = await headers();
  // Prefer the address set by our reverse proxy (Caddy sets X-Real-IP); the last X-Forwarded-For hop
  // is the one our proxy appended. The first XFF entry is client-controlled and never trusted.
  const xff = h.get("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean);
  return (h.get("x-real-ip") ?? xff?.at(-1) ?? "local").slice(0, 64);
}

export const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v.trim() : "";
};
export const optStr = (fd: FormData, k: string) => str(fd, k) || undefined;
export const bool = (fd: FormData, k: string) => fd.get(k) === "on" || fd.get(k) === "true";
export const int = (fd: FormData, k: string) => {
  const n = Number(str(fd, k));
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
};

/** Euro text → cents, throwing a readable error. */
export function money(fd: FormData, k: string, label = "Amount"): number {
  const c = parseEuroToCents(str(fd, k));
  if (c === null) throw badRequest(`${label} must be a valid euro amount.`);
  return c;
}

export function moneyOrNull(fd: FormData, k: string): number | null {
  const s = str(fd, k);
  return s ? parseEuroToCents(s) : null;
}

export function intList(fd: FormData, k: string): number[] {
  return str(fd, k).split(/[,\s]+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n));
}

export function file(fd: FormData, k: string): File | null {
  const f = fd.get(k);
  return f instanceof File && f.size > 0 ? f : null;
}
