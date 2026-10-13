"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "./ui";

const ITEMS = [
  { href: "/settings", label: "General" },
  { href: "/settings/residents", label: "Residents" },
  { href: "/settings/pricing", label: "Prices & rules" },
  { href: "/settings/periods", label: "Monthly obligations" },
  { href: "/settings/reminders", label: "Reminders & email" },
  { href: "/settings/import", label: "Historical import" },
  { href: "/settings/audit", label: "Audit log" },
];

// Same look as the shared Tabs, but this menu has seven items, so it keeps pills until `xl`.
// (Written out literally so Tailwind generates the classes.)
const BASE = "rounded-full border px-3 py-1.5 text-sm whitespace-nowrap xl:-mb-px xl:rounded-none xl:border-0 xl:border-b-2 xl:px-3 xl:py-2";
const ACTIVE = "border-accent bg-accent-soft font-medium text-accent-strong xl:bg-transparent xl:text-ink";
const IDLE = "border-line bg-surface text-muted hover:text-ink xl:border-transparent xl:bg-transparent";

export function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings" className="mb-6 flex flex-wrap gap-1.5 xl:flex-nowrap xl:gap-1 xl:border-b xl:border-line">
      {ITEMS.map((i) => {
        const active = i.href === "/settings" ? pathname === "/settings" : pathname.startsWith(i.href);
        return (
          <Link key={i.href} href={i.href} aria-current={active ? "page" : undefined} className={cx(BASE, active ? ACTIVE : IDLE)}>
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
