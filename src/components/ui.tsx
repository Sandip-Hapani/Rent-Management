import Link from "next/link";
import clsx from "clsx";
import type { ComponentProps, ReactNode } from "react";
import { ResponsiveTable } from "./responsive-table";

export { clsx as cx };

type Variant = "primary" | "secondary" | "ghost" | "danger";
const buttonBase = "inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap";
const buttonVariants: Record<Variant, string> = {
  primary: "bg-accent text-white hover:bg-accent-strong",
  secondary: "border border-line bg-surface text-ink hover:bg-canvas",
  ghost: "text-muted hover:bg-canvas hover:text-ink",
  danger: "bg-bad text-white hover:bg-red-800",
};

export function buttonClass(variant: Variant = "primary", className?: string) {
  return clsx(buttonBase, buttonVariants[variant], className);
}

export function Button({ variant = "primary", className, ...props }: ComponentProps<"button"> & { variant?: Variant }) {
  return <button className={buttonClass(variant, className)} {...props} />;
}

export function ButtonLink({ variant = "primary", className, ...props }: ComponentProps<typeof Link> & { variant?: Variant }) {
  return <Link className={buttonClass(variant, className)} {...props} />;
}

export function Card({ className, ...props }: ComponentProps<"section">) {
  return <section className={clsx("rounded-xl border border-line bg-surface", className)} {...props} />;
}

