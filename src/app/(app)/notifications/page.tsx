import Link from "next/link";
import { requirePageCtx } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { listNotifications, NOTIFICATION_TYPE_LABELS } from "@/server/notifications/queries";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, CardHeader, EmptyState, Field, Input, PageHeader, Table, Tabs, Td, Textarea, Th, cx } from "@/components/ui";
import { categoryLabel, eur, formatDateTime, formatPeriod, relativeTime } from "@/lib/format";
import { announcementAction, markReadAction } from "@/app/actions/misc";

export const metadata = { title: "Notifications" };

export default async function NotificationsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const ctx = await requirePageCtx();
  const { tab = "inbox" } = await searchParams;
  const [items, announcements, priceChanges] = await Promise.all([
    listNotifications(ctx),
    prisma.announcement.findMany({ where: { apartmentId: ctx.apartmentId }, orderBy: { publishedAt: "desc" }, take: 50 }),
    prisma.priceChange.findMany({ where: { apartmentId: ctx.apartmentId }, orderBy: { publishedAt: "desc" } }),
  ]);
  const unread = items.filter((n) => !n.readAt).length;

  return (
    <>
      <PageHeader title="Notifications" description="Everything you were emailed about is also kept here." />
      <Tabs
        active={tab}
        items={[
          { key: "inbox", label: "Inbox", href: "/notifications", count: unread },
          { key: "announcements", label: "Announcements", href: "/notifications?tab=announcements" },
          { key: "prices", label: "Price changes", href: "/notifications?tab=prices" },
        ]}
      />

      {tab === "inbox" && (
        <Card>
          <CardHeader
            title={unread ? `${unread} unread` : "All caught up"}
            action={unread > 0 && <ActionForm action={markReadAction}><SubmitButton variant="secondary">Mark all as read</SubmitButton></ActionForm>}
          />
          {items.length === 0 ? (
            <EmptyState title="No notifications yet" />
          ) : (
            <ul className="divide-y divide-line">
              {items.map((n) => (
                <li key={n.id} className={cx("flex items-start gap-3 px-5 py-3", !n.readAt && "bg-accent-soft/40")}>
                  <span aria-hidden className={cx("mt-1.5 size-2 shrink-0 rounded-full", n.readAt ? "bg-transparent" : "bg-accent")} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{n.link ? <Link href={n.link} className="hover:underline">{n.title}</Link> : n.title}</p>
                    <p className="text-sm whitespace-pre-line text-muted">{n.body}</p>
                    <p className="mt-0.5 text-xs text-muted">{NOTIFICATION_TYPE_LABELS[n.type]} · <time dateTime={n.createdAt.toISOString()}>{relativeTime(n.createdAt)}</time>{!n.readAt && <span className="sr-only"> · unread</span>}</p>
                  </div>
                  {!n.readAt && (
                    <ActionForm action={markReadAction} className="!space-y-0">
                      <input type="hidden" name="id" value={n.id} />
                      <SubmitButton variant="ghost" pendingText="…">Mark read</SubmitButton>
                    </ActionForm>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {tab === "announcements" && (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader title="Apartment announcements" />
            {announcements.length === 0 ? (
              <EmptyState title="No announcements yet" />
            ) : (
              <ul className="divide-y divide-line">
                {announcements.map((a) => (
                  <li key={a.id} className="px-5 py-4">
                    <p className="font-medium">{a.title}</p>
                    <p className="mt-1 text-sm whitespace-pre-line text-muted">{a.body}</p>
                    <p className="mt-1 text-xs text-muted">{formatDateTime(a.publishedAt)}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {ctx.isAdmin && (
            <Card>
              <CardHeader title="New announcement" description="All residents are notified by email and in the app." />
              <div className="p-5">
                <ActionForm action={announcementAction} resetOnSuccess>
                  <Field label="Title" htmlFor="title"><Input id="title" name="title" required maxLength={150} /></Field>
                  <Field label="Message" htmlFor="body"><Textarea id="body" name="body" rows={6} required maxLength={5000} /></Field>
                  <SubmitButton>Publish</SubmitButton>
                </ActionForm>
              </div>
            </Card>
          )}
        </div>
      )}

      {tab === "prices" && (
        <Card>
          <CardHeader title="Published price changes" description="Permanent history. Earlier months always keep the amounts that applied then." />
          {priceChanges.length === 0 ? (
            <EmptyState title="No price changes yet" />
          ) : (
            <Table>
              <thead><tr><Th>Published</Th><Th>Category</Th><Th>Effective from</Th><Th>Reason</Th><Th>Change per resident</Th></tr></thead>
              <tbody>
                {priceChanges.map((pc) => {
                  const rows = (pc.summary as { membershipId: string; displayName: string; previousCents: number; newCents: number }[]).filter((r) => ctx.isAdmin || r.membershipId === ctx.membershipId);
                  return (
                    <tr key={pc.id}>
                      <Td className="whitespace-nowrap">{formatDateTime(pc.publishedAt)}</Td>
                      <Td>{categoryLabel(pc.category)}</Td>
                      <Td>{formatPeriod(pc.effectiveFrom)}</Td>
                      <Td wrap>{pc.reason}</Td>
                      <Td className="num text-sm">
                        {rows.length === 0 ? "—" : rows.map((r) => <span key={r.membershipId} className="block sm:whitespace-nowrap">{ctx.isAdmin && `${r.displayName}: `}{eur(r.previousCents)} → {eur(r.newCents)}</span>)}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>
      )}
    </>
  );
}
