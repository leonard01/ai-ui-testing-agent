import { test, expect } from "@playwright/test";
// The app runner owns traces for its test contexts; avoid harness tracing twice.
test.use({ trace: "off" });
import { createReviewServer } from "../src/review-server.js";
import { GroqProviderError } from "../src/hosted-providers.js";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { approvedPath, listApprovedIds } from "./helpers/saved-files.js";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

let server: Server;
let url: string;
let outputDir: string;
test.beforeAll(async ({ browser }) => {
  outputDir = await mkdtemp(join(tmpdir(), "ui-review-"));
  server = await createReviewServer(outputDir, browser);
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
  await page.locator("#test-name").fill("Add, complete and delete a task");
}

test("read-only selector preflight suggests an Add button when generated label is wrong", async ({ page }) => {
  await generateFixture(page);
  const addStep = page.locator(".step").nth(3);
  await addStep.getByRole("button", { name: "Edit fields" }).click();
  await addStep.getByLabel("Locator strategy").selectOption("label");
  await addStep.getByRole("button", { name: "Apply changes" }).click();

  await page.getByRole("button", { name: "Check selectors (read-only)" }).click();
  await expect(page.locator("#selector-preflight-status")).toContainText(
    "Selector check complete", { timeout: 20_000 });
  await expect(page.locator("#selector-preflight-results")).toContainText(
    'button named "Add"');
  await expect(page.locator("#selector-preflight-results")).toContainText("Step 4 (warning)");
  await expect(page.locator("#selector-preflight-results")).toContainText("deferred");
  // Preflight did not auto-confirm any step, save, change expectations or run a test.
  await expect(page.locator("#save")).toBeDisabled();
  await expect(page.locator("#saved")).toBeEmpty();
  await expect(page.locator("#run-status")).toContainText("Select an approved test");

  await addStep.getByRole("button", { name: "Edit fields" }).click();
  await addStep.getByLabel("Locator strategy").selectOption("role");
  await addStep.getByRole("button", { name: "Apply changes" }).click();
  await expect(page.locator("#selector-preflight-status")).toBeEmpty();
  await page.getByRole("button", { name: "Check selectors (read-only)" }).click();
  await expect(page.locator("#selector-preflight-status")).toContainText(
    "Selector check complete", { timeout: 20_000 });
  await expect(page.locator("#selector-preflight-results")).not.toContainText(
    'a different locator does match: button named "Add"');
});

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
  const files = await listApprovedIds(outputDir);
  expect(files).toHaveLength(1);
  const draft = JSON.parse(await readFile(await approvedPath(outputDir, files[0]), "utf8"));
  expect(draft.steps).toHaveLength(9);
  expect(draft.steps.every((step: { action: { provenance?: string } }) =>
    step.action.provenance !== "human-confirmed",
  )).toBe(true);
});

test("Add All explicitly confirms every proposed step without auto-saving or hiding individual review", async ({ page }) => {
  const previouslySaved = (await listApprovedIds(outputDir)).length;
  await generateFixture(page);
  const addAll = page.getByRole("button", { name: "Add All", exact: true });
  const save = page.getByRole("button", { name: "Approve and save JSON test" });
  await expect(addAll).toBeEnabled();
  await expect(save).toBeDisabled();
  await expect(page.locator("#review-progress")).toHaveText("0 of 9 steps confirmed");

  // Confirm one step manually, then bulk-confirm the rest. This must not
  // mutate definitions, save to disk, execute tests or map requirements.
  await page.locator(".step input[type=checkbox]").first().check();
  await expect(page.locator("#review-progress")).toHaveText("1 of 9 steps confirmed");
  await addAll.click();
  await expect(page.locator(".step input[type=checkbox]:checked")).toHaveCount(9);
  await expect(page.locator("#review-progress")).toHaveText("9 of 9 steps confirmed");
  await expect(addAll).toBeDisabled();
  await expect(save).toBeEnabled();
  await expect(page.locator("#saved")).toBeEmpty();
  expect(await listApprovedIds(outputDir)).toHaveLength(previouslySaved);

  // Individual checks remain editable, and changing a step requires
  // confirmation again: bulk approval is not permanent or automatic.
  await page.locator(".step input[type=checkbox]").nth(2).uncheck();
  await expect(save).toBeDisabled();
  await expect(addAll).toBeEnabled();
  await addAll.click();
  const step = page.locator(".step").nth(3);
  await step.getByRole("button", { name: "Edit fields" }).click();
  await step.getByRole("button", { name: "Apply changes" }).click();
  await expect(page.locator("#review-progress")).toHaveText("8 of 9 steps confirmed");
  await expect(save).toBeDisabled();
  await addAll.click();
  await expect(page.locator("#review-progress")).toHaveText("9 of 9 steps confirmed");

  await save.click();
  await expect(page.locator("#saved")).toContainText("Saved and ready to execute");
  expect(await listApprovedIds(outputDir)).toHaveLength(previouslySaved + 1);
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
  await page.locator("#test-name").fill("Add, complete and delete a task");
  await page.getByRole("button", { name: "Approve and save JSON test" }).click();
  await expect(page.locator("#saved")).toContainText("Saved and ready to execute");
  const files = await listApprovedIds(outputDir);
  const drafts = await Promise.all(files.map(async (file) => JSON.parse(
    await readFile(await approvedPath(outputDir, file), "utf8"),
  )));
  expect(drafts.some((draft) => draft.steps[2].action.value === "Prepare release")).toBe(true);
  expect(drafts.some((draft) => draft.steps[3].action.target.by === "role" && draft.steps[3].action.target.role === "button" && draft.steps[3].action.target.name === "Add")).toBe(true);
});

async function approveDraft(page: import("@playwright/test").Page) {
  for (const box of await page.locator(".step input[type=checkbox]").all()) await box.check();
  await page.locator("#test-name").fill("Add, complete and delete a task");
  await page.getByRole("button", { name: "Approve and save JSON test" }).click();
  await expect(page.locator("#saved")).toContainText("Saved and ready to execute");
  await expect(page.getByRole("button", { name: "Run selected test" })).toBeEnabled();
}

