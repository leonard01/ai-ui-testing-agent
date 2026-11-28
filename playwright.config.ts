import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";

const runDirectory = process.env.REGRESSION_RUN_DIR;

export default defineConfig({
  testDir: "./tests",
  ...(runDirectory ? { outputDir: join(runDirectory, "regression-evidence") } : {}),
  testMatch: "**/*.spec.ts",
  webServer: {
    command: "npm run demo",
    url: "http://127.0.0.1:3000/health",
    reuseExistingServer: !process.env.CI,
    timeout: 15000,
  },
  fullyParallel: true,
  globalTimeout: 15 * 60 * 1000,
  timeout: 30_000,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [
    ["list"],
    ["html", { open: "never", ...(runDirectory ? { outputFolder: join(runDirectory, "playwright-report") } : {}) }],
    ["junit", { outputFile: runDirectory ? join(runDirectory, "junit.xml") : "test-results/junit.xml" }],
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
