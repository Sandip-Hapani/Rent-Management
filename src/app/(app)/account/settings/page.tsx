import { requirePageCtx } from "@/server/auth/context";
import { getPreferences } from "@/server/notifications/queries";
import { PASSWORD_MIN_LENGTH } from "@/server/auth/crypto";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, CardHeader, Field, Input, PageHeader } from "@/components/ui";
import { changePasswordAction, requestEmailChangeAction } from "@/app/actions/auth";
import { preferencesAction } from "@/app/actions/misc";

export const metadata = { title: "Profile & security" };

export default async function ProfilePage() {
  const ctx = await requirePageCtx();
  const prefs = await getPreferences(ctx);
  return (
    <>
      <PageHeader title="Profile & security" description={`${ctx.name} · ${ctx.email}`} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Change password" description="Other devices will be signed out." />
          <div className="p-5">
            <ActionForm action={changePasswordAction} resetOnSuccess>
              <Field label="Current password" htmlFor="current"><Input id="current" name="current" type="password" autoComplete="current-password" required /></Field>
              <Field label="New password" htmlFor="next" hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}><Input id="next" name="next" type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} required /></Field>
              <Field label="Repeat new password" htmlFor="confirm"><Input id="confirm" name="confirm" type="password" autoComplete="new-password" required /></Field>
              <SubmitButton>Change password</SubmitButton>
            </ActionForm>
          </div>
        </Card>
        <Card>
          <CardHeader title="Change email address" description="We'll send a confirmation link to the new address." />
          <div className="p-5">
            <ActionForm action={requestEmailChangeAction} resetOnSuccess>
              <Field label="New email" htmlFor="email"><Input id="email" name="email" type="email" autoComplete="email" required /></Field>
              <Field label="Your password" htmlFor="pw"><Input id="pw" name="password" type="password" autoComplete="current-password" required /></Field>
              <SubmitButton>Send confirmation</SubmitButton>
            </ActionForm>
          </div>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Email notifications" description="In-app notifications are always kept. Security emails can't be turned off." />
          <div className="p-5">
            <ActionForm action={preferencesAction}>
              <fieldset>
                <legend className="sr-only">Email me about</legend>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {prefs.map((p) => (
                    <li key={p.type}>
                      <input type="hidden" name="type" value={p.type} />
                      <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" name={`email:${p.type}`} defaultChecked={p.email} disabled={p.locked} className="size-4 accent-[var(--color-accent)]" />
                        {p.label}{p.locked && <span className="text-xs text-muted">(required)</span>}
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>
              <SubmitButton>Save preferences</SubmitButton>
            </ActionForm>
          </div>
        </Card>
      </div>
    </>
  );
}