test("review warns when AI proposes generic checkbox intent across multiple items", async ({ page }) => {
  await generateFixture(page);
  const complete = page.locator(".step").nth(5);
  await complete.getByRole("button", { name: "Edit fields" }).click();
  await complete.getByLabel("Locator strategy").selectOption("intent");
  await complete.getByLabel("Target intention (not a CSS selector)").fill("Complete");
  await complete.getByLabel("Expected role (optional)").selectOption("checkbox");
  await complete.getByRole("button", { name: "Apply changes" }).click();
  await expect(complete).toContainText("Ambiguous target risk");
  await complete.getByRole("button", { name: "Edit fields" }).click();
  await complete.getByLabel("Target intention (not a CSS selector)").fill("Complete Prepare interview");
  await complete.getByRole("button", { name: "Apply changes" }).click();
  await expect(complete).not.toContainText("Ambiguous target risk");
});

test("run approved test from browser and show per-step diagnostics without CLI", async ({ page }) => {
  await generateFixture(page);
  await approveDraft(page);
  await page.getByRole("button", { name: "Run selected test" }).click();
  await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 25_000 });
  const passURL = await page.locator("#run-artifacts a").first().getAttribute("href");
  const passReport = await (await fetch(url + passURL)).json();
  expect(passReport.status, JSON.stringify(passReport, null, 2)).toBe("passed");
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
  const failureURL = await page.locator("#run-artifacts a").first().getAttribute("href");
  const failureReport = await (await fetch(url + failureURL)).json();
  expect(failureReport.status, JSON.stringify(failureReport, null, 2)).toBe("assertion-failed");
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

test("tester reviews dynamic final text assertion, explicitly approves correction and reruns", async ({ page }) => {
  const testDefinition = {
    schemaVersion: 1,
    id: "two-task-final-status",
    title: "Complete presentation, delete documentation and verify final count",
    version: 1,
    steps: [
      { id: "open", description: "Open task list", action: { kind: "navigate", url: "/" } },
      { id: "task1", description: "Enter presentation", action: {
        kind: "fill", target: { by: "role", role: "textbox", name: "Task" },
        value: "preparing a presentation",
      } },
      { id: "add1", description: "Add presentation", action: {
        kind: "click", target: { by: "role", role: "button", name: "Add" },
      } },
      { id: "task2", description: "Enter documentation", action: {
        kind: "fill", target: { by: "role", role: "textbox", name: "Task" },
        value: "reviewing documentation",
      } },
      { id: "add2", description: "Add documentation", action: {
        kind: "click", target: { by: "role", role: "button", name: "Add" },
      } },
      { id: "finish", description: "Complete presentation", action: {
        kind: "click", target: {
          by: "intent", value: "Complete preparing a presentation", role: "checkbox",
        },
      } },
      { id: "verify-two", description: "Two tasks, one completed", action: {
        kind: "assert-text", target: { by: "role", role: "status" },
        expected: "2 tasks, 1 completed", provenance: "requirements",
      } },
      { id: "delete", description: "Delete unfinished documentation", action: {
        kind: "click", target: {
          by: "intent", value: "Delete reviewing documentation", role: "button",
        },
      } },
      { id: "final", description: "Verify only completed presentation remains", action: {
        kind: "assert-text", target: { by: "role", role: "status" },
        expected: "1 tasks, 1 completed", provenance: "requirements",
      } },
    ],
  };
  const savedResponse = await page.request.post(url + "/api/save", {
    data: { testName: "Regression test", definition: testDefinition, baseURL: "http://127.0.0.1:3000" },
  });
  expect(savedResponse.status()).toBe(200);
  const saved = await savedResponse.json();
  await page.goto(url);
  await page.getByLabel("Approved saved test").selectOption(saved.id);
  await page.getByRole("button", { name: "Run selected test" }).click();
  await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 25_000 });
  await expect(page.locator("#run-summary")).toContainText("FAILED");
  const panel = page.locator(".assertion-repair");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Original expected: 1 tasks, 1 completed");
  await expect(panel).toContainText("Observed from run: 1 task, 1 completed");
  const expectedField = panel.getByLabel("New expected text", { exact: true });
  await expect(expectedField).toHaveValue("1 tasks, 1 completed");
  const confirm = panel.getByRole("checkbox", { name: /I verified this new expected text/ });
  const reviseButton = panel.getByRole("button", { name: "Save reviewed assertion and rerun from start" });
  await expect(reviseButton).toBeDisabled();

  const originalReportLink = await page.getByRole("link", { name: "View full JSON report" }).getAttribute("href");
  if (!originalReportLink) throw new Error("Missing run report link");
  const runId = originalReportLink.split("/")[3];
  // No arbitrary changes to a run's expectations without human confirmation.
  const unconfirmed = await page.request.post(url + "/api/repair-assertion", {
    data: { runId, stepId: "final", expected: "1 task, 1 completed", confirmed: false },
  });
  expect(unconfirmed.status()).toBe(400);
  expect(await unconfirmed.json()).toMatchObject({
    error: expect.stringContaining("explicitly confirm"),
  });
  const notFailed = await page.request.post(url + "/api/repair-assertion", {
    data: { runId, stepId: "verify-two", expected: "2 tasks, 0 completed", confirmed: true },
  });
  expect(notFailed.status()).toBe(400);

  await panel.getByRole("button", { name: "Use observed text as draft" }).click();
  await expect(expectedField).toHaveValue("1 task, 1 completed");
  await expect(reviseButton).toBeDisabled();
  await confirm.check();
  await expect(reviseButton).toBeEnabled();
  const original = JSON.parse(await readFile(await approvedPath(outputDir, saved.id), "utf8"));
  await reviseButton.click();
  await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 25_000 });
  await expect(page.locator("#run-summary")).toContainText("PASSED");
  const revisedId = await page.getByLabel("Approved saved test").inputValue();
  expect(revisedId).not.toBe(saved.id);
  expect((await listApprovedIds(outputDir)).includes(saved.id)).toBe(false);
  await expect(page.locator("#approved-tests option[value='" + saved.id + "']")).toHaveCount(0);
  expect((await page.request.get(url + originalReportLink)).status()).toBe(404);
  const revised = JSON.parse(await readFile(await approvedPath(outputDir, revisedId), "utf8"));
  expect(original.steps[8].action).toMatchObject({
    expected: "1 tasks, 1 completed", provenance: "requirements",
  });
  expect(revised.steps[8].action).toMatchObject({
    expected: "1 task, 1 completed", provenance: "human-confirmed",
  });
  expect(revised.steps.slice(0, 8)).toEqual(original.steps.slice(0, 8));
  const reportLink = await page.getByRole("link", { name: "View full JSON report" }).getAttribute("href");
  const report = await (await fetch(url + reportLink)).json();
  expect(report.status).toBe("passed");
  expect(report.steps[8]).toMatchObject({
    status: "passed", expected: "1 task, 1 completed",
    observed: "1 task, 1 completed",
  });
});

