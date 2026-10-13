import Link from "next/link";
import { peekToken } from "@/server/auth/service";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Alert, Field, Input } from "@/components/ui";
import { resetPasswordAction } from "@/app/actions/auth";
import { PASSWORD_MIN_LENGTH } from "@/server/auth/crypto";

export const metadata = { title: "Choose a new password" };

export default async function ResetPasswordPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const info = await peekToken("PASSWORD_RESET", token);
  if (!info) {
    return (
      <>
        <Alert tone="bad" title="This link is invalid or has expired." />
        <p className="mt-4 text-sm"><Link className="text-accent hover:underline" href="/forgot-password">Request a new link</Link></p>
      </>
    );
  }
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold">Choose a new password</h1>
      <p className="mb-5 text-sm text-muted">For {info.email}. You&apos;ll be signed out on all other devices.</p>
      <ActionForm action={resetPasswordAction}>
        <input type="hidden" name="token" value={token} />
        <Field label="New password" htmlFor="password" hint={`At least ${PASSWORD_MIN_LENGTH} characters. A short sentence works well.`}>
          <Input id="password" name="password" type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} required />
        </Field>
        <Field label="Repeat password" htmlFor="confirm">
          <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
        </Field>
        <SubmitButton className="w-full">Save password</SubmitButton>
      </ActionForm>
    </>
  );
}
