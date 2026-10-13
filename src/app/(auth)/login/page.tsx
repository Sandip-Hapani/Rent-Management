import Link from "next/link";
import { redirect } from "next/navigation";
import { getCtx } from "@/server/auth/context";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Field, Input } from "@/components/ui";
import { loginAction } from "@/app/actions/auth";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (await getCtx()) redirect("/dashboard");
  const { next } = await searchParams;
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold">Sign in</h1>
      <p className="mb-5 text-sm text-muted">Check your rent, payments and apartment documents.</p>
      <ActionForm action={loginAction}>
        <input type="hidden" name="next" value={next ?? "/dashboard"} />
        <Field label="Email" htmlFor="email">
          <Input id="email" name="email" type="email" autoComplete="username" required autoFocus />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input id="password" name="password" type="password" autoComplete="current-password" required />
        </Field>
        <SubmitButton className="w-full" pendingText="Signing in…">Sign in</SubmitButton>
      </ActionForm>
      <p className="mt-4 text-center text-sm">
        <Link href="/forgot-password" className="text-accent hover:underline">Forgot your password?</Link>
      </p>
    </>
  );
}
