import { NextResponse } from "next/server";
import { prisma } from "@/server/db";

/** Liveness/readiness probe for the reverse proxy and uptime monitoring. Reveals nothing private. */
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
