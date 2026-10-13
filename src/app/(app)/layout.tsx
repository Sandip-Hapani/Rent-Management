import { requirePageCtx } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { unreadCount } from "@/server/notifications/queries";
import { AppNav } from "@/components/nav";
import { logoutAction } from "@/app/actions/auth";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requirePageCtx();
  const [unread, openReviews] = await Promise.all([
    unreadCount(ctx),
    ctx.isAdmin ? prisma.payment.count({ where: { apartmentId: ctx.apartmentId, status: { in: ["SUBMITTED", "UNDER_REVIEW"] } } }) : Promise.resolve(0),
  ]);
  return (
    <div className="min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2">Skip to content</a>
      <AppNav
        isAdmin={ctx.isAdmin}
        unread={unread}
        openReviews={openReviews}
        apartmentName={ctx.apartmentName}
        displayName={ctx.displayName}
        roleLabel={ctx.isAdmin ? "Administrator" : ctx.membershipActive ? "Resident" : "Former resident"}
        logout={
          <form action={logoutAction}>
            <button type="submit" className="w-full rounded-lg px-3 py-2 text-left text-sm text-muted hover:bg-canvas hover:text-ink">Sign out</button>
          </form>
        }
      />
      <main id="main" className="px-4 py-6 sm:px-6 lg:ml-64 lg:px-10 lg:py-8">
        <div className="mx-auto max-w-6xl">
          {!ctx.membershipActive && (
            <p className="mb-4 rounded-lg border border-line bg-surface px-4 py-2 text-sm text-muted">Your stay has ended. You can still view and download your records.</p>
          )}
          {children}
        </div>
      </main>
    </div>
  );
}
