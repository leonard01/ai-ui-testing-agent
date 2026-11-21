import { test, expect } from "@playwright/test";
import { createReviewServer } from "../src/review-server.js";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

let server: Server;
let url: string;
let outputDir: string;
test.beforeAll(async () => {
  outputDir = await mkdtemp(join(tmpdir(), "ui-review-"));
  server = await createReviewServer(outputDir);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});
test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()));
  await rm(outputDir, { recursive: true, force: true });
});

async function generateFixture(page: import("@playwright/test").Page) {
  await page.goto(url);
  await page.getByLabel("Your test instructions").fill(
    "Add Prepare interview, complete it, then delete it and check the task count.",
  );
  await page.getByLabel("Generate with").selectOption("fixture");
  await page.getByRole("button", { name: "Generate draft" }).click();
  await expect(page.locator("#generation-status")).toContainText("Draft ready");
  await expect(page.locator(".step")).toHaveCount(9);
}

test("plain-English input produces a readable review-only fixture draft", async ({ page }) => {
  await generateFixture(page);
  await expect(page.getByText("Fixture is a prewritten demonstration, not AI-generated.")).toBeVisible();
  await expect(page.locator(".step").nth(2)).toContainText("Enter");
  await expect(page.locator(".step").nth(2)).toContainText("Prepare interview");
  const save = page.getByRole("button", { name: "Approve and save JSON test" });
  await expect(save).toBeDisabled();
  for (const box of await page.locator(".step input[type=checkbox]").all()) {
    await box.check();
  }
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.locator("#saved")).toContainText("The test has NOT been executed");
  const files = await readdir(outputDir);
  expect(files).toHaveLength(1);
  const draft = JSON.parse(await readFile(join(outputDir, files[0]), "utf8"));
  expect(draft.steps).toHaveLength(9);
  expect(draft.steps.every((step: { action: { provenance?: string } }) =>
    step.action.provenance !== "human-confirmed",
  )).toBe(true);
});

test("user edits a step using form fields, without editing JSON", async ({ page }) => {
  await generateFixture(page);
  const thirdStep = page.locator(".step").nth(2);
  await thirdStep.getByRole("button", { name: "Edit fields" }).click();
  await thirdStep.getByLabel("Value to enter").fill("Prepare release");
  await thirdStep.getByRole("button", { name: "Apply changes" }).click();
  await expect(thirdStep).toContainText('Enter "Prepare release"');
  await expect(thirdStep.locator('input[type=checkbox]')).not.toBeChecked();

  // Users must be able to fix AI-suggested locator strategies without editing JSON:
  // a wrongly generated getByLabel("Add") can become getByRole("button", {name:"Add"}).
  const addStep = page.locator(".step").nth(3);
  await addStep.getByRole("button", { name: "Edit fields" }).click();
  await addStep.getByLabel("Locator strategy").selectOption("label");
  await expect(addStep.getByLabel("Form label text")).toHaveValue("Add");
  await addStep.getByLabel("Locator strategy").selectOption("role");
  await expect(addStep.getByLabel("Element role")).toHaveValue("button");
  await expect(addStep.getByLabel("Accessible name (may be blank)")).toHaveValue("Add");
  await addStep.getByRole("button", { name: "Apply changes" }).click();

  const taskStep = page.locator(".step").nth(4);
  await taskStep.getByRole("button", { name: "Edit fields" }).click();
  await taskStep.getByLabel("Locator strategy").selectOption("intent");
  await taskStep.getByLabel("Target intention (not a CSS selector)").fill("Prepare interview");
  await taskStep.getByRole("button", { name: "Apply changes" }).click();
  await expect(taskStep).toContainText('element matching intent "Prepare interview"');

  for (const box of await page.locator(".step input[type=checkbox]").all()) await box.check();
  await page.getByRole("button", { name: "Approve and save JSON test" }).click();
  await expect(page.locator("#saved")).toContainText("Saved!");
  const files = await readdir(outputDir);
  const drafts = await Promise.all(files.map(async (file) => JSON.parse(
    await readFile(join(outputDir, file), "utf8"),
  )));
  expect(drafts.some((draft) => draft.steps[2].action.value === "Prepare release")).toBe(true);
  expect(drafts.some((draft) => draft.steps[3].action.target.by === "role" && draft.steps[3].action.target.role === "button" && draft.steps[3].action.target.name === "Add")).toBe(true);
});

