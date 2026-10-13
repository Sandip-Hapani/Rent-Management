import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { ensureInitialAdmin } from "@/server/bootstrap";
import { login } from "@/server/auth/service";
import { resetDb } from "./fixtures";

beforeEach(resetDb);

describe("default administrator bootstrap", () => {
  const input = { email: "Owner@Example.test", name: "Flat Owner", password: "a long enough passphrase", apartmentName: "Test flat" };

  it("creates the apartment and an active admin who can sign in, exactly once", async () => {
    const r = await ensureInitialAdmin(prisma, input);
    expect(r).toEqual({ status: "created", apartmentCreated: true, email: "owner@example.test" });
    const m = await prisma.membership.findFirstOrThrow({ include: { user: true, apartment: true } });
    expect(m.role).toBe("ADMIN");
    expect(m.user.status).toBe("ACTIVE");
    expect(m.apartment.name).toBe("Test flat");
    expect(m.user.passwordHash).not.toContain("passphrase");
    await expect(login("owner@example.test", "a long enough passphrase", "9.9.9.9")).resolves.toBe(m.userId);

    // Re-running (every deploy) never changes anything — not even after a password change.
    await prisma.user.update({ where: { id: m.userId }, data: { name: "Renamed" } });
    expect((await ensureInitialAdmin(prisma, { ...input, password: "a different passphrase" })).status).toBe("skipped");
    expect(await prisma.user.count()).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: m.userId } })).name).toBe("Renamed");
  });

  it("does nothing without configuration and rejects weak passwords", async () => {
    expect((await ensureInitialAdmin(prisma, {})).status).toBe("skipped");
    await expect(ensureInitialAdmin(prisma, { ...input, password: "short" })).rejects.toThrow(/not acceptable/);
    expect(await prisma.user.count()).toBe(0);
  });
});

describe("database file storage", () => {
  it("stores, streams and deletes file bytes in Postgres", async () => {
    const { DbDriver } = await import("@/server/storage");
    const driver = new DbDriver();
    const bytes = Buffer.from("%PDF-1.4 test content");
    await driver.put("document/2026/10/abc", bytes, "application/pdf");
    expect((await driver.read("document/2026/10/abc")).equals(bytes)).toBe(true);
    const { stream, size } = await driver.get("document/2026/10/abc");
    expect(size).toBe(bytes.length);
    expect(Buffer.from(await new Response(stream).arrayBuffer()).equals(bytes)).toBe(true);
    await driver.delete("document/2026/10/abc");
    await expect(driver.read("document/2026/10/abc")).rejects.toThrow(/not found/);
  });
});
