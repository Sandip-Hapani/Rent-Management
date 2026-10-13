"use client";

import { Alert, Button } from "@/components/ui";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const notFound = /not found/i.test(error.message);
  return (
    <div className="max-w-lg space-y-4">
      <Alert tone={notFound ? "warn" : "bad"} title={notFound ? "Not found" : "Something went wrong"}>
        {notFound ? "This page doesn't exist or you don't have access to it." : "The page couldn't be loaded. Try again; if it keeps happening, tell the administrator."}
        {error.digest && <span className="mt-1 block text-xs opacity-70">Reference: {error.digest}</span>}
      </Alert>
      <Button variant="secondary" onClick={reset}>Try again</Button>
    </div>
  );
}