async function approveDraft(page: import("@playwright/test").Page) {
  for (const box of await page.locator(".step input[type=checkbox]").all()) await box.check();
  await page.getByRole("button", { name: "Approve and save JSON test" }).click();
  await expect(page.locator("#saved")).toContainText("Saved and ready to execute");
  await expect(page.getByRole("button", { name: "Run selected test" })).toBeEnabled();
}

test("run approved test from browser and show per-step diagnostics without CLI", async ({ page }) => {
  await generateFixture(page);
  await approveDraft(page);
  await page.getByRole("button", { name: "Run selected test" }).click();
  await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 25_000 });
  await expect(page.locator("#run-summary")).toContainText("PASSED");
  await expect(page.locator("#run-totals")).toContainText("9 passed");
  await expect(page.locator(".run-step")).toHaveCount(9);
  await expect(page.locator("#run-steps")).toContainText("Verify the task appears");
  await expect(page.locator("#run-artifacts")).toContainText("View full JSON report");
  await expect(page.locator("#run-screenshot-panel")).toBeHidden();
  const reportURL = await page.locator("#run-artifacts a").first().getAttribute("href");
  expect(reportURL).toMatch(/^\/api\/runs\/[a-f0-9-]+\/report\.json$/);
  const response = await fetch(url + reportURL);
  expect(response.status).toBe(200);
  const report = await response.json();
  expect(report.status).toBe("passed");
  expect(report.steps).toHaveLength(9);
});

test("failed UI run shows first assertion mismatch and screenshot/trace downloads", async ({ page }) => {
  await generateFixture(page);
  const initialStatus = page.locator(".step").nth(1);
  await initialStatus.getByRole("button", { name: "Edit fields" }).click();
  await initialStatus.getByLabel("Expected exact text").fill("99 tasks, 0 completed");
  await initialStatus.getByRole("button", { name: "Apply changes" }).click();
  await approveDraft(page);
  await page.getByRole("button", { name: "Run selected test" }).click();
  await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 25_000 });
  await expect(page.locator("#run-summary")).toContainText("FAILED");
  await expect(page.locator("#run-diagnosis")).toContainText("expected result");
  await expect(page.locator("#run-steps")).toContainText("99 tasks, 0 completed");
  await expect(page.locator("#run-steps")).toContainText("0 tasks, 0 completed");
  await expect(page.locator(".run-step").nth(1)).toContainText("assertion-failed");
  await expect(page.locator("#run-artifacts")).toContainText("Download Playwright trace");
  await expect(page.locator("#run-screenshot")).toBeVisible();
  const screenshotURL = await page.locator("#run-screenshot").getAttribute("src");
  expect(screenshotURL).toMatch(/\/failure\.png$/);
  const response = await fetch(url + screenshotURL);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("image/png");
  const tracePath = await page.getByRole("link", { name: "Download Playwright trace" }).getAttribute("href");
  const traceResponse = await fetch(url + tracePath);
  expect(traceResponse.status).toBe(200);
  expect(traceResponse.headers.get("content-type")).toContain("application/zip");
});

test("cannot run an unsaved or arbitrary path, or access nonexistent report", async () => {
  const invalid = await fetch(url + "/api/run", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "../../examples/add-task.json", baseURL: "http://127.0.0.1:3000" }),
  });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({ error: expect.stringContaining("Invalid approved test") });
  const notFound = await fetch(url + "/api/runs/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/report.json");
  expect(notFound.status).toBe(404);
});

test("review server rejects malformed instructions and off-origin writes", async () => {
  const invalid = await fetch(url + "/api/generate", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseURL: "http://127.0.0.1:3000", provider: "groq", requirements: "" }),
  });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({ error: expect.stringContaining("Enter a test instruction") });
  const forbidden = await fetch(url + "/api/save", {
    method: "POST", headers: {
      "Content-Type": "application/json",
      Origin: "https://another-website.example",
    }, body: JSON.stringify({}),
  });
  expect(forbidden.status).toBe(403);
});
