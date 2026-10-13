/** Errors whose message is safe to show to the user. Anything else is reported generically. */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: "BAD_REQUEST" | "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "RATE_LIMITED" = "BAD_REQUEST",
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (m: string) => new AppError(m, "BAD_REQUEST");
export const forbidden = (m = "You do not have permission to do that.") => new AppError(m, "FORBIDDEN");
/** Used for both "missing" and "not yours" so ids of other residents' records are not confirmed. */
export const notFound = (m = "Not found.") => new AppError(m, "NOT_FOUND");
export const conflict = (m: string) => new AppError(m, "CONFLICT");
export const unauthenticated = () => new AppError("Please sign in.", "UNAUTHENTICATED");

export type ActionResult<T = undefined> = { ok: true; data?: T; message?: string } | { ok: false; error: string; fieldErrors?: Record<string, string> };

/** Convert any thrown error into an ActionResult without leaking internals. */
export function toActionError(e: unknown): { ok: false; error: string } {
  if (e instanceof AppError) return { ok: false, error: e.message };
  // Next.js redirect()/notFound() use thrown control-flow errors; never swallow them.
  if (e && typeof e === "object" && "digest" in e && typeof (e as { digest: unknown }).digest === "string" && (e as { digest: string }).digest.startsWith("NEXT_")) throw e;
  console.error("[action-error]", e instanceof Error ? `${e.name}: ${e.message}` : "unknown error");
  return { ok: false, error: "Something went wrong. Please try again." };
}
