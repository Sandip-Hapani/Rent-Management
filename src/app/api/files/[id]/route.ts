import { NextResponse, type NextRequest } from "next/server";
import { getCtx } from "@/server/auth/context";
import { AppError } from "@/server/errors";
import { authorizeFileAccess } from "@/server/storage/access";
import { storage } from "@/server/storage";

/**
 * Authenticated, authorised file download. Files are never served from a public URL.
 * ?inline=1 previews PDFs/images in the browser; everything else downloads.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getCtx();
  if (!ctx) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  const { id } = await params;
  try {
    const file = await authorizeFileAccess(ctx, id);
    const { stream, size } = await storage().get(file.storageKey);
    const inline = req.nextUrl.searchParams.get("inline") === "1" && (file.mimeType === "application/pdf" || file.mimeType.startsWith("image/"));
    const encoded = encodeURIComponent(file.originalName);
    const ascii = file.originalName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    return new NextResponse(stream, {
      headers: {
        "Content-Type": file.mimeType,
        ...(size ? { "Content-Length": String(size) } : {}),
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encoded}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        // Even if a file were mis-detected, it can't run scripts in our origin.
        "Content-Security-Policy": file.mimeType === "application/pdf" ? "default-src 'none'; object-src 'self'; frame-ancestors 'self'" : "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'",
      },
    });
  } catch (e) {
    if (e instanceof AppError) return NextResponse.json({ error: "Not found" }, { status: 404 });
    console.error("[files] download failed", id, e instanceof Error ? e.message : "");
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
