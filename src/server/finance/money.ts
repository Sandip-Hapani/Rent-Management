/**
 * Money helpers. All amounts are integer euro cents — never floats.
 */

export type Cents = number;

export function assertCents(value: number, label = "amount"): asserts value is Cents {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be an integer number of cents`);
}

/**
 * Parse a user-entered euro amount ("198,40", "198.4", "1.234,56", "€ 25") into cents.
 * Returns null when the text is not a valid amount. Never uses float arithmetic.
 */
export function parseEuroToCents(input: string | number | null | undefined): Cents | null {
  if (input === null || input === undefined) return null;
  let s = String(input).trim().replace(/[€\s]/g, "").replace(/^EUR/i, "");
  if (s === "") return null;
  let negative = false;
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  }
  // Grouping separators are allowed only in groups of three; the decimal part has 1–2 digits.
  const m = s.match(/^(\d{1,3}(?:[.,]\d{3})+|\d+)(?:([.,])(\d{1,2}))?$/);
  if (!m) return null;
  const intPart = m[1]!.replace(/[.,]/g, "");
  const frac = (m[3] ?? "").padEnd(2, "0");
  const cents = Number(intPart) * 100 + Number(frac || "0");
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

/** Convert a number that came from a spreadsheet cell (may be a float like 198.4) into cents. */
export function numberToCents(n: number): Cents {
  // toFixed(2) rounds the binary float to the nearest cent as text; parse that text.
  const c = parseEuroToCents(n.toFixed(2));
  if (c === null) throw new Error(`Invalid amount: ${n}`);
  return c;
}

const formatter = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });

export function formatCents(cents: Cents): string {
  return formatter.format(cents / 100);
}

/** Plain "198.40" representation (for CSV and form inputs). */
export function centsToDecimalString(cents: Cents): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function sum(values: readonly Cents[]): Cents {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

/**
 * Split `total` cents proportionally to non-negative integer `weights` using the largest-remainder
 * method. The result always sums exactly to `total`. Ties are broken by input order, so callers
 * must pass participants in a deterministic order (join date, then id).
 */
export function splitByWeights(total: Cents, weights: readonly number[]): Cents[] {
  assertCents(total, "total");
  if (weights.length === 0) {
    if (total === 0) return [];
    throw new Error("Cannot split a non-zero amount across zero participants");
  }
  for (const w of weights) {
    if (!Number.isSafeInteger(w) || w < 0) throw new Error("Weights must be non-negative integers");
  }
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (weightSum === 0) throw new Error("Weights must not all be zero");

  const sign = total < 0 ? -1 : 1;
  const abs = BigInt(Math.abs(total));
  const W = BigInt(weightSum);
  const shares: number[] = [];
  const remainders: { index: number; rem: bigint }[] = [];
  let allocated = 0;
  weights.forEach((w, index) => {
    const numerator = abs * BigInt(w);
    const share = Number(numerator / W);
    shares.push(share);
    allocated += share;
    remainders.push({ index, rem: numerator % W });
  });
  let leftover = Math.abs(total) - allocated;
  remainders.sort((a, b) => (a.rem === b.rem ? a.index - b.index : a.rem > b.rem ? -1 : 1));
  for (let i = 0; leftover > 0; i++, leftover--) {
    shares[remainders[i % remainders.length]!.index]! += 1;
  }
  return shares.map((v) => v * sign);
}

/** Equal split, e.g. 992.00 / 6 → [165.34, 165.34, 165.33, 165.33, 165.33, 165.33]. */
export function splitEqually(total: Cents, participants: number): Cents[] {
  return splitByWeights(total, Array.from({ length: participants }, () => 1));
}
