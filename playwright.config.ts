import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end smoke tests against a running app with demo data:
 *   npm run db:seed -- --reset && npm run test:e2e
 * Uses an installed browser when PW_CHANNEL is set (e.g. "msedge" or "chrome"),
 * otherwise Playwright's bundled Chromium (install once with `npx playwright install chromium`).
 */
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}) } },
    { name: "mobile", use: { ...devices["Pixel 7"], ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}) }, grep: /@mobile/ },
  ],
  webServer: process.env.E2E_BASE_URL ? undefined : { command: "npm run dev", url: "http://localhost:3000/api/health", reuseExistingServer: true, timeout: 120_000 },
});
