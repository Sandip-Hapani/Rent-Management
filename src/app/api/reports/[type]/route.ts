import { NextResponse, type NextRequest } from "next/server";
import { getCtx } from "@/server/auth/context";
import { AppError } from "@/server/errors";
import { buildReport, REPORT_TYPES, type ReportType } from "@/server/reports/service";
import { toCsv, toXlsx } from "@/server/reports/export";
import { isPeriod } from "@/server/finance/period";

export async function GET(req: NextRequest, { params }: { params: Promise<{ type: string }> }) {
  const ctx = await getCtx();
  if (!ctx) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!ctx.isAdmin) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { type } = await params;
  if (!(REPORT_TYPES as readonly string[]).includes(type)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const sp = req.nextUrl.searchParams;
  try {
    const table = await buildReport(ctx, type as ReportType, {
      from: isPeriod(sp.get("from")) ? sp.get("from")! : undefined,
      to: isPeriod(sp.get("to")) ? sp.get("to")! : undefined,
      membershipId: sp.get("member") || undefined,
    });
    const name = `${type}-${new Date().toISOString().slice(0, 10)}`;
    const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
    if (sp.get("format") === "xlsx") {
      return new NextResponse(new Uint8Array(await toXlsx([table])), { headers: { ...headers, "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${name}.xlsx"` } });
    }
    return new NextResponse(toCsv([table]), { headers: { ...headers, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}.csv"` } });
  } catch (e) {
    if (e instanceof AppError) return NextResponse.json({ error: e.message }, { status: e.code === "NOT_FOUND" ? 404 : 400 });
    throw e;
  }
}
