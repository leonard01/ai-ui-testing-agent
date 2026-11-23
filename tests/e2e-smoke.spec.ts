import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createReviewServer } from "../src/review-server.js";

// Black-box browser journeys. The harness uses Playwright directly, never the
// agent's JSON test authoring APIs, CLI runner or any hosted AI provider.
const demoURL = "http://127.0.0.1:3000";
const instructions =
  "Add Prepare interview, complete it, then delete it and check the task count.";

test.describe("@e2e-smoke application smoke", () => {
  let server: Server | undefined;
  let url: string;
  let dataDir: string | undefined;

  test.beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "agent-e2e-smoke-"));
    // Do not share Playwright Test\'s instrumented browser with the agent runner.\n    // The app launches its own Chromium contexts and traces during execution.\n    server = await createReviewServer(dataDir);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    url = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  });

  test.afterEach(async () => {
    try {
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server!.close((error) => error ? reject(error) : resolve()));
      }
    } finally {
      server = undefined;
      if (dataDir) await rm(dataDir, { recursive: true, force: true });
      dataDir = undefined;
    }
  });

  async function proposeFixture(page: Page, testName: string) {
    await page.goto(url);
    await expect(page.getByRole("heading", { name: "Test Instructions" })).toBeVisible();
    await page.getByLabel("Application URL").fill(demoURL);
    await page.getByLabel("Your test instructions").fill(instructions);
    await page.getByLabel("Generate with").selectOption("fixture");
    await page.getByRole("button", { name: "Generate draft" }).click();
    await expect(page.locator("#generation-status")).toContainText("Draft ready");
    await expect(page.locator("#step-list .step")).toHaveCount(9);
    await page.locator("#test-name").fill(testName);
  }

  async function saveApprovedFixture(page: Page, testName: string) {
    await proposeFixture(page, testName);
    await expect(page.getByRole("button", {
      name: "Approve and save JSON test",
    })).toBeDisabled();
    await page.getByRole("button", { name: "Add All", exact: true }).click();
    await expect(page.locator("#review-progress")).toHaveText("9 of 9 steps confirmed");
    await expect(page.locator("#saved")).toBeEmpty(); // approval is not persistence
    await page.getByRole("button", { name: "Approve and save JSON test" }).click();
    await expect(page.locator("#saved")).toContainText("Saved and ready to execute");
    return page.getByLabel("Test script", { exact: true }).inputValue();
  }

  test("fixture draft → explicit approval → saved test → execution → history", async ({ page }) => {
    const id = await saveApprovedFixture(page, "Smoke - task lifecycle");
    expect(id).toMatch(/^reviewed-.*\.json$/);
    await expect(page.getByRole("button", { name: "Run selected test" })).toBeEnabled();

    // Click through the real UI; this is not a generated agent test.
    await page.getByRole("button", { name: "Run selected test" }).click();
    await expect(page.locator("#run-status")).toContainText(
      "Run complete", { timeout: 30_000 });
    const reportPath = await page.locator("#run-artifacts a").first().getAttribute("href");
    expect(reportPath).toMatch(/^\/api\/runs\/.*\/report\.json$/);
    const report = await (await page.request.get(url + reportPath)).json();
    expect(report.status, JSON.stringify(report, null, 2)).toBe("passed");
    await expect(page.locator("#run-summary")).toContainText("PASSED");
    await expect(page.locator("#run-totals")).toContainText("9 passed");
    await expect(page.locator("#run-steps .run-step")).toHaveCount(9);

    await page.getByRole("button", { name: "Show History" }).click();
    await expect(page.locator("#history-suite-list .history-entry")).toHaveCount(1);
  });

  test("partially approved working draft survives reload without becoming executable", async ({ page }) => {
    await proposeFixture(page, "Smoke - unfinished draft");
    await page.locator("#step-list .step input[type=checkbox]").nth(0).check();
    await page.locator("#step-list .step input[type=checkbox]").nth(1).check();
    await page.getByRole("button", { name: "Save Working Draft" }).click();
    await expect(page.locator("#draft-save-status")).toContainText("2/9 approved");
    await expect(page.getByRole("button", { name: "Approve and save JSON test" })).toBeDisabled();

    await page.reload();
    await expect(page.locator("#draft-select option")).toHaveCount(2);
    await page.locator("#draft-select").selectOption({ index: 1 });
    await page.getByRole("button", { name: "Resume draft" }).click();
    await expect(page.locator("#review-progress")).toHaveText("2 of 9 steps confirmed");
    await expect(page.getByLabel("Your test instructions")).toHaveValue(instructions);
    await expect(page.getByRole("button", { name: "Approve and save JSON test" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Run selected test" })).toBeDisabled();
  });

  test("two saved scripts can execute as a website suite", async ({ page }) => {
    test.setTimeout(60_000);
    const first = await saveApprovedFixture(page, "Smoke suite - first");
    const second = await saveApprovedFixture(page, "Smoke suite - second");
    expect(second).not.toBe(first);

    await expect(page.getByLabel("Test suite (website URL)")).toHaveValue(demoURL);
    await expect(page.locator("#suite-test-list input[type=checkbox]")).toHaveCount(2);
    await page.getByRole("button", { name: "Select first 10" }).click();
    await expect(page.locator("#suite-selection-status")).toContainText("2 tests selected");
    await page.getByRole("button", { name: "Run selected suite" }).click();
    await expect(page.locator("#suite-status")).toContainText(
      "Suite complete", { timeout: 45_000 });
    await expect(page.locator("#suite-status")).toContainText("PASSED");
    await expect(page.locator("#suite-summary")).toContainText("2 passed, 0 failed");
  });
});
