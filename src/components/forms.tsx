"use client";

import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import type { ActionResult } from "@/server/errors";
import { Alert, Button, Textarea, cx } from "./ui";

export type FormAction = (prev: ActionResult<unknown> | null, formData: FormData) => Promise<ActionResult<unknown>>;

export function SubmitButton({ children, variant = "primary", className, pendingText, name, value }: { children: ReactNode; variant?: "primary" | "secondary" | "danger" | "ghost"; className?: string; pendingText?: string; name?: string; value?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} disabled={pending} aria-disabled={pending} className={className} name={name} value={value}>
      {pending ? (pendingText ?? "Saving…") : children}
    </Button>
  );
}

/**
 * Form bound to a server action returning ActionResult. Shows errors inline and success messages
 * as a status line; optionally resets the form or refreshes server data on success.
 */
export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess,
  successMessage,
  onSuccessHref,
}: {
  action: FormAction;
  children: ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
  successMessage?: string;
  onSuccessHref?: string;
}) {
  const [state, formAction] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);
  const router = useRouter();
  useEffect(() => {
    if (state?.ok) {
      if (resetOnSuccess) ref.current?.reset();
      if (onSuccessHref) router.push(onSuccessHref);
      else router.refresh();
    }
  }, [state, resetOnSuccess, onSuccessHref, router]);
  return (
    <form ref={ref} action={formAction} className={cx("space-y-4", className)} noValidate={false}>
      {state && !state.ok && <Alert tone="bad">{state.error}</Alert>}
      {state?.ok && (state.message || successMessage) && <Alert tone="good">{state.message ?? successMessage}</Alert>}
      {children}
    </form>
  );
}

/**
 * Button that asks for confirmation (and optionally a reason) in a modal dialog before running
 * a server action. Used for irreversible or financially significant operations.
 */
export function ConfirmAction({
  action,
  label,
  title,
  description,
  confirmLabel = "Confirm",
  variant = "secondary",
  confirmVariant = "primary",
  reason,
  hidden,
  className,
}: {
  action: FormAction;
  label: ReactNode;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  confirmVariant?: "primary" | "danger";
  reason?: { label: string; required?: boolean; placeholder?: string };
  hidden?: Record<string, string>;
  className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, formAction] = useActionState(action, null);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (state?.ok) {
      dialog.current?.close();
      setOpen(false);
      router.refresh();
    }
  }, [state, router]);
  return (
    <>
      <Button type="button" variant={variant} className={className} onClick={() => { setOpen(true); dialog.current?.showModal(); }}>
        {label}
      </Button>
      <dialog ref={dialog} onClose={() => setOpen(false)} className="m-auto w-[min(92vw,28rem)] rounded-xl border border-line bg-surface p-0 text-ink shadow-xl backdrop:bg-black/30">
        {open && (
          <form action={formAction} className="space-y-4 p-5">
            <h2 className="text-base font-semibold">{title}</h2>
            {description && <div className="text-sm text-muted">{description}</div>}
            {hidden && Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
            {reason && (
              <div>
                <label className="mb-1 block text-sm font-medium" htmlFor="confirm-reason">{reason.label}</label>
                <Textarea id="confirm-reason" name="reason" required={reason.required} placeholder={reason.placeholder} />
              </div>
            )}
            {state && !state.ok && <Alert tone="bad">{state.error}</Alert>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => dialog.current?.close()}>Cancel</Button>
              <SubmitButton variant={confirmVariant} pendingText="Working…">{confirmLabel}</SubmitButton>
            </div>
          </form>
        )}
      </dialog>
    </>
  );
}

/** Small client helper: navigate when a select changes (for filters). */
export function AutoSubmitSelect({ name, defaultValue, options, label, className }: { name: string; defaultValue?: string; options: { value: string; label: string }[]; label: string; className?: string }) {
  return (
    <label className={cx("text-sm", className)}>
      <span className="sr-only">{label}</span>
      <select
        name={name}
        defaultValue={defaultValue}
        aria-label={label}
        className="rounded-lg border border-line bg-surface px-3 py-2 text-sm"
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}
