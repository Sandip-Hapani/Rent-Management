"use client";

import { useActionState, useState } from "react";
import type { ActionResult } from "@/server/errors";
import { Alert, Field, Input, Select, Textarea } from "./ui";
import { SubmitButton } from "./forms";
import { categoryLabel } from "@/lib/format";

const METHODS = [
  { value: "EQUAL_SPLIT", label: "Equal split of an apartment total", help: "e.g. total rent 1.071,00 € split between everyone billed that month" },
  { value: "FIXED_PER_MEMBER", label: "Fixed amount per resident", help: "e.g. 25,60 € electricity per person" },
  { value: "CUSTOM", label: "Custom amount per resident", help: "Different amounts, e.g. bigger room pays more" },
  { value: "PERCENTAGE", label: "Percentage of an apartment total", help: "Percentages must add up to 100 %" },
] as const;

export interface RuleFormDefaults {
  ruleId?: string;
  name?: string;
  category?: string;
  method?: string;
  total?: string;
  perMember?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  reason?: string;
  previousRuleId?: string;
  participants?: string[];
  shares?: Record<string, string>;
}

export function RuleForm({
  action,
  members,
  categories,
  defaults = {},
  lockCategory,
}: {
  action: (prev: ActionResult<unknown> | null, fd: FormData) => Promise<ActionResult<unknown>>;
  members: { id: string; displayName: string; active: boolean }[];
  categories: readonly string[];
  defaults?: RuleFormDefaults;
  lockCategory?: boolean;
}) {
  const [state, formAction] = useActionState(action, null);
  const [method, setMethod] = useState(defaults.method ?? "EQUAL_SPLIT");
  const [all, setAll] = useState(!defaults.participants || defaults.participants.length === 0);
  const needsShares = method === "CUSTOM" || method === "PERCENTAGE";
  const showMembers = needsShares || !all;

  return (
    <form action={formAction} className="space-y-5">
      {state && !state.ok && <Alert tone="bad">{state.error}</Alert>}
      {defaults.ruleId && <input type="hidden" name="ruleId" value={defaults.ruleId} />}
      {defaults.previousRuleId && <input type="hidden" name="previousRuleId" value={defaults.previousRuleId} />}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="name"><Input id="name" name="name" required maxLength={100} defaultValue={defaults.name} placeholder="Monthly rent" /></Field>
        <Field label="Category" htmlFor="category">
          {lockCategory && <input type="hidden" name="category" value={defaults.category} />}
          <Select id="category" name={lockCategory ? undefined : "category"} defaultValue={defaults.category ?? "RENT"} disabled={lockCategory}>
            {categories.map((c) => <option key={c} value={c}>{categoryLabel(c)}</option>)}
          </Select>
        </Field>
        <Field label="Effective from (month)" htmlFor="effectiveFrom" hint="Earlier months keep their existing amounts."><Input id="effectiveFrom" name="effectiveFrom" type="month" required defaultValue={defaults.effectiveFrom} /></Field>
        <Field label="Ends after (optional)" htmlFor="effectiveTo" hint="Leave empty for ongoing charges."><Input id="effectiveTo" name="effectiveTo" type="month" defaultValue={defaults.effectiveTo} /></Field>
      </div>

      <fieldset>
        <legend className="mb-2 text-sm font-medium">How is it split?</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {METHODS.map((m) => (
            <label key={m.value} className={`cursor-pointer rounded-lg border p-3 text-sm ${method === m.value ? "border-accent bg-accent-soft" : "border-line"}`}>
              <input type="radio" name="method" value={m.value} checked={method === m.value} onChange={() => setMethod(m.value)} className="mr-2" />
              <span className="font-medium">{m.label}</span>
              <span className="mt-0.5 block text-xs text-muted">{m.help}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {(method === "EQUAL_SPLIT" || method === "PERCENTAGE") && (
        <Field label="Apartment-wide monthly total (€)" htmlFor="total" hint="Rounding cents go to the earliest residents so the split always adds up exactly.">
          <Input id="total" name="total" inputMode="decimal" required defaultValue={defaults.total} placeholder="1.071,00" />
        </Field>
      )}
      {method === "FIXED_PER_MEMBER" && (
        <Field label="Amount per resident (€)" htmlFor="perMember"><Input id="perMember" name="perMember" inputMode="decimal" required defaultValue={defaults.perMember} placeholder="25,60" /></Field>
      )}

      {!needsShares && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="allMembers" checked={all} onChange={(e) => setAll(e.target.checked)} /> Everyone billed in the month (recommended)
        </label>
      )}
      {showMembers && (
        <fieldset className="rounded-lg border border-line p-3">
          <legend className="px-1 text-sm font-medium">{needsShares ? (method === "CUSTOM" ? "Amount per resident (€)" : "Percentage per resident") : "Only these residents"}</legend>
          <ul className="space-y-2">
            {members.map((m) => (
              <li key={m.id} className="flex items-center gap-3 text-sm">
                <label className="flex flex-1 items-center gap-2">
                  <input type="checkbox" name="participant" value={m.id} defaultChecked={defaults.participants ? defaults.participants.includes(m.id) : m.active} />
                  {m.displayName}{!m.active && <span className="text-xs text-muted">(moved out)</span>}
                </label>
                {needsShares && (
                  <span className="flex items-center gap-1">
                    <label className="sr-only" htmlFor={`share-${m.id}`}>{m.displayName}</label>
                    <input id={`share-${m.id}`} name={`share:${m.id}`} inputMode="decimal" defaultValue={defaults.shares?.[m.id]} className="num w-24 rounded-md border border-line px-2 py-1 text-right" placeholder={method === "PERCENTAGE" ? "20" : "0,00"} />
                    <span className="text-muted">{method === "PERCENTAGE" ? "%" : "€"}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </fieldset>
      )}

      <Field label="Reason / note" htmlFor="reason" hint="Shown to residents when the change is published."><Textarea id="reason" name="reason" defaultValue={defaults.reason} maxLength={1000} placeholder="Landlord's letter of 15 May: rent increases by 3 %" /></Field>
      <SubmitButton>Save draft and preview</SubmitButton>
    </form>
  );
}
