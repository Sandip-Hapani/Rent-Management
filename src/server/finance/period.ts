/**
 * Billing periods are calendar months encoded as 'YYYY-MM'.
 * Calendar dates are represented as Date objects at UTC midnight (matching Prisma @db.Date)
 * and are interpreted in the apartment's time zone.
 */

export type Period = string;

const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

export function isPeriod(value: unknown): value is Period {
  return typeof value === "string" && PERIOD_RE.test(value);
}

export function assertPeriod(value: string): Period {
  if (!isPeriod(value)) throw new Error(`Invalid period '${value}', expected YYYY-MM`);
  return value;
}

export function makePeriod(year: number, month1to12: number): Period {
  return `${String(year).padStart(4, "0")}-${String(month1to12).padStart(2, "0")}`;
}

export function parsePeriod(p: Period): { year: number; month: number } {
  const m = PERIOD_RE.exec(p);
  if (!m) throw new Error(`Invalid period '${p}'`);
  return { year: Number(m[1]), month: Number(m[2]) };
}

export function addMonths(p: Period, n: number): Period {
  const { year, month } = parsePeriod(p);
  const idx = year * 12 + (month - 1) + n;
  return makePeriod(Math.floor(idx / 12), (idx % 12) + 1);
}

/** Lexical order of 'YYYY-MM' is chronological. */
export function comparePeriods(a: Period, b: Period): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function periodsBetween(from: Period, to: Period): Period[] {
  const out: Period[] = [];
  for (let p = from; comparePeriods(p, to) <= 0; p = addMonths(p, 1)) out.push(p);
  return out;
}

export function isWithin(p: Period, start: Period, end: Period | null | undefined): boolean {
  return comparePeriods(p, start) >= 0 && (end == null || comparePeriods(p, end) <= 0);
}

/** Calendar date parts of an instant in a time zone. */
export function zonedDateParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") };
}

export function periodOfDate(date: Date, timeZone = "Europe/Berlin"): Period {
  const { year, month } = zonedDateParts(date, timeZone);
  return makePeriod(year, month);
}

/** Period of a calendar date stored at UTC midnight. */
export function periodOfCalendarDate(d: Date): Period {
  return makePeriod(d.getUTCFullYear(), d.getUTCMonth() + 1);
}

/** Today's calendar date in the zone, as a UTC-midnight Date. */
export function todayInZone(timeZone = "Europe/Berlin", now = new Date()): Date {
  const { year, month, day } = zonedDateParts(now, timeZone);
  return new Date(Date.UTC(year, month - 1, day));
}

export function currentPeriod(timeZone = "Europe/Berlin", now = new Date()): Period {
  return periodOfDate(now, timeZone);
}

export function daysInMonth(p: Period): number {
  const { year, month } = parsePeriod(p);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Due date for a period; dueDay is clamped to the month length. */
export function dueDateFor(p: Period, dueDay: number): Date {
  const { year, month } = parsePeriod(p);
  const day = Math.min(Math.max(1, dueDay), daysInMonth(p));
  return new Date(Date.UTC(year, month - 1, day));
}

/** Whole days from a to b (both calendar dates). Positive when b is later. */
export function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

export function formatPeriod(p: Period, style: "long" | "short" = "long"): string {
  const { year, month } = parsePeriod(p);
  const name = MONTH_NAMES[month - 1]!;
  return style === "long" ? `${name} ${year}` : `${name.slice(0, 3)} ${String(year).slice(2)}`;
}

/** Calendar date → 'YYYY-MM-DD'. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' → calendar Date, or null if invalid. */
export function parseIsoDate(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || isoDate(d) !== s ? null : d;
}

export function formatDate(d: Date): string {
  return new Intl.DateTimeFormat("de-DE", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
}

/**
 * Default billing start for a move-in date: the same month when moving in on or before the 15th,
 * otherwise the next month. The admin can override it on the membership.
 */
export function defaultBillingStart(moveIn: Date): Period {
  const p = periodOfCalendarDate(moveIn);
  return moveIn.getUTCDate() <= 15 ? p : addMonths(p, 1);
}

/** Default billing end for a move-out date: same month when moving out after the 15th, else the previous month. */
export function defaultBillingEnd(moveOut: Date): Period {
  const p = periodOfCalendarDate(moveOut);
  return moveOut.getUTCDate() > 15 ? p : addMonths(p, -1);
}
