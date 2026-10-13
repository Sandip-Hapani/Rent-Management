import { expect, test, type Page } from "@playwright/test";
import { DEMO_PASSWORD } from "../../prisma/demo";

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

test.describe("signed out", () => {
  test("private pages redirect to sign-in and private APIs refuse access", async ({ page, request }) => {
    await page.goto("/payments");
    await expect(page).toHaveURL(/\/login\?next=%2Fpayments/);
    expect((await request.get("/api/files/anything")).status()).toBe(401);
    expect((await request.get("/api/reports/ledger?format=csv")).status()).toBe(401);
    expect((await request.get("/api/health")).status()).toBe(200);
  });

  test("wrong password shows a generic error", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill("bea@demo.test");
    await page.getByLabel("Password").fill("not the password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Incorrect email or password.")).toBeVisible();
  });
});

test.describe("resident", () => {
  test("sees own dashboard, cannot reach admin areas, and can submit a payment @mobile", async ({ page }) => {
    await signIn(page, "bea@demo.test");
    await expect(page.getByRole("heading", { name: "Hi Bea" })).toBeVisible();
    await expect(page.getByText("Your account")).toBeVisible();
    await expect(page.getByRole("link", { name: "Apartment Settings" })).toHaveCount(0);

    await page.goto("/settings");
    await expect(page).toHaveURL(/\/dashboard/);
    const res = await page.request.get("/api/reports/ledger?format=csv");
    expect(res.status()).toBe(404);

    await page.goto("/payments/new");
    await page.getByLabel("Amount transferred (€)").fill("201,60");
    await page.getByRole("button", { name: "Submit for verification" }).click();
    await expect(page.getByText("Payment submitted")).toBeVisible();
    await expect(page.getByText("Submitted", { exact: true }).first()).toBeVisible();
  });
});

test.describe("administrator", () => {
  test("reviews the queue, sees reports and settings", async ({ page }) => {
    await signIn(page, "alex@demo.test");
    await page.goto("/payments?status=OPEN");
    await expect(page.getByRole("heading", { name: "Payments" })).toBeVisible();
    await page.goto("/reports?type=collection");
    await expect(page.getByRole("heading", { name: "Expected vs confirmed collection" })).toBeVisible();
    const csv = await page.request.get("/api/reports/collection?format=csv");
    expect(csv.status()).toBe(200);
    expect(await csv.text()).toContain("Expected");
    await page.goto("/settings/periods");
    await expect(page.getByRole("heading", { name: "Months" })).toBeVisible();
  });
});
