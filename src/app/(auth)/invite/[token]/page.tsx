import { peekToken } from "@/server/auth/service";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Alert, Field, Input } from "@/components/ui";
import { acceptInviteAction } from "@/app/actions/auth";
import { PASSWORD_MIN_LENGTH } from "@/server/auth/crypto";

export const metadata = { title: "Set up your account" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const info = await peekToken("INVITE", token);
  if (!info) {
    return <Alert tone="bad" title="This invitation is invalid or has expired.">Ask the apartment administrator to send a new one.</Alert>;
  }
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold">Welcome{info.name ? `, ${info.name.split(" ")[0]}` : ""}</h1>
      <p className="mb-5 text-sm text-muted">Choose a password for <strong>{info.email}</strong> to activate your account.</p>
      <ActionForm action={acceptInviteAction}>
        <input type="hidden" name="token" value={token} />
        <Field label="Password" htmlFor="password" hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}>
          <Input id="password" name="password" type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} required autoFocus />
        </Field>
        <Field label="Repeat password" htmlFor="confirm">
          <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
        </Field>
        <SubmitButton className="w-full" pendingText="Activating…">Activate account</SubmitButton>
      </ActionForm>
    </>
  );
}