test("saved test can be loaded, edited and resaved entirely via the review UI", async ({ page }) => {
  await generateFixture(page);
  await approveDraft(page);
  const originalId = await page.getByLabel("Approved saved test").inputValue();
  expect(originalId).toMatch(/^reviewed-/);
  await expect(page.getByRole("button", { name: "Edit selected saved test in review form" })).toBeEnabled();
  const original = JSON.parse(await readFile(await approvedPath(outputDir, originalId), "utf8"));
  const beforeList = (await (await page.request.get(url + "/api/tests")).json()).tests;
  // A malformed replacement must never remove the source file.
  const rejected = await page.request.post(url + "/api/save", {
    data: { testName: "Regression test", definition: { ...original, schemaVersion: 17 },
      baseURL: "http://127.0.0.1:3000", replaceId: originalId },
  });
  expect(rejected.status()).toBe(400);
  expect((await listApprovedIds(outputDir)).includes(originalId)).toBe(true);
  await page.getByRole("button", { name: "Edit selected saved test in review form" }).click();
  await expect(page.locator("#draft-hint")).toContainText("Loaded an approved test for editing");
  await expect(page.locator(".step")).toHaveCount(9);
  await expect(page.getByRole("button", { name: "Approve and save JSON test" })).toBeDisabled();
  const fourth = page.locator(".step").nth(3);
  await fourth.getByRole("button", { name: "Edit fields" }).click();
  await fourth.getByLabel("Description").fill("Add a task via the button");
  await fourth.getByRole("button", { name: "Apply changes" }).click();
  await expect(fourth).toContainText("Add a task via the button");
  for (const box of await page.locator(".step input[type=checkbox]").all()) {
    await box.check();
  }
  await page.locator("#test-name").fill("Add, complete and delete a task");
  await page.getByRole("button", { name: "Approve and save JSON test" }).click();
  await expect(page.locator("#saved")).toContainText("old version removed from the list");
  const revisedId = await page.getByLabel("Approved saved test").inputValue();
  expect(revisedId).not.toBe(originalId);
  await expect(page.locator("#approved-tests option[value='" + originalId + "']")).toHaveCount(0);
  await expect(page.locator("#approved-tests option[value='" + revisedId + "']")).toHaveCount(1);
  const afterList = (await (await page.request.get(url + "/api/tests")).json()).tests;
  expect(afterList.length).toBe(beforeList.length);
  await expect.poll(async () => (await listApprovedIds(outputDir)).includes(originalId)).toBe(false);
  const revised = JSON.parse(await readFile(await approvedPath(outputDir, revisedId), "utf8"));
  expect(original.steps[3].description).not.toBe("Add a task via the button");
  expect(revised.steps[3].description).toBe("Add a task via the button");
  expect(revised.steps[3].action).toEqual(original.steps[3].action);
  await page.getByRole("button", { name: "Run selected test" }).click();
  await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 30000 });
  await expect(page.locator("#run-summary")).toContainText("PASSED");
});

test("editable DOM search works with no initial suggestions and cannot silently fix expectation", async ({ page }) => {
  const site = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end('<!doctype html><body><div>Sauce Labs Backpack</div>' +
      '<button>Add to cart</button></body>');
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const baseURL = "http://127.0.0.1:" + (site.address() as AddressInfo).port;
  try {
    const definition = { schemaVersion: 1, id: "must-not-auto-pass",
      title: "Missing expected product", version: 1, steps: [
        { id: "open", description: "Open", action: { kind: "navigate", url: "/" } },
        { id: "missing", description: "Check incorrect expectation", action: {
          kind: "assert-text", target: { by: "role", role: "button", name: "Add to cart" },
          expected: "Sauce Labs Laptop", provenance: "requirements",
        } },
      ],
    };
    const savedResponse = await page.request.post(url + "/api/save", {
      data: { testName: "Regression test", definition, baseURL },
    });
    expect(savedResponse.status()).toBe(200);
    const saved = await savedResponse.json();
    await page.goto(url);
    // The one-script dropdown is intentionally scoped to the chosen website.
    await page.getByLabel("Test suite (website URL)").selectOption(baseURL);
    await page.getByLabel("Application URL").fill(baseURL);
    await page.getByLabel("Approved saved test").selectOption(saved.id);
    await page.getByRole("button", { name: "Run selected test" }).click();
    await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 30000 });
    await expect(page.locator("#run-summary")).toContainText("FAILED");
    const picker = page.locator(".run-step").nth(1).locator(".assertion-dom-repair");
    await expect(picker).toBeVisible();
    await expect(picker.locator(".assertion-dom-option")).toHaveCount(0);
    const field = picker.getByLabel("Search visible DOM text");
    await expect(field).toHaveValue("Sauce Labs Laptop");
    await field.fill("Backpack");
    await picker.getByRole("button", { name: "Search captured DOM" }).click();
    await expect(picker.locator(".assertion-dom-option")).toHaveCount(1);
    await expect(picker).toContainText("Sauce Labs Backpack");
    await picker.locator('input[type="radio"]').check();
    await picker.getByRole("button", { name: "Save corrected assertion target and rerun" }).click();
    await expect.poll(async () =>
      page.getByLabel("Approved saved test").inputValue(), { timeout: 30000 },
    ).not.toBe(saved.id);
    await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 30000 });
    await expect(page.locator("#run-summary")).toContainText("FAILED");
    const currentId = await page.getByLabel("Approved saved test").inputValue();
    expect((await listApprovedIds(outputDir)).includes(saved.id)).toBe(false);
    const amended = JSON.parse(await readFile(await approvedPath(outputDir, currentId), "utf8"));
    expect(amended.steps[1].action).toEqual({
      kind: "assert-text", target: { by: "text", value: "Sauce Labs Backpack" },
      expected: "Sauce Labs Laptop", provenance: "requirements",
    });
    await expect(page.locator(".run-step").nth(1)).toContainText('expected "Sauce Labs Laptop"');
    await expect(page.locator(".run-step").nth(1)).toContainText('observed "Sauce Labs Backpack"');
  } finally {
    await new Promise<void>((resolve, reject) =>
      site.close((error) => error ? reject(error) : resolve()));
  }
});

