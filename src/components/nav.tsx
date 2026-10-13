"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Bell, ChartColumn, FileText, LayoutDashboard, Menu, Receipt, Settings, UserRound, X } from "lucide-react";
import { cx } from "./ui";

export interface NavProps {
  isAdmin: boolean;
  unread: number;
  openReviews: number;
  apartmentName: string;
  displayName: string;
  roleLabel: string;
  logout: React.ReactNode;
}

const ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/account", label: "My Account", icon: UserRound },
  { href: "/payments", label: "Payments", icon: Receipt },
  { href: "/documents", label: "Documents", icon: FileText },
  { href: "/notifications", label: "Notifications", icon: Bell },
  { href: "/reports", label: "Reports", icon: ChartColumn, admin: true },
  { href: "/settings", label: "Apartment Settings", icon: Settings, admin: true },
];

function NavLinks({ isAdmin, unread, openReviews, onNavigate }: Pick<NavProps, "isAdmin" | "unread" | "openReviews"> & { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <ul className="space-y-0.5">
      {ITEMS.filter((i) => !i.admin || isAdmin).map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        const Icon = item.icon;
        const count = item.href === "/notifications" ? unread : item.href === "/payments" && isAdmin ? openReviews : 0;
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cx("flex items-center gap-3 rounded-lg px-3 py-2 text-sm", active ? "bg-accent-soft font-medium text-accent-strong" : "text-muted hover:bg-canvas hover:text-ink")}
            >
              <Icon aria-hidden className="size-4 shrink-0" />
              <span className="flex-1">{item.label}</span>
              {count > 0 && (
                <span className="rounded-full bg-accent px-1.5 py-0.5 text-[11px] leading-none font-semibold text-white" aria-label={`${count} ${item.href === "/payments" ? "to review" : "unread"}`}>
                  {count > 99 ? "99+" : count}
                </span>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function Brand({ apartmentName }: { apartmentName: string }) {
  return (
    <Link href="/dashboard" className="flex items-center gap-2.5 px-2">
      <span aria-hidden className="grid size-8 place-items-center rounded-lg bg-accent text-xs font-bold text-white">AR</span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold">{apartmentName}</span>
        <span className="block text-xs text-muted">Rent &amp; documents</span>
      </span>
    </Link>
  );
}

function UserBox({ displayName, roleLabel, logout }: Pick<NavProps, "displayName" | "roleLabel" | "logout">) {
  return (
    <div className="border-t border-line pt-3">
      <Link href="/account/settings" className="block rounded-lg px-3 py-2 hover:bg-canvas">
        <span className="block text-sm font-medium">{displayName}</span>
        <span className="block text-xs text-muted">{roleLabel} · Profile &amp; security</span>
      </Link>
      {logout}
    </div>
  );
}

export function AppNav(props: NavProps) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => setOpen(false), [pathname]);
  return (
    <>
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col gap-6 border-r border-line bg-surface px-3 py-5 lg:flex no-print">
        <Brand apartmentName={props.apartmentName} />
        <nav aria-label="Main" className="flex-1"><NavLinks {...props} /></nav>
        <UserBox {...props} />
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-surface/95 px-4 py-3 backdrop-blur lg:hidden no-print">
        <Brand apartmentName={props.apartmentName} />
        <button type="button" onClick={() => setOpen(true)} className="relative rounded-lg p-2 hover:bg-canvas" aria-label="Open menu" aria-expanded={open}>
          <Menu className="size-5" />
          {props.unread > 0 && <span className="absolute top-1 right-1 size-2 rounded-full bg-accent" />}
        </button>
      </header>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-black/30" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 right-0 flex w-72 max-w-[85vw] flex-col gap-6 bg-surface px-3 py-5 shadow-xl">
            <div className="flex items-center justify-between px-2">
              <span className="text-sm font-semibold">Menu</span>
              <button type="button" onClick={() => setOpen(false)} className="rounded-lg p-2 hover:bg-canvas" aria-label="Close menu"><X className="size-5" /></button>
            </div>
            <nav aria-label="Main" className="flex-1"><NavLinks {...props} onNavigate={() => setOpen(false)} /></nav>
            <UserBox {...props} />
          </div>
        </div>
      )}
    </>
  );
}
