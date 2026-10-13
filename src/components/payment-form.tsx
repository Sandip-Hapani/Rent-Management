"use client";

import { useActionState, useMemo, useState } from "react";
import type { ActionResult } from "@/server/errors";
import { Alert, Field, Input, Textarea, cx } from "./ui";
import { SubmitButton } from "./forms";
import { eur, formatPeriod } from "@/lib/format";
import { parseEuroToCents } from "@/server/finance/money";

export interface OpenMonth {
  period: string;
  outstanding: number;
  status: string;
}

export interface PaymentDefaults {
  paymentId?: string;
  amount?: string;
  transferDate?: string;
  bank?: string;
  description?: string;
  periods?: string[];
  includesDeposit?: boolean;
  includesElectricity?: boolean;
  residentNote?: string;
}

const BANKS = ["Deutsche Bank", "Sparkasse", "Wise", "N26", "Expatrio", "Santander", "Commerzbank", "ING", "DKB", "PayPal"];

export function PaymentForm({
  action,
  months,
  members,
  defaults = {},
  maxUploadMb,
  mode = "create",
}: {
  action: (prev: ActionResult<unknown> | null, fd: FormData) => Promise<ActionResult<unknown>>;
  months: OpenMonth[];
  members?: { id: string; displayName: string }[];
  defaults?: PaymentDefaults;
  maxUploadMb: number;
  mode?: "create" | "edit";
}) {
  const [state, formAction] = useActionState(action, null);
  const [periods, setPeriods] = useState<string[]>(defaults.periods ?? []);
  const [amount, setAmount] = useState(defaults.amount ?? "");
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const cents = parseEuroToCents(amount);
  // When an admin records for someone else, the month balances shown would be the admin's own.
  const onBehalf = !!members && members.length > 0;
  const selectedDue = useMemo(() => months.filter((m) => periods.includes(m.period)).reduce((a, m) => a + Math.max(0, m.outstanding), 0), [months, periods]);

  const toggle = (p: string) => setPeriods((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p].sort()));

  return (
    <form action={formAction} className="space-y-5">
      {state && !state.ok && <Alert tone="bad">{state.error}</Alert>}
      {state?.ok && <Alert tone="good">{state.message ?? "Saved."}</Alert>}
      {defaults.paymentId && <input type="hidden" name="paymentId" value={defaults.paymentId} />}

      {members && members.length > 0 && (
        <Field label="Resident" htmlFor="membershipId" hint="Administrators can record a transfer on someone's behalf.">
          <select id="membershipId" name="membershipId" className="block w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm">
            {members.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
          </select>
        </Field>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Amount transferred (€)" htmlFor="amount" hint={cents !== null && cents > 0 ? eur(cents) : "Exactly as on your bank statement, e.g. 214,89"}>
          <Input id="amount" name="amount" inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" autoComplete="off" />
        </Field>
        <Field label="Transfer date" htmlFor="transferDate">
          <Input id="transferDate" name="transferDate" type="date" required defaultValue={defaults.transferDate ?? new Date().toISOString().slice(0, 10)} max={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)} />
        </Field>
        <Field label="Bank or provider" htmlFor="bank">
          <Input id="bank" name="bank" list="banks" defaultValue={defaults.bank} maxLength={60} placeholder="e.g. Sparkasse" />
          <datalist id="banks">{BANKS.map((b) => <option key={b} value={b} />)}</datalist>
        </Field>
        <Field label="Transfer description" htmlFor="description" hint="The reference text you used">
          <Input id="description" name="description" defaultValue={defaults.description} maxLength={500} placeholder="Rent + electricity October" />
        </Field>
      </div>

      <fieldset>
        <legend className="mb-1 text-sm font-medium">Which month(s) does this cover?</legend>
        <p className="mb-2 text-xs text-muted">The administrator confirms the final split when verifying.</p>
        {months.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line px-3 py-3 text-sm text-muted">No open months right now. You can still record the payment; it will be kept as credit.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {months.map((m) => {
              const on = periods.includes(m.period);
              return (
                <label key={m.period} className={cx("cursor-pointer rounded-lg border px-3 py-2 text-sm", on ? "border-accent bg-accent-soft" : "border-line bg-surface hover:bg-canvas")}>
                  <input type="checkbox" name="periods" value={m.period} checked={on} onChange={() => toggle(m.period)} className="sr-only" />
                  <span className="block font-medium">{formatPeriod(m.period)}</span>
                  {!onBehalf && <span className="num block text-xs text-muted">{m.outstanding > 0 ? `${eur(m.outstanding)} open` : m.status === "NO_CHARGES" ? "not billed yet" : "paid"}</span>}
                </label>
              );
            })}
          </div>
        )}
        {!onBehalf && periods.length > 0 && cents !== null && (
          <p className={cx("mt-2 text-xs", cents === selectedDue ? "text-good" : "text-muted")}>
            Selected months: {eur(selectedDue)} open
            {cents > selectedDue && ` · ${eur(cents - selectedDue)} would remain as credit`}
            {cents < selectedDue && ` · ${eur(selectedDue - cents)} would remain outstanding`}
          </p>
        )}
      </fieldset>

      <div className="flex flex-wrap gap-6 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" name="includesElectricity" defaultChecked={defaults.includesElectricity ?? true} className="size-4" /> Includes electricity</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="includesDeposit" defaultChecked={defaults.includesDeposit} className="size-4" /> Includes a deposit</label>
      </div>

      <Field label={mode === "edit" ? "Add receipts" : "Receipt or bank screenshot"} htmlFor="evidence" hint={`PDF, PNG, JPEG or WebP, up to ${maxUploadMb} MB each, max 5 files.`} error={fileError ?? undefined}>
        <input
          id="evidence"
          name="evidence"
          type="file"
          multiple
          accept="application/pdf,image/png,image/jpeg,image/webp"
          className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-accent-soft file:px-3 file:py-2 file:text-sm file:font-medium file:text-accent-strong"
          onChange={(e) => {
            const list = Array.from(e.currentTarget.files ?? []);
            const tooBig = list.find((f) => f.size > maxUploadMb * 1024 * 1024);
            setFileError(tooBig ? `${tooBig.name} is larger than ${maxUploadMb} MB.` : list.length > 5 ? "Choose at most 5 files." : null);
            setFiles(list);
          }}
        />
        {files.length > 0 && <ul className="mt-2 text-xs text-muted">{files.map((f) => <li key={f.name}>{f.name} · {(f.size / 1024).toFixed(0)} KB</li>)}</ul>}
      </Field>

      <Field label="Note for the administrator (optional)" htmlFor="residentNote">
        <Textarea id="residentNote" name="residentNote" defaultValue={defaults.residentNote} maxLength={1000} />
      </Field>

      <div className="flex flex-wrap gap-2 border-t border-line pt-4">
        <SubmitButton name="intent" value="submit" pendingText="Uploading…" className={cx(fileError && "pointer-events-none opacity-50")}>Submit for verification</SubmitButton>
        <SubmitButton name="intent" value="draft" variant="secondary" pendingText="Saving…">Save as draft</SubmitButton>
      </div>
    </form>
  );
}
