import { NextResponse, type NextRequest } from "next/server";
import { getCtx } from "@/server/auth/context";
import { AppError } from "@/server/errors";
import { buildStatement } from "@/server/reports/service";
import { toCsv, toXlsx } from "@/server/reports/export";
import { isPeriod } from "@/server/finance/period";

/** Resident statement export. Residents can only export their own; admins any in their apartment. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ membershipId: string }> }) {
  const ctx = await getCtx();
  if (!ctx) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  const { membershipId } = await params;
  const sp = req.nextUrl.searchParams;
  try {
    const st = await buildStatement(ctx, membershipId, { from: isPeriod(sp.get("from")) ? sp.get("from")! : undefined, to: isPeriod(sp.get("to")) ? sp.get("to")! : undefined });
    const safeName = st.membership.displayName.replace(/[^\p{L}\p{N}_-]/gu, "_");
    const name = `statement-${safeName}-${st.from}-to-${st.to}`;
    const summary = {
      title: "Summary",
      columns: [{ key: "k", label: "Item" }, { key: "v", label: "Amount", type: "money" as const }],
      rows: [
        { k: "Total outstanding (to date)", v: Math.max(0, st.summary.totalOutstanding) },
        { k: "Verified payments (all time)", v: st.summary.totalVerifiedPayments },
        { k: "Unallocated credit", v: st.summary.unallocatedCredit },
        { k: "Deposit held", v: st.summary.depositHeld },
        { k: "Pending verification", v: st.summary.pendingSubmissionCents },
      ],
    };
    const tables = [summary, ...st.tables];
    const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
    if (sp.get("format") === "xlsx") {
      return new NextResponse(new Uint8Array(await toXlsx(tables)), { headers: { ...headers, "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${name}.xlsx"` } });
    }
    return new NextResponse(toCsv(tables), { headers: { ...headers, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}.csv"` } });
  } catch (e) {
    if (e instanceof AppError) return NextResponse.json({ error: "Not found" }, { status: 404 });
    throw e;
  }
}