test("wrong existing button text assertion searches product div and repairs selector via UI", async ({ page }) => {
  const site = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end('<!doctype html><html><title>Shop</title><main>' +
      '<div class="inventory_details_name large_size">Sauce Labs Backpack</div>' +
      '<button type="button">Add to cart</button>' +
      '<div class="inventory_details_price">$29.99</div></main></html>');
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const baseURL = "http://127.0.0.1:" + (site.address() as AddressInfo).port;
  try {
    const definition = {
      schemaVersion: 1, id: "saucedemo-wrong-selector", title: "Backpack detail",
      version: 1, steps: [
        { id: "open", description: "Open product page", action: { kind: "navigate", url: "/" } },
        { id: "backpack", description: "Confirm backpack product name", action: {
          kind: "assert-text",
          target: { by: "role", role: "button", name: "Add to cart" },
          expected: "Sauce Labs Backpack", provenance: "requirements",
        } },
      ],
    };
    const resp = await page.request.post(url + "/api/save", {
      data: { testName: "Regression test", definition, baseURL },
    });
    expect(resp.status(), await resp.text()).toBe(200);
    const saved = await resp.json();
    const original = JSON.parse(await readFile(await approvedPath(outputDir, saved.id), "utf8"));
    await page.goto(url);
    // The one-script dropdown is intentionally scoped to the chosen website.
    await page.getByLabel("Test suite (website URL)").selectOption(baseURL);
    await page.getByLabel("Application URL").fill(baseURL);
    await page.getByLabel("Approved saved test").selectOption(saved.id);
    await page.getByRole("button", { name: "Run selected test" }).click();
    await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 30000 });
    await expect(page.locator("#run-summary")).toContainText("FAILED");
    const failed = page.locator(".run-step").nth(1);
    await expect(failed).toContainText('expected "Sauce Labs Backpack"');
    await expect(failed).toContainText('observed "Add to cart"');
    const picker = failed.locator(".assertion-dom-repair");
    await expect(picker).toBeVisible();
    await expect(picker).toContainText('Sauce Labs Backpack');
    await expect(picker).toContainText('<div>');
    await expect(picker.locator(".assertion-dom-option")).toHaveCount(1);
    await expect(picker).toContainText('Visible text "Sauce Labs Backpack"');
    const button = picker.getByRole("button", { name: "Save corrected assertion target and rerun" });
    await expect(button).toBeDisabled();
    const link = await page.getByRole("link", { name: "View full JSON report" }).getAttribute("href");
    if (!link) throw new Error("Missing failed report");
    const report = await (await fetch(url + link)).json();
    expect(report.steps[1]).toMatchObject({
      status: "assertion-failed",
      expected: "Sauce Labs Backpack",
      observed: "Add to cart",
      assertionAlternatives: {
        query: "Sauce Labs Backpack",
        attempted: { by: "role", role: "button", name: "Add to cart" },
        total: 1,
        candidates: [{ tag: "div", target: { by: "text", value: "Sauce Labs Backpack" } }],
      },
    });
    const runId = link.split("/")[3];
    const wrongStep = await page.request.post(url + "/api/repair-assertion-target", {
      data: { runId, stepId: "open", candidateIndex: 0 },
    });
    expect(wrongStep.status()).toBe(400);
    const invalidIndex = await page.request.post(url + "/api/repair-assertion-target", {
      data: { runId, stepId: "backpack", candidateIndex: 17 },
    });
    expect(invalidIndex.status()).toBe(400);

    const searchField = picker.getByLabel("Search visible DOM text");
    const search = picker.getByRole("button", { name: "Search captured DOM" });
    await expect(searchField).toHaveValue("Sauce Labs Backpack");
    // The tester can search for DIFFERENT page text without changing the
    // expected assertion or replaying navigation/product actions.
    await searchField.fill("Add to cart");
    await search.click();
    await expect(picker.locator(".assertion-dom-option")).toHaveCount(1);
    await expect(picker.locator(".assertion-dom-option")).toContainText(['button named "Add to cart"']);
    const afterWrongSearch = await page.request.get(url + link);
    const wrongSearchReport = await afterWrongSearch.json();
    expect(wrongSearchReport.steps[1].expected).toBe("Sauce Labs Backpack");

    await searchField.fill("backpack");
    await search.click();
    await expect(picker.locator(".assertion-dom-option")).toHaveCount(1);
    await expect(picker).toContainText('Visible text "Sauce Labs Backpack"');
    const afterSearch = await (await page.request.get(url + link)).json();
    expect(afterSearch.steps[1].assertionAlternatives).toMatchObject({
      query: "backpack", searched: true, total: 1,
    });
    const missingSearchToken = await page.request.post(url + "/api/repair-assertion-target", {
      data: { runId, stepId: "backpack", candidateIndex: 0 },
    });
    expect(missingSearchToken.status()).toBe(400);
    await searchField.fill("no such product");
    await search.click();
    await expect(picker.locator(".assertion-dom-option")).toHaveCount(0);
    await expect(picker).toContainText("No uniquely identifiable visible text matched");
    await expect(button).toBeDisabled();
    await searchField.fill("Backpack");
    await search.click();
    await expect(picker.locator(".assertion-dom-option")).toHaveCount(1);
    await picker.locator('input[type="radio"]').check();
    await expect(button).toBeEnabled();
    await button.click();
    await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 30000 });
    await expect(page.locator("#run-summary")).toContainText("PASSED");
    const revisedId = await page.getByLabel("Approved saved test").inputValue();
    expect(revisedId).not.toBe(saved.id);
    expect((await listApprovedIds(outputDir)).includes(saved.id)).toBe(false);
    const revised = JSON.parse(await readFile(await approvedPath(outputDir, revisedId), "utf8"));
    expect(revised.steps[0]).toEqual(original.steps[0]);
    expect(revised.steps[1].action).toEqual({
      kind: "assert-text",
      target: { by: "text", value: "Sauce Labs Backpack" },
      expected: "Sauce Labs Backpack",
      provenance: "requirements",
    });
    expect((await page.request.get(url + link)).status()).toBe(404);
    const reportLink = await page.getByRole("link", { name: "View full JSON report" }).getAttribute("href");
    const finalReport = await (await fetch(url + reportLink)).json();
    expect(finalReport.status).toBe("passed");
    expect(finalReport.steps[1]).toMatchObject({
      status: "passed", expected: "Sauce Labs Backpack", observed: "Sauce Labs Backpack",
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      site.close((error) => error ? reject(error) : resolve()));
  }
});

