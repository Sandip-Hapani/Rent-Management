import { requirePageAdmin } from "@/server/auth/context";
import { SettingsNav } from "@/components/settings-nav";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  await requirePageAdmin();
  return (
    <>
      <h1 className="mb-4 text-2xl font-semibold tracking-tight">Apartment settings</h1>
      <SettingsNav />
      {children}
    </>
  );
}
