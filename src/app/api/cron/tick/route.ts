import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/server/env";
import { safeEqual } from "@/server/auth/crypto";
import { tick } from "@/server/jobs";

/**
 * External-scheduler entry point (for hosts without a long-running worker).
 * Authenticate with `Authorization: Bearer $CRON_SECRET`. Idempotent: safe to call often.
 */
export async function POST(req: NextRequest) {
  const secret = env().CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const result = await tick();
  return NextResponse.json({ ok: true, ...result });
}
