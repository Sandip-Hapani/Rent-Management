import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="text-center">
        <p className="text-sm font-medium text-accent">404</p>
        <h1 className="mt-1 text-xl font-semibold">Page not found</h1>
        <p className="mt-1 text-sm text-muted">It doesn&apos;t exist, or you don&apos;t have access to it.</p>
        <Link href="/dashboard" className="mt-4 inline-block text-sm text-accent hover:underline">Go to dashboard</Link>
      </div>
    </main>
  );
}
