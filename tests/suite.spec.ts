import { selectSavedScript } from "./helpers/select-saved-script.js";
import { test, expect } from "@playwright/test";
import { createReviewServer } from "../src/review-server.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestDefinition } from "../src/domain.js";

test.use({ trace: "off" });

let server: Server;
let url: string;
let outputDir: string;
let fileIds: string[];

async function post(path: string, body: unknown) {
  const response = await fetch(url + path, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
async function untilComplete(suiteId: string) {
  let latest: any;
  await expect.poll(async () => {
    const response = await fetch(url + "/api/suites/" + suiteId);
    latest = await response.json();
    return latest.state;
  }, { timeout: 30000 }).toBe("finished");
  return latest;
}
test.beforeEach(async ({ browser }) => {
  outputDir = await mkdtemp(join(tmpdir(), "ui-suite-"));
  const fixture = JSON.parse(await readFile("examples/add-task.json", "utf8")) as TestDefinition;
  fileIds = [];
  for (let i = 0; i < 3; i++) {
    const definition = structuredClone(fixture);
    definition.id = "suite-case-" + i;
    definition.title = i === 1 ? "Expected failure" : "Passing scenario " + i;
    if (i === 1) {
      const action = definition.steps[1].action;
      if (action.kind !== "assert-text") throw new Error("Fixture assertion not found");
      action.expected = "99 tasks, 0 completed";
    }
    const id = "reviewed-" + String(Date.now() + i) + "-" +
      String(i + 1).padStart(8, "0") + ".json";
    fileIds.push(id);
    await writeFile(join(outputDir, id), JSON.stringify(definition));
  }
  server = await createReviewServer(outputDir, browser);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});
test.afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()));
  await rm(outputDir, { force: true, recursive: true });
});

test("suite executes each approved test independently and keeps running after failures", async () => {
  const request = {
    ids: fileIds, baseURL: "http://127.0.0.1:3000", timeoutMs: 500,
  };
  const started = await post("/api/suites", request);
  expect(started.status).toBe(202);
  expect(started.body.summary).toMatchObject({ total: 3, completed: 0 });
  const suite = await untilComplete(started.body.id);
  expect(suite.verdict).toBe("failed");
  expect(suite.summary).toEqual({
    total: 3, completed: 3, passed: 2, failed: 1, errors: 0, remaining: 0,
  });
  expect(suite.tests.map((entry: any) => entry.fileId)).toEqual(fileIds);
  expect(suite.tests.map((entry: any) => entry.verdict)).toEqual([
    "passed", "assertion-failed", "passed",
  ]);
  expect(suite.tests.every((entry: any) => entry.detailAvailable && entry.runId)).toBeTruthy();
  expect(suite.tests.every((entry: any) => entry.durationMs >= 0)).toBeTruthy();

  for (const entry of suite.tests) {
    const response = await fetch(url + entry.report);
    expect(response.status).toBe(200);
    const report = await response.json();
    expect(report.status).toBe(entry.verdict);
    expect(report.testId).toContain("suite-case-");
  }
  const failedRun = suite.tests[1];
  const failure = await (await fetch(url + "/api/runs/" + failedRun.runId)).json();
  expect(failure.artifacts.screenshot).toMatch(/failure\.png/);
  expect(failure.artifacts.trace).toMatch(/trace\.zip/);
  expect(failure.report.steps[1].expected).toBe("99 tasks, 0 completed");

  const summaryResponse = await fetch(url + suite.report);
  expect(summaryResponse.status).toBe(200);
  expect((await summaryResponse.json()).summary.passed).toBe(2);
  const savedSummary = JSON.parse(await readFile(join(
    outputDir, "run-results", "suites", suite.id, "report.json"), "utf8"));
  expect(savedSummary.summary.failed).toBe(1);
  // No saving or rewriting of existing approved scripts during suite execution.
  const original = JSON.parse(await readFile(join(outputDir, fileIds[1]), "utf8"));
  expect(original.steps[1].action.expected).toBe("99 tasks, 0 completed");
});