test("live DOM Products text repairs missing heading assertion through UI, then reruns", async ({ page }) => {
  // Mirrors real-world inventory markup: "Products" is a visible span,
  // not an accessible heading. No SauceDemo network access is needed in CI.
  const external = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end('<!doctype html><html><title>Shop</title><main>' +
      '<div class="inventory_header"><span class="title">Products</span></div>' +
      '<div>Welcome to the inventory</div></main></html>');
  });
  await new Promise<void>((resolve) => external.listen(0, "127.0.0.1", resolve));
  const baseURL = "http://127.0.0.1:" + (external.address() as AddressInfo).port;
  try {
    const definition = {
      schemaVersion: 1, id: "shop-products-assertion", title: "Products page",
      version: 1, steps: [
        { id: "navigate", description: "Open shop", action: {
          kind: "navigate", url: "/",
        } },
        { id: "products", description: "Verify Products heading", action: {
          kind: "assert-visible",
          target: { by: "role", role: "heading", name: "Products" },
          provenance: "requirements",
        } },
      ],
    };
    const savedResponse = await page.request.post(url + "/api/save", {
      data: { testName: "Regression test", definition, baseURL },
    });
    expect(savedResponse.status(), await savedResponse.text()).toBe(200);
    const saved = await savedResponse.json();
    const original = JSON.parse(await readFile(await approvedPath(outputDir, saved.id), "utf8"));
    await page.goto(url);
    // The one-script dropdown is intentionally scoped to the chosen website.
    await page.getByLabel("Test suite (website URL)").selectOption(baseURL);
    await page.getByLabel("Application URL").fill(baseURL);
    await page.getByLabel("Approved saved test").selectOption(saved.id);
    await page.getByRole("button", { name: "Run selected test" }).click();
    await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 25_000 });
    await expect(page.locator("#run-summary")).toContainText("FAILED");
    const failed = page.locator(".run-step").nth(1);
    await expect(failed).toContainText("getByRole('heading'");
    const picker = failed.locator(".assertion-dom-repair");
    await expect(picker).toBeVisible();
    await expect(picker).toContainText('Products');
    await expect(picker).toContainText('<span>');
    await expect(picker.locator(".assertion-dom-option")).toHaveCount(1);
    await expect(picker).toContainText('Visible text "Products"');
    const action = picker.getByRole("button", { name: "Save corrected assertion target and rerun" });
    await expect(action).toBeDisabled();

    const reportLink = await page.getByRole("link", { name: "View full JSON report" }).getAttribute("href");
    if (!reportLink) throw new Error("Missing report link");
    const report = await (await fetch(url + reportLink)).json();
    expect(report.steps[1].assertionAlternatives).toMatchObject({
      attempted: { by: "role", role: "heading", name: "Products" },
      query: "Products", total: 1,
      candidates: [{
        tag: "span", name: "Products",
        target: { by: "text", value: "Products" },
      }],
    });
    const runId = reportLink.split("/")[3];
    const invalidStep = await page.request.post(url + "/api/repair-assertion-target", {
      data: { runId, stepId: "navigate", candidateIndex: 0 },
    });
    expect(invalidStep.status()).toBe(400);
    const invalidChoice = await page.request.post(url + "/api/repair-assertion-target", {
      data: { runId, stepId: "products", candidateIndex: 99 },
    });
    expect(invalidChoice.status()).toBe(400);
    // No candidate may be applied without explicit selection in the UI.
    await picker.locator('input[type="radio"]').check();
    await expect(action).toBeEnabled();
    await action.click();
    await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 25_000 });
    await expect(page.locator("#run-summary")).toContainText("PASSED");
    const correctedId = await page.getByLabel("Approved saved test").inputValue();
    expect(correctedId).not.toBe(saved.id);
    const amended = JSON.parse(await readFile(await approvedPath(outputDir, correctedId), "utf8"));
    expect(original.steps[1].action.target).toEqual({
      by: "role", role: "heading", name: "Products",
    });
    expect(amended.steps[1].action).toEqual({
      kind: "assert-visible", target: { by: "text", value: "Products" },
      provenance: "requirements",
    });
    expect(amended.steps[0]).toEqual(original.steps[0]);
    expect((await listApprovedIds(outputDir)).includes(saved.id)).toBe(false);
    await expect(page.locator("#approved-tests option[value='" + saved.id + "']")).toHaveCount(0);
    expect((await page.request.get(url + reportLink)).status()).toBe(404);
    const latest = await page.getByRole("link", { name: "View full JSON report" }).getAttribute("href");
    const passed = await (await fetch(url + latest)).json();
    expect(passed.steps.map((step: { status: string }) => step.status)).toEqual(["passed", "passed"]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      external.close((error) => error ? reject(error) : resolve()));
  }
});

