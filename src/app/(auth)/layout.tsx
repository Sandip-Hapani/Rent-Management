export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2.5">
          <span aria-hidden className="grid size-9 place-items-center rounded-lg bg-accent text-sm font-bold text-white">AR</span>
          <span className="text-lg font-semibold">Apartment Rent</span>
        </div>
        <div className="rounded-xl border border-line bg-surface p-6 shadow-sm">{children}</div>
        <p className="mt-6 text-center text-xs text-muted">Private app for residents. Accounts are created by invitation only.</p>
      </div>
    </main>
  );
}
