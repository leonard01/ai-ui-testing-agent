import { test, expect } from "@playwright/test";
// The app runner owns traces for its test contexts; avoid harness tracing twice.
test.use({ trace: "off" });
import { createReviewServer } from "../src/review-server.js";
import { GroqProviderError } from "../src/hosted-providers.js";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
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
  await expect(page.locator("#saved")).toContainText("Saved and ready to execute");
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
    data: { definition: ambiguous, baseURL: "http://127.0.0.1:3000" },
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
  const files = await readdir(outputDir);
  const original = JSON.parse(await readFile(join(outputDir, saved.id), "utf8"));
  const repaired = JSON.parse(await readFile(join(outputDir, newFile), "utf8"));
  expect(original.steps[5].action.target.value).toBe("Complete");
  expect(repaired.steps[5].action.target).toEqual({
    by: "intent", value: "Complete preparing a presentation", role: "checkbox",
  });
  expect(repaired.steps[6].action.expected).toBe("2 tasks, 1 completed");
  expect(repaired.steps[8].action.expected).toBe("1 task, 1 completed");
  expect(files).toContain(newFile);
  expect(files).toContain(saved.id);
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
