import "server-only";
import { notFound } from "next/navigation";
import { AppError } from "@/server/errors";

/** Turn NOT_FOUND / FORBIDDEN service errors into a 404 page (no information leak). */
export async function orNotFound<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "FORBIDDEN")) notFound();
    throw e;
  }
}