test("rejects unknown, duplicate, empty and overly large suites before running", async () => {
  const baseURL = "http://127.0.0.1:3000";
  const invalids = [
    [], [fileIds[0], fileIds[0]], ["../../private.json"],
    ["reviewed-1700000000000-deadbeef.json"], Array(11).fill(fileIds[0]),
  ];
  for (const ids of invalids) {
    const result = await post("/api/suites", { ids, baseURL });
    expect(result.status).toBe(400);
  }
  const invalidTimeout = await post("/api/suites", {
    ids: [fileIds[0]], baseURL, timeoutMs: 0,
  });
  expect(invalidTimeout.status).toBe(400);
  const badOrigin = await post("/api/suites", {
    ids: [fileIds[0]], baseURL: "file:///tmp/example.html",
  });
  expect(badOrigin.status).toBe(400);
  const untouched = await fetch(url + "/api/suites/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  expect(untouched.status).toBe(404);
  const single = await post("/api/run", { id: fileIds[0], baseURL });
  expect(single.status).toBe(202);
  await expect.poll(async () => {
    const result = await (await fetch(url + "/api/runs/" + single.body.id)).json();
    return result.state;
  }, { timeout: 20000 }).toBe("finished");
});

test("suite holds the shared execution lock and forbids replacing queued cases", async () => {
  const baseURL = "http://127.0.0.1:3000";
  const started = await post("/api/suites", {
    ids: fileIds, baseURL, timeoutMs: 1500,
  });
  expect(started.status).toBe(202);
  const [secondSuite, singleRun, preflight] = await Promise.all([
    post("/api/suites", { ids: [fileIds[0]], baseURL }),
    post("/api/run", { id: fileIds[0], baseURL }),
    post("/api/preflight", {
      baseURL, definition: JSON.parse(await readFile(join(outputDir, fileIds[0]), "utf8")),
    }),
  ]);
  expect(secondSuite.status).toBe(409);
  expect(singleRun.status).toBe(409);
  expect(preflight.status).toBe(409);
  const attemptedEdit = JSON.parse(await readFile(join(outputDir, fileIds[2]), "utf8"));
  const replacement = await post("/api/save", {
    definition: attemptedEdit, testName: attemptedEdit.title, baseURL, replaceId: fileIds[2],
  });
  expect(replacement.status).toBe(400);
  expect(replacement.body.error).toContain("test suite");
  await untilComplete(started.body.id);
});

test("suite UI selects saved cases and drills into failure evidence", async ({ page }) => {
  await page.goto(url);
  await page.getByLabel("Test suite (website URL)").selectOption("__legacy__");
  const list = page.locator("#suite-test-list input[type=checkbox]");
  await expect(list).toHaveCount(3);
  await list.nth(0).check();
  await list.nth(1).check();
  await expect(page.locator("#suite-selection-status")).toContainText("2 tests selected");
  await expect(page.getByRole("button", { name: "Run selected suite" })).toBeEnabled();
  await page.getByRole("button", { name: "Run selected suite" }).click();
  await expect(page.locator("#suite-status")).toContainText("Suite complete", { timeout: 30000 });
  await expect(page.locator("#suite-summary")).toContainText("1 passed, 1 failed");
  await expect(page.locator("#suite-results .run-step")).toHaveCount(2);
  await expect(page.locator("#suite-results")).toContainText("ASSERTION-FAILED");
  await expect(page.getByRole("link", { name: "Open suite JSON report" })).toBeVisible();
  const button = page.getByRole("button", { name: "View details for Expected failure" });
  await button.click();
  await expect(page.locator("#run-summary")).toContainText("FAILED");
  await expect(page.locator("#run-steps")).toContainText("99 tasks, 0 completed");
  await expect(page.getByRole("link", { name: "Download Playwright trace" })).toBeVisible();
  await expect(page.locator("#run-screenshot")).toBeVisible();
});

test("Run Tests panel contains both one-script tools and multi-script execution without a separate upper selector", async ({ page }) => {
  await page.goto(url);
  await page.getByLabel("Test suite (website URL)").selectOption("__legacy__");
  const panel = page.locator("#suite-panel");
  await expect(panel.getByRole("heading", { name: "Run Tests", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Run a test suite" })).toHaveCount(0);
  // Everything lives in one panel: website, script selection, shared timeout,
  // edit/delete/export/traceability, single run and batch selection.
  for (const id of ["suite-site", "approved-tests", "run-timeout", "run-test",
    "edit-saved", "delete-script", "assign-legacy", "saved-traceability",
    "export-playwright", "suite-test-list", "suite-run", "delete-site"]) {
    await expect(panel.locator("#" + id)).toHaveCount(1);
  }
  await expect(page.locator("#execution-panel > #approved-tests")).toHaveCount(0);
  await expect(panel.locator("#suite-test-list input[type=checkbox]")).toHaveCount(3);

  await selectSavedScript(page, fileIds[0]);
  await expect(panel.getByRole("button", { name: "Run selected test" })).toBeEnabled();
  await expect(panel.getByRole("button", { name: "Edit selected saved test in review form" })).toBeEnabled();
  await expect(panel.getByRole("button", { name: "Delete selected test script" })).toBeEnabled();
  await expect(panel.getByRole("link", { name: "Export Playwright (.spec.ts)" })).toHaveAttribute(
    "href", /\/api\/tests\/reviewed-.*\/export\.ts\?/);
  await expect(panel.getByRole("link", { name: "View requirement matrix (JSON)" })).toBeVisible();

  await panel.getByRole("button", { name: "Run selected test" }).click();
  await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 25000 });
  await expect(page.locator("#run-summary")).toContainText("PASSED");

  const boxes = panel.locator("#suite-test-list input[type=checkbox]");
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await expect(panel.getByRole("button", { name: "Run selected suite" })).toBeEnabled();
  await panel.getByRole("button", { name: "Run selected suite" }).click();
  await expect(page.locator("#suite-status")).toContainText("Suite complete", { timeout: 30000 });
  await expect(page.locator("#suite-results .run-step")).toHaveCount(2);
  // History must stay below both result sections.
  await expect(page.locator("#history-controls")).toBeVisible();
  await expect(page.locator("#history-panel")).toBeHidden();
});
