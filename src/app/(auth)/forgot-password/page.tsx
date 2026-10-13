import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Field, Input } from "@/components/ui";
import { forgotPasswordAction } from "@/app/actions/auth";

export const metadata = { title: "Reset password" };

export default function ForgotPasswordPage() {
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold">Reset your password</h1>
      <p className="mb-5 text-sm text-muted">We&apos;ll email you a link to choose a new password.</p>
      <ActionForm action={forgotPasswordAction} resetOnSuccess>
        <Field label="Email" htmlFor="email">
          <Input id="email" name="email" type="email" autoComplete="email" required autoFocus />
        </Field>
        <SubmitButton className="w-full" pendingText="Sending…">Send reset link</SubmitButton>
      </ActionForm>
      <p className="mt-4 text-center text-sm">
        <Link href="/login" className="text-accent hover:underline">Back to sign in</Link>
      </p>
    </>
  );
}
