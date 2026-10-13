import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic redirect for signed-out visitors. The real session check happens server-side in
 * every page, action and route handler — this only avoids rendering private pages needlessly.
 */
const PUBLIC = [/^\/login/, /^\/forgot-password/, /^\/reset-password\//, /^\/invite\//, /^\/verify-email\//, /^\/api\/cron\//, /^\/api\/health/];

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (PUBLIC.some((re) => re.test(pathname))) return NextResponse.next();
  const hasSession = request.cookies.has("__Host-rent_session") || request.cookies.has("rent_session");
  if (!hasSession) {
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
    const url = new URL("/login", request.url);
    if (pathname !== "/") url.searchParams.set("next", pathname + search);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