test("missing Add label exposes live Add button for UI-only repair and complete rerun", async ({ page }) => {
  const definition = JSON.parse(await readFile("examples/add-task.json", "utf8"));
  definition.id = "test-one-missing-add";
  definition.title = "Buy groceries task lifecycle";
  for (const step of definition.steps) {
    step.description = step.description.replaceAll("Prepare interview", "Buy groceries");
    if (typeof step.action.value === "string") {
      step.action.value = step.action.value.replaceAll("Prepare interview", "Buy groceries");
    }
    const target = step.action.target;
    if (target?.name) target.name = target.name.replaceAll("Prepare interview", "Buy groceries");
    if (target?.value) target.value = target.value.replaceAll("Prepare interview", "Buy groceries");
  }
  definition.steps[3].action.target = { by: "label", value: "Add" };
  const savedResponse = await page.request.post(url + "/api/save", {
    data: { testName: "Regression test", definition, baseURL: "http://127.0.0.1:3000" },
  });
  expect(savedResponse.status(), await savedResponse.text()).toBe(200);
  const saved = await savedResponse.json();
  const original = JSON.parse(await readFile(await approvedPath(outputDir, saved.id), "utf8"));
  await page.goto(url);
  await page.getByLabel("Approved saved test").selectOption(saved.id);
  await page.getByRole("button", { name: "Run selected test" }).click();
  await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 30_000 });
  await expect(page.locator("#run-summary")).toContainText("FAILED");
  const failed = page.locator(".run-step").nth(3);
  await expect(failed).toContainText("getByLabel('Add'");
  const repair = failed.locator(".locator-repair");
  await expect(repair).toBeVisible();
  await expect(repair).toContainText("Failed locator: field labelled \"Add\"");
  await expect(repair.locator(".locator-option")).toHaveCount(1);
  await expect(repair).toContainText("button named Add");
  const save = repair.getByRole("button", { name: "Save corrected locator and rerun from start" });
  await expect(save).toBeDisabled();
  const reportLink = await page.getByRole("link", { name: "View full JSON report" }).getAttribute("href");
  if (!reportLink) throw new Error("Missing report link");
  const report = await (await fetch(url + reportLink)).json();
  expect(report.steps[3].locatorAlternatives).toMatchObject({
    attempted: { by: "label", value: "Add" },
    total: 1,
    candidates: [{ role: "button", name: "Add" }],
  });
  const runId = reportLink.split("/")[3];
  const tampered = await page.request.post(url + "/api/repair-target", {
    data: { runId, stepId: "enter", candidateIndex: 0 },
  });
  expect(tampered.status()).toBe(400);
  const outOfRange = await page.request.post(url + "/api/repair-target", {
    data: { runId, stepId: "add", candidateIndex: 99 },
  });
  expect(outOfRange.status()).toBe(400);

  await repair.locator(".locator-option input[type=radio]").check();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 30_000 });
  await expect(page.locator("#run-summary")).toContainText("PASSED");
  const correctedId = await page.getByLabel("Approved saved test").inputValue();
  expect(correctedId).not.toBe(saved.id);
  expect((await listApprovedIds(outputDir)).includes(saved.id)).toBe(false);
  await expect(page.locator("#approved-tests option[value='" + saved.id + "']")).toHaveCount(0);
  const discarded = await page.request.get(url + reportLink);
  expect(discarded.status()).toBe(404);
  const corrected = JSON.parse(await readFile(await approvedPath(outputDir, correctedId), "utf8"));
  expect(original.steps[3].action.target).toEqual({ by: "label", value: "Add" });
  expect(corrected.steps[3].action.target).toEqual({
    by: "role", role: "button", name: "Add",
  });
  expect(corrected.steps.filter((step: { id: string }) => step.id !== "add"))
    .toEqual(original.steps.filter((step: { id: string }) => step.id !== "add"));
  const finalReportLink = await page.getByRole("link", { name: "View full JSON report" }).getAttribute("href");
  const final = await (await fetch(url + finalReportLink)).json();
  expect(final.status).toBe("passed");
  expect(final.steps.every((step: { status: string }) => step.status === "passed")).toBe(true);
});

