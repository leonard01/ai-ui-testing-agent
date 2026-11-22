import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  webServer: {
    command: "npm run demo",
    url: "http://127.0.0.1:3000/health",
    reuseExistingServer: !process.env.CI,
    timeout: 15000,
  },
  fullyParallel: true,
  globalTimeout: 5 * 60 * 1000,
  // Parallel Chromium jobs on shared CI runners occasionally exceed 30s\n  // even though the same tests pass; allow bounded CI headroom.\n  timeout: process.env.CI ? 45_000 : 30_000,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [
    ["list"],
    ["html", { open: "never" }],
    ["junit", { outputFile: "test-results/junit.xml" }],
  ],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
