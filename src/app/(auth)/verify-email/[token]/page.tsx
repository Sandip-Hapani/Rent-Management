import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/forms";
import { confirmEmailAction } from "@/app/actions/auth";

export const metadata = { title: "Confirm email" };

/** Confirmation needs a click (POST) so link scanners in mail clients can't consume the token. */
export default async function VerifyEmailPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold">Confirm your new email</h1>
      <p className="mb-5 text-sm text-muted">After confirming, use this address to sign in.</p>
      <ActionForm action={confirmEmailAction}>
        <input type="hidden" name="token" value={token} />
        <SubmitButton className="w-full">Confirm email address</SubmitButton>
      </ActionForm>
      <p className="mt-4 text-center text-sm"><Link href="/login" className="text-accent hover:underline">Go to sign in</Link></p>
    </>
  );
}