test("human chooses among live checkbox candidates; repaired copy reruns successfully", async ({ page }) => {
  const ambiguous = {
    schemaVersion: 1,
    id: "two-task-choice",
    title: "Complete only the presentation task",
    version: 1,
    steps: [
      { id: "open", description: "Open task list", action: { kind: "navigate", url: "/" } },
      { id: "task1", description: "Enter presentation", action: {
        kind: "fill", target: { by: "role", role: "textbox", name: "Task" },
        value: "preparing a presentation",
      } },
      { id: "add1", description: "Add presentation", action: {
        kind: "click", target: { by: "role", role: "button", name: "Add" },
      } },
      { id: "task2", description: "Enter documentation", action: {
        kind: "fill", target: { by: "role", role: "textbox", name: "Task" },
        value: "reviewing documentation",
      } },
      { id: "add2", description: "Add documentation", action: {
        kind: "click", target: { by: "role", role: "button", name: "Add" },
      } },
      { id: "finish", description: "Complete the presentation task", action: {
        kind: "click", target: { by: "intent", value: "Complete", role: "checkbox" },
      } },
      { id: "verify", description: "Check completed count", action: {
        kind: "assert-text", target: { by: "role", role: "status" },
        expected: "2 tasks, 1 completed", provenance: "requirements",
      } },
      { id: "delete", description: "Remove unfinished documentation task", action: {
        kind: "click", target: { by: "intent", value: "Delete reviewing documentation", role: "button" },
      } },
      { id: "final", description: "Only presentation remains", action: {
        kind: "assert-text", target: { by: "role", role: "status" },
        expected: "1 task, 1 completed", provenance: "requirements",
      } },
    ],
  };
  const savedResponse = await page.request.post(url + "/api/save", {
    data: { testName: "Regression test", definition: ambiguous, baseURL: "http://127.0.0.1:3000" },
  });
  expect(savedResponse.status()).toBe(200);
  const saved = await savedResponse.json();
  await page.goto(url);
  await page.getByLabel("Approved saved test").selectOption(saved.id);
  await page.getByRole("button", { name: "Run selected test" }).click();
  await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 25000 });
  await expect(page.locator(".repair-choice")).toBeVisible();
  await expect(page.locator(".repair-option")).toHaveCount(2);
  const radio = page.locator(".repair-option")
    .filter({ hasText: "Complete preparing a presentation" })
    .locator('input[type="radio"]');
  await radio.check();
  const firstRun = await page.getByRole("link", { name: "View full JSON report" }).getAttribute("href");
  if (!firstRun) throw new Error("Missing report link");
  const original = JSON.parse(await readFile(await approvedPath(outputDir, saved.id), "utf8"));
  const originalReport = await (await fetch(url + firstRun)).json();
  const failingStep = originalReport.steps.find((step: { id: string }) => step.id === "finish");
  expect(failingStep.status).toBe("execution-error");
  expect(failingStep.ambiguity.candidates).toHaveLength(2);
  expect(failingStep.ambiguity.intent).toBe("Complete");

  // The repair endpoint must reject arbitrary candidate indices even on valid runs.
  const rejected = await page.request.post(url + "/api/repair", {
    data: { runId: firstRun.split("/")[3], candidateIndex: 99 },
  });
  expect(rejected.status()).toBe(400);

  await page.getByRole("button", { name: "Save corrected copy and rerun from start" }).click();
  await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 25000 });
  await expect(page.locator("#run-summary")).toContainText("PASSED");
  const newFile = await page.getByLabel("Approved saved test").inputValue();
  expect(newFile).not.toBe(saved.id);
  const files = await listApprovedIds(outputDir);
  const repaired = JSON.parse(await readFile(await approvedPath(outputDir, newFile), "utf8"));
  expect(original.steps[5].action.target.value).toBe("Complete");
  expect(repaired.steps[5].action.target).toEqual({
    by: "intent", value: "Complete preparing a presentation", role: "checkbox",
  });
  expect(repaired.steps[6].action.expected).toBe("2 tasks, 1 completed");
  expect(repaired.steps[8].action.expected).toBe("1 task, 1 completed");
  expect(files).toContain(newFile);
  expect(files).not.toContain(saved.id);
  await expect(page.locator("#approved-tests option[value='" + saved.id + "']")).toHaveCount(0);
  expect((await page.request.get(url + firstRun)).status()).toBe(404);
  const finalReportURL = await page.getByRole("link", { name: "View full JSON report" }).getAttribute("href");
  const finalReport = await (await fetch(url + finalReportURL)).json();
  expect(finalReport.status).toBe("passed");
  expect(finalReport.steps[5].resolution.name).toBe("Complete preparing a presentation");
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

test("Test 1 repairs string-valued steps with one extra mocked Groq call", async ({ page, browser }) => {
  const valid = JSON.parse(await readFile("examples/add-task.json", "utf8"));
  valid.id = "groq-test-one";
  valid.title = "Buy groceries task lifecycle";
  for (const step of valid.steps) {
    step.description = step.description.replaceAll("Prepare interview", "Buy groceries");
    if (step.action.value) step.action.value = step.action.value.replaceAll("Prepare interview", "Buy groceries");
    if (step.action.target?.name) {
      step.action.target.name = step.action.target.name.replaceAll("Prepare interview", "Buy groceries");
    }
    if (step.action.target?.value) {
      step.action.target.value = step.action.target.value.replaceAll("Prepare interview", "Buy groceries");
    }
    if (step.action.provenance === "human-confirmed") step.action.provenance = "requirements";
  }
  const malformed = {
    ...valid,
    steps: Array.from({ length: 13 }, (_, index) =>
      [4, 6, 8, 10, 12].includes(index)
        ? "Verify a task count" : structuredClone(valid.steps[index % 9]),
    ),
  };
  const prompts: string[] = [];
  const mock = async ({ prompt }: { prompt: string }) => {
    prompts.push(prompt);
    return JSON.stringify(prompts.length === 1 ? malformed : valid);
  };
  const temporary = await createReviewServer(outputDir, browser, mock);
  await new Promise<void>((resolve) => temporary.listen(0, "127.0.0.1", resolve));
  const tempURL = "http://127.0.0.1:" + (temporary.address() as AddressInfo).port;
  try {
    await page.goto(tempURL);
    await page.getByLabel("Your test instructions").fill(
      'Open the task list, add "Buy groceries", complete it, delete it and verify each count.',
    );
    await page.getByRole("button", { name: "Generate draft" }).click();
    await expect(page.locator("#generation-status")).toContainText("Draft ready", { timeout: 25000 });
    await expect(page.locator("#generation-status")).toContainText("One extra AI call");
    await expect(page.locator("#generation-error")).toBeEmpty();
    await expect(page.locator(".step")).toHaveCount(9);
    await expect(page.locator("#draft-hint")).toContainText("first AI draft was invalid");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("steps[4]");
    expect(prompts[1]).toContain("expected object, received string");
    expect(prompts[1]).toContain("COMPLETE test definition");
    await expect(page.getByRole("button", { name: "Approve and save JSON test" })).toBeDisabled();
  } finally {
    await new Promise<void>((resolve, reject) =>
      temporary.close((err) => err ? reject(err) : resolve()));
  }
});

