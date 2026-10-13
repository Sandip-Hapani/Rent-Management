/** Formatting helpers safe to use in client and server components. */
import { formatCents, centsToDecimalString } from "@/server/finance/money";
import { formatDate, formatPeriod, isoDate } from "@/server/finance/period";
import { CATEGORY_LABELS, type Category } from "@/server/finance/types";

export { formatCents as eur, centsToDecimalString, formatDate, formatPeriod, isoDate };

export const categoryLabel = (c: string) => CATEGORY_LABELS[c as Category] ?? c;

export function formatDateTime(d: Date): string {
  return new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(d);
}

export function relativeTime(d: Date, now = new Date()): string {
  const s = Math.round((now.getTime() - d.getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)} d ago`;
  return formatDateTime(d).slice(0, 10);
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
