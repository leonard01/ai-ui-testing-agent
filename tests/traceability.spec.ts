import { test, expect } from "@playwright/test";
import { createReviewServer } from "../src/review-server.js";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { approvedPath } from "./helpers/saved-files.js";
import { tmpdir } from "node:os";
import { type Server } from "node:http";
import type { AddressInfo } from "node:net";

test.use({ trace: "off" });
let dir: string;
let server: Server;
let url: string;

test.beforeEach(async ({ browser }) => {
  dir = await mkdtemp(join(tmpdir(), "ui-traceability-"));
  server = await createReviewServer(dir, browser);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});

test.afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
  await rm(dir, { force: true, recursive: true });
});

async function fixture(page: import("@playwright/test").Page) {
  await page.goto(url);
  await page.locator("#test-name").fill("Add, complete and delete a task");
  await page.getByLabel("Your test instructions").fill(
    "Add Prepare interview, complete it, then delete it and check the count.");
  await page.getByLabel("Generate with").selectOption("fixture");
  await page.getByRole("button", { name: "Generate draft" }).click();
  await expect(page.locator(".step")).toHaveCount(9);
}

test("reviewer maps requirements, sees gaps and persists only explicit links", async ({ page }) => {
  await fixture(page);
  await expect(page.locator("#traceability-summary")).toContainText("No requirement statements loaded");
  await page.getByLabel("Requirement statements, one per line").fill([
    "Task creation is visible",
    "A task may be completed",
    "A task can be filtered by tag",
  ].join("\n"));
  await page.getByRole("button", { name: "Load requirements for mapping" }).click();
  const rows = page.locator(".trace-requirement");
  await expect(rows).toHaveCount(3);
  await expect(page.locator("#traceability-summary")).toContainText("3 unmapped");

  await rows.nth(0).locator("summary").click();
  await rows.nth(0).locator('input[value="enter"]').check();
  await rows.nth(0).locator('input[value="visible"]').check();
  await expect(rows.nth(0).locator(".trace-requirement-status"))
    .toContainText("AI assumption only");

  await rows.nth(1).locator("summary").click();
  await rows.nth(1).locator('input[value="complete"]').check();
  await expect(rows.nth(1).locator(".trace-requirement-status"))
    .toContainText("Steps only");
  await expect(rows.nth(2).locator(".trace-requirement-status"))
    .toContainText("Unmapped");

  for (const checkbox of await page.locator(".step input[type=checkbox]").all()) {
    await checkbox.check();
  }
  await page.locator("#save-test-name").fill("Add, complete and delete a task");
  await page.getByRole("button", { name: "Save Test" }).click();
  await expect(page.locator("#saved")).toContainText("Saved and ready to execute");
  await page.locator("#nav-run").click();
  const savedId = await page.locator("#execution-panel").getByLabel("Test", { exact: true }).inputValue();
  const saved = JSON.parse(await readFile(await approvedPath(dir, savedId), "utf8"));
  expect(saved.requirements).toEqual([
    { id: "R1", text: "Task creation is visible", stepIds: ["enter", "visible"] },
    { id: "R2", text: "A task may be completed", stepIds: ["complete"] },
    { id: "R3", text: "A task can be filtered by tag", stepIds: [] },
  ]);
  const response = await page.request.get(url + "/api/tests/" + savedId + "/traceability");
  expect(response.status()).toBe(200);
  const report = await response.json();
  expect(report.summary).toEqual({
    total: 3, unmapped: 1, stepsOnly: 1, inferredAssertion: 1, assertionLinked: 0,
  });
  expect(report.requirements[0].assertions[0]).toMatchObject({
    stepId: "visible", provenance: "inferred",
  });
  await expect(page.getByRole("link", { name: "View requirement matrix (JSON)" }))
    .toHaveAttribute("href", "/api/tests/" + savedId + "/traceability");

  // Existing saved scripts may be edited without losing links or requiring JSON edits.
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Edit test" }).click();
  await expect(rows).toHaveCount(3);
  await rows.nth(0).locator("summary").click();
  await expect(rows.nth(0).locator('input[value="enter"]')).toBeChecked();
  await expect(rows.nth(0).locator('input[value="visible"]')).toBeChecked();

  // Meaningful requirement edits must NOT silently preserve old coverage claims.
  await page.getByLabel("Requirement statements, one per line").fill([
    "Different requirement text",
    "A task may be completed",
    "A task can be filtered by tag",
  ].join("\n"));
  await page.getByRole("button", { name: "Load requirements for mapping" }).click();
  await expect(page.locator("#traceability-note")).toContainText(
    "1 changed requirements had their previous links cleared");
  await expect(rows.nth(0).locator(".trace-requirement-status")).toContainText("Unmapped");
  await expect(rows.nth(1).locator(".trace-requirement-status")).toContainText("Steps only");
  const items = await readdir(dir);
  expect(items.filter((name) => name.endsWith(".spec.ts"))).toHaveLength(0);
});

test("saved API rejects forged links and never treats legacy tests as covered", async ({ page }) => {
  const original = JSON.parse(await readFile("examples/add-task.json", "utf8"));
  const invalid = structuredClone(original);
  invalid.requirements = [
    { id: "R1", text: "Invented coverage", stepIds: ["missing-step"] },
  ];
  const rejected = await page.request.post(url + "/api/save", {
    data: { testName: "Regression test", definition: invalid, baseURL: "http://127.0.0.1:3000" },
  });
  expect(rejected.status()).toBe(400);
  const response = await page.request.post(url + "/api/save", {
    data: { testName: "Regression test", definition: original, baseURL: "http://127.0.0.1:3000" },
  });
  expect(response.status()).toBe(200);
  const result = await response.json();
  const matrix = await (await page.request.get(
    url + "/api/tests/" + result.id + "/traceability")).json();
  expect(matrix.summary.total).toBe(0);
  expect(matrix.summary.assertionLinked).toBe(0);
  const missing = await page.request.get(
    url + "/api/tests/reviewed-1700000000000-deadbeef.json/traceability");
  expect(missing.status()).toBe(404);
});
