"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { ActionResult } from "@/server/errors";
import { centsToDecimalString, eur, formatPeriod, categoryLabel } from "@/lib/format";
import { parseEuroToCents } from "@/server/finance/money";
import { Alert, Button, Field, Textarea, cx } from "./ui";
import { SubmitButton } from "./forms";

export interface EditorCharge {
  id: string;
  period: string;
  category: string;
  amountCents: number;
  openCents: number;
}

/**
 * Allocation editor for verification / reallocation. The server re-validates everything; this
 * component just helps the administrator split one transfer across charges and months.
 */
export function AllocationEditor({
  action,
  paymentId,
  paymentCents,
  charges,
  initial,
  mode,
}: {
  action: (prev: ActionResult<unknown> | null, fd: FormData) => Promise<ActionResult<unknown>>;
  paymentId: string;
  paymentCents: number;
  charges: EditorCharge[];
  initial: Record<string, number>;
  mode: "verify" | "reallocate";
}) {
  const [state, formAction] = useActionState(action, null);
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, centsToDecimalString(v)])));
  useEffect(() => { if (state?.ok) router.refresh(); }, [state, router]);

  const parsed = useMemo(() => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim() ? parseEuroToCents(v) : 0])), [values]);
  const total = Object.values(parsed).reduce<number>((a, v) => a + (v ?? 0), 0);
  const invalid = Object.entries(parsed).some(([id, v]) => v === null || v < 0 || v > (charges.find((c) => c.id === id)?.openCents ?? 0));
  const unallocated = paymentCents - total;

  const autofill = () => {
    let left = paymentCents;
    const next: Record<string, string> = {};
    for (const c of [...charges].sort((a, b) => a.period.localeCompare(b.period))) {
      const take = Math.min(left, c.openCents);
      if (take > 0) next[c.id] = centsToDecimalString(take);
      left -= take;
    }
    setValues(next);
  };

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="paymentId" value={paymentId} />
      {state && !state.ok && <Alert tone="bad">{state.error}</Alert>}
      {state?.ok && <Alert tone="good">{state.message ?? "Saved."}</Alert>}
      {charges.length === 0 ? (
        <Alert tone="warn" title="This resident has no open charges.">Verifying without allocations keeps the full amount as credit.</Alert>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead className="bg-canvas/60 text-xs text-muted">
              <tr><th className="px-3 py-2 text-left font-medium">Charge</th><th className="px-3 py-2 text-right font-medium">Open</th><th className="px-3 py-2 text-right font-medium">Allocate (€)</th></tr>
            </thead>
            <tbody>
              {charges.map((c) => {
                const v = parsed[c.id];
                const bad = v === null || (v ?? 0) > c.openCents;
                return (
                  <tr key={c.id} className="border-t border-line">
                    <td className="px-3 py-2">{formatPeriod(c.period)} · {categoryLabel(c.category)}</td>
                    <td className="num px-3 py-2 text-right">{eur(c.openCents)}</td>
                    <td className="px-3 py-1.5 text-right">
                      <label className="sr-only" htmlFor={`alloc-${c.id}`}>Allocate to {formatPeriod(c.period)} {categoryLabel(c.category)}</label>
                      <input
                        id={`alloc-${c.id}`}
                        name={`alloc:${c.id}`}
                        inputMode="decimal"
                        value={values[c.id] ?? ""}
                        onChange={(e) => setValues((s) => ({ ...s, [c.id]: e.target.value }))}
                        placeholder="0,00"
                        aria-invalid={bad}
                        className={cx("num w-28 rounded-md border px-2 py-1 text-right", bad ? "border-bad" : "border-line")}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <div className="num space-x-4">
          <span>Allocated <strong>{eur(total)}</strong> of {eur(paymentCents)}</span>
          <span className={cx(unallocated < 0 ? "text-bad" : unallocated > 0 ? "text-warn" : "text-good")}>
            {unallocated < 0 ? `Over by ${eur(-unallocated)}` : unallocated > 0 ? `${eur(unallocated)} stays as credit` : "Fully allocated"}
          </span>
        </div>
        {charges.length > 0 && <Button type="button" variant="ghost" onClick={autofill}>Fill oldest first</Button>}
      </div>
      {mode === "verify" ? (
        <Field label="Note (optional, visible to the resident)" htmlFor="adminNote"><Textarea id="adminNote" name="adminNote" maxLength={1000} /></Field>
      ) : (
        <Field label="Reason for changing the allocation" htmlFor="reason"><Textarea id="reason" name="reason" required maxLength={500} /></Field>
      )}
      <SubmitButton className={cx((invalid || unallocated < 0) && "pointer-events-none opacity-50")} pendingText="Saving…">
        {mode === "verify" ? "Verify payment" : "Save new allocation"}
      </SubmitButton>
    </form>
  );
}