test("two malformed responses stop after one bounded retry with safe step diagnostics", async ({ page, browser }) => {
  const mockOutput = JSON.stringify({
    schemaVersion: 1, id: "invalid-test", title: "Invalid output", version: 1,
    steps: [
      { id: "open", description: "Open", action: { kind: "navigate", url: "/" } },
      "Verify task count",
      { id: "status", description: "Check count", action: {
        kind: "assert-text", target: { by: "role", role: "status" },
        expected: "0 tasks, 0 completed", provenance: "requirements",
      } },
    ],
  });
  let calls = 0;
  const temporary = await createReviewServer(outputDir, browser, async () => {
    calls++;
    return mockOutput;
  });
  await new Promise<void>((resolve) => temporary.listen(0, "127.0.0.1", resolve));
  const tempURL = "http://127.0.0.1:" + (temporary.address() as AddressInfo).port;
  try {
    await page.goto(tempURL);
    await page.getByLabel("Your test instructions").fill("Open and verify initial task count");
    await page.getByRole("button", { name: "Generate draft" }).click();
    await expect(page.locator("#generation-error")).toContainText("schema-validation", { timeout: 25000 });
    await expect(page.locator("#generation-error")).toContainText("steps[1]: expected object, received string");
    await expect(page.locator("#generation-error")).toContainText("Attempts: 2");
    expect(calls).toBe(2);
    await expect(page.locator("#draft")).toBeHidden();
  } finally {
    await new Promise<void>((resolve, reject) =>
      temporary.close((err) => err ? reject(err) : resolve()));
  }
});

test("Test 1 Groq upstream 400 is identified correctly in the generator UI without a real model call", async ({ page, browser }) => {
  const testOneInstructions = [
    '1. Open the task list application.',
    '2. Verify that the list initially contains zero tasks.',
    '3. Add a task called "Buy groceries".',
    '4. Verify that "Buy groceries" appears in the task list.',
    '5. Verify that the status reads "1 task, 0 completed".',
    '6. Mark "Buy groceries" as completed.',
    '7. Verify that the status reads "1 task, 1 completed".',
    '8. Delete "Buy groceries".',
    '9. Verify that the status reads "0 tasks, 0 completed".',
  ].join("\n");
  const stubProvider = async () => {
    throw new GroqProviderError(
      400, "json-generation", "json_validate_failed", "invalid_request_error",
      undefined, "Groq could not produce acceptable JSON.",
    );
  };
  const tempServer = await createReviewServer(outputDir, browser, stubProvider);
  await new Promise<void>((resolve) => tempServer.listen(0, "127.0.0.1", resolve));
  const tempURL = "http://127.0.0.1:" + (tempServer.address() as AddressInfo).port;
  try {
    await page.goto(tempURL);
    await page.getByLabel("Your test instructions").fill(testOneInstructions);
    await page.getByRole("button", { name: "Generate draft" }).click();
    await expect(page.locator("#generation-error")).toContainText("GroqCloud rejected the request (provider HTTP 400)", { timeout: 15_000 });
    await expect(page.locator("#generation-error")).toContainText("json_validate_failed");
    await expect(page.locator("#generation-error")).toContainText("json-generation");
    await expect(page.locator("#generation-error")).toContainText(testOneInstructions.length + " characters");
    const providerResponse = await fetch(tempURL + "/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseURL: "http://127.0.0.1:3000",
        requirements: testOneInstructions,
        provider: "groq",
      }),
    });
    expect(providerResponse.status).toBe(502);
    expect(await providerResponse.json()).toMatchObject({
      source: "groqcloud",
      providerStatus: 400,
      category: "json-generation",
      providerCode: "json_validate_failed",
      requirementsCharacters: testOneInstructions.length,
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      tempServer.close((error) => error ? reject(error) : resolve()));
  }
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

test("requires a human test name and offers previous application URLs", async ({ page }) => {
  await generateFixture(page);
  const name = page.getByLabel("Test name (required before saving)");
  const save = page.getByRole("button", { name: "Approve and save JSON test" });
  await name.fill("  ");
  await page.getByRole("button", { name: "Add All", exact: true }).click();
  await expect(save).toBeDisabled();

  await name.fill("SD-001 — Explicit tester name");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.locator("#saved")).toContainText("Saved and ready to execute");
  const savedId = await page.getByLabel("Approved saved test").inputValue();
  const saved = JSON.parse(await readFile(await approvedPath(outputDir, savedId), "utf8"));
  expect(saved.title).toBe("SD-001 — Explicit tester name");

  const previous = page.getByLabel("Choose a previously used application URL");
  await expect(previous.locator("option")).toContainText(["Choose a previous URL (optional)", "http://127.0.0.1:3000/"]);
  await page.locator("#base-url").fill("http://127.0.0.1:9999");
  await previous.selectOption("http://127.0.0.1:3000/");
  await expect(page.locator("#base-url")).toHaveValue("http://127.0.0.1:3000/");
});

test("save API rejects missing or whitespace-only tester names", async ({ page }) => {
  const definition = JSON.parse(await readFile("examples/add-task.json", "utf8"));
  for (const testName of [undefined, "  "]) {
    const response = await page.request.post(url + "/api/save", {
      data: { definition, baseURL: "http://127.0.0.1:3000", testName },
    });
    expect(response.status()).toBe(400);
    expect((await response.json()).error).toContain("Enter a test name");
  }
});