export function CardHeader({ title, description, action }: { title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
      <div>
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

type Tone = "neutral" | "good" | "warn" | "bad" | "info" | "accent";
const toneClasses: Record<Tone, string> = {
  neutral: "bg-canvas text-muted border-line",
  good: "bg-good-soft text-good border-green-200",
  warn: "bg-warn-soft text-warn border-amber-200",
  bad: "bg-bad-soft text-bad border-red-200",
  info: "bg-info-soft text-info border-blue-200",
  accent: "bg-accent-soft text-accent border-teal-200",
};

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={clsx("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap", toneClasses[tone], className)}>{children}</span>;
}

const STATUS: Record<string, { label: string; tone: Tone }> = {
  // payments
  DRAFT: { label: "Draft", tone: "neutral" },
  SUBMITTED: { label: "Submitted", tone: "info" },
  UNDER_REVIEW: { label: "Under review", tone: "info" },
  CLARIFICATION_REQUESTED: { label: "Clarification requested", tone: "warn" },
  VERIFIED: { label: "Verified", tone: "good" },
  REJECTED: { label: "Rejected", tone: "bad" },
  REVERSED: { label: "Reversed", tone: "neutral" },
  // member-period
  PAID: { label: "Paid", tone: "good" },
  PENDING: { label: "Pending verification", tone: "info" },
  OVERDUE: { label: "Overdue", tone: "bad" },
  PARTIAL: { label: "Partly paid", tone: "warn" },
  DUE: { label: "Due", tone: "neutral" },
  NO_CHARGES: { label: "No charges", tone: "neutral" },
  // misc
  FINAL: { label: "Final", tone: "good" },
  VOID: { label: "Void", tone: "neutral" },
  OPEN: { label: "Open", tone: "neutral" },
  GENERATED: { label: "Draft generated", tone: "warn" },
  FINALIZED: { label: "Finalised", tone: "good" },
  PUBLISHED: { label: "Published", tone: "good" },
  SUPERSEDED: { label: "Superseded", tone: "neutral" },
  ARCHIVED: { label: "Archived", tone: "neutral" },
  ACTIVE: { label: "Active", tone: "good" },
  INVITED: { label: "Invited", tone: "info" },
  DEACTIVATED: { label: "Deactivated", tone: "bad" },
  LEFT: { label: "Moved out", tone: "neutral" },
  RECONCILED: { label: "Reconciled", tone: "good" },
  UNRECONCILED: { label: "Not reconciled", tone: "warn" },
  SENT: { label: "Sent", tone: "good" },
  FAILED: { label: "Failed", tone: "bad" },
  SKIPPED: { label: "Skipped", tone: "neutral" },
  QUEUED: { label: "Queued", tone: "info" },
  READY: { label: "Ready", tone: "good" },
  NEEDS_REVIEW: { label: "Needs review", tone: "warn" },
  IMPORTED: { label: "Imported", tone: "good" },
  STAGED: { label: "Staged", tone: "info" },
  COMMITTED: { label: "Committed", tone: "good" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, tone: "neutral" as Tone };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function Stat({ label, value, hint, tone = "neutral", href }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "neutral" | "good" | "warn" | "bad"; href?: string }) {
  const body = (
    <>
      <div className="text-xs font-medium tracking-wide text-muted uppercase">{label}</div>
      <div className={clsx("num mt-1.5 text-2xl font-semibold tracking-tight", tone === "good" && "text-good", tone === "warn" && "text-warn", tone === "bad" && "text-bad")}>{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </>
  );
  const cls = "block rounded-xl border border-line bg-surface p-4";
  return href ? <Link href={href} className={clsx(cls, "hover:border-accent/40")}>{body}</Link> : <div className={cls}>{body}</div>;
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1 max-w-md text-sm text-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Table that turns into stacked label/value cards on phones (see ResponsiveTable). */
export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <ResponsiveTable className={className}>
      <table className="w-full border-collapse text-sm">{children}</table>
    </ResponsiveTable>
  );
}

export function Th({ children, align = "left", className }: { children?: ReactNode; align?: "left" | "right" | "center"; className?: string }) {
  return <th scope="col" className={clsx("border-b border-line bg-canvas/60 px-4 py-2.5 text-xs font-medium text-muted whitespace-nowrap", align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left", className)}>{children}</th>;
}

/**
 * Table cell. Cells never wrap by default (dates, amounts, names stay on one line); pass `wrap`
 * for free text such as reasons and descriptions, which then wraps within a readable width.
 */
export function Td({ children, align = "left", className, colSpan, wrap, label }: { children?: ReactNode; align?: "left" | "right" | "center"; className?: string; colSpan?: number; wrap?: boolean; label?: string }) {
  return (
    <td
      colSpan={colSpan}
      data-label={label}
      className={clsx(
        "border-b border-line px-4 py-2.5 align-top",
        wrap ? "min-w-48 max-w-sm whitespace-normal" : "whitespace-nowrap",
        align === "right" ? "num text-right" : align === "center" ? "text-center" : "",
        className,
      )}
    >
      {children}
    </td>
  );
}

export function Alert({ tone = "info", title, children }: { tone?: "info" | "warn" | "bad" | "good"; title?: ReactNode; children?: ReactNode }) {
  const cls = { info: "border-blue-200 bg-info-soft text-blue-900", warn: "border-amber-200 bg-warn-soft text-amber-900", bad: "border-red-200 bg-bad-soft text-red-900", good: "border-green-200 bg-good-soft text-green-900" }[tone];
  return (
    <div role={tone === "bad" ? "alert" : "status"} className={clsx("rounded-lg border px-4 py-3 text-sm", cls)}>
      {title && <p className="font-medium">{title}</p>}
      {children && <div className={clsx(title && "mt-0.5")}>{children}</div>}
    </div>
  );
}

export const inputClass = "block w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm placeholder:text-muted/70 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:bg-canvas";

export function Field({ label, hint, error, children, htmlFor, className }: { label: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; htmlFor?: string; className?: string }) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium">{label}</label>
      {children}
      {hint && !error && <p className="mt-1 text-xs text-muted">{hint}</p>}
      {error && <p className="mt-1 text-xs text-bad">{error}</p>}
    </div>
  );
}

export function Input(props: ComponentProps<"input">) {
  return <input {...props} className={clsx(inputClass, props.className)} />;
}

export function Select(props: ComponentProps<"select">) {
  return <select {...props} className={clsx(inputClass, "pr-8", props.className)} />;
}

export function Textarea(props: ComponentProps<"textarea">) {
  return <textarea rows={3} {...props} className={clsx(inputClass, props.className)} />;
}

/** Tabs wrap as pills on phones and become an underlined tab bar from the sm breakpoint. */
export const TAB_BASE = "rounded-full border px-3 py-1.5 text-sm whitespace-nowrap sm:-mb-px sm:rounded-none sm:border-0 sm:border-b-2 sm:px-3 sm:py-2";
export const TAB_ACTIVE = "border-accent bg-accent-soft font-medium text-accent-strong sm:bg-transparent sm:text-ink";
export const TAB_IDLE = "border-line bg-surface text-muted hover:text-ink sm:border-transparent sm:bg-transparent";

export function Tabs({ items, active }: { items: { href: string; label: ReactNode; key: string; count?: number }[]; active: string }) {
  return (
    <nav className="mb-5 flex flex-wrap gap-1.5 sm:flex-nowrap sm:gap-1 sm:overflow-x-auto sm:border-b sm:border-line" aria-label="Sections">
      {items.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === active ? "page" : undefined}
          className={clsx(TAB_BASE, t.key === active ? TAB_ACTIVE : TAB_IDLE)}
        >
          {t.label}
          {t.count ? <span className="ml-1.5 rounded-full bg-accent px-1.5 text-xs text-white">{t.count}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

export function DL({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
      {items.map(([k, v], i) => (
        <div key={i}>
          <dt className="text-muted">{k}</dt>
          <dd className="mt-0.5 font-medium">{v ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}
