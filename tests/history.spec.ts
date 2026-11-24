import { test, expect } from "@playwright/test";
import { createReviewServer } from "../src/review-server.js";
import { mkdtemp, readFile, readdir, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser } from "playwright";
import type { TestDefinition } from "../src/domain.js";

test.use({ trace: "off" });

async function start(dir: string, browser: Browser) {
  const server = await createReviewServer(dir, browser);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    server,
    url: "http://127.0.0.1:" + (server.address() as AddressInfo).port,
  };
}
async function stop(server: Server) {
  await new Promise<void>((done, reject) =>
    server.close((error) => error ? reject(error) : done()));
}
async function post(url: string, path: string, body: unknown) {
  const response = await fetch(url + path, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}
async function completion(url: string, path: string) {
  let latest: any;
  await expect.poll(async () => {
    const response = await fetch(url + path);
    latest = await response.json();
    return latest.state;
  }, { timeout: 20000 }).toBe("finished");
  return latest;
}
async function seed(dir: string) {
  const fixture = JSON.parse(await readFile("examples/add-task.json", "utf8")) as TestDefinition;
  const ids: string[] = [];
  for (const index of [0, 1]) {
    const definition = structuredClone(fixture);
    definition.id = "history-case-" + index;
    definition.title = index ? "Known failing history case" : "Passing history case";
    if (index) {
      const step = definition.steps.find((item) => item.id === "empty")!;
      if (step.action.kind !== "assert-text") throw new Error("Expected text assertion");
      step.action.expected = "999 tasks, 0 completed";
    }
    const id = "reviewed-" + String(Date.now() + index) + "-" +
      String(index + 10).padStart(8, "0") + ".json";
    await writeFile(join(dir, id), JSON.stringify(definition));
    ids.push(id);
  }
  return ids;
}

test("run/suite reports and failure evidence survive a full review-server restart", async ({ browser, page }) => {
  const dir = await mkdtemp(join(tmpdir(), "ui-history-"));
  const ids = await seed(dir);
  let current: Server | undefined;
  try {
    let session = await start(dir, browser);
    current = session.server;
    const url = session.url;
    const single = await post(url, "/api/run", {
      id: ids[0], baseURL: "http://127.0.0.1:3000",
    });
    expect(single.status).toBe(202);
    const passed = await completion(url, "/api/runs/" + single.data.id);
    expect(passed.report.status).toBe("passed");

    const failure = await post(url, "/api/run", {
      id: ids[1], baseURL: "http://127.0.0.1:3000", timeoutMs: 500,
    });
    expect(failure.status).toBe(202);
    const failed = await completion(url, "/api/runs/" + failure.data.id);
    expect(failed.report.status).toBe("assertion-failed");
    expect(failed.artifacts.trace).toMatch(/trace.zip$/);

    const suiteStarted = await post(url, "/api/suites", {
      ids, baseURL: "http://127.0.0.1:3000", timeoutMs: 500,
    });
    expect(suiteStarted.status).toBe(202);
    const suite = await completion(url, "/api/suites/" + suiteStarted.data.id);
    expect(suite.summary).toMatchObject({
      total: 2, completed: 2, passed: 1, failed: 1,
    });

    const before = await (await fetch(url + "/api/history")).json();
    // One website suite, three executions (two single runs and one batch).
    // Four individual member reports are NOT displayed separately.
    expect(before.sites).toEqual([{
      siteUrl: "http://127.0.0.1:3000", label: "http://127.0.0.1:3000", executions: 3,
    }]);
    expect(before.entries).toHaveLength(3);
    expect(before.entries.filter((entry: any) => entry.kind === "single")).toHaveLength(2);
    expect(before.entries.filter((entry: any) => entry.kind === "batch")).toHaveLength(1);
    expect(before.entries.every((entry: any) =>
      entry.siteUrl === "http://127.0.0.1:3000")).toBe(true);

    const metadata = JSON.parse(await readFile(join(
      dir, "run-results", failed.id, "run-metadata.json"), "utf8"));
    expect(metadata).toMatchObject({
      schemaVersion: 1, fileId: ids[1], state: "finished",
    });

    await stop(session.server);
    current = undefined;
    session = await start(dir, browser);
    current = session.server;
    const restored = await (await fetch(session.url + "/api/history")).json();
    expect(restored.entries).toHaveLength(3);
    expect(restored.sites).toEqual(before.sites);
    expect(restored.entries.map((entry: any) => entry.id)).toEqual(
      before.entries.map((entry: any) => entry.id));

    const restoredRun = await (await fetch(
      session.url + "/api/runs/" + failed.id)).json();
    expect(restoredRun.state).toBe("finished");
    expect(restoredRun.report.status).toBe("assertion-failed");
    expect(restoredRun.report.steps.find((step: any) => step.id === "empty")?.expected)
      .toBe("999 tasks, 0 completed");
    expect(restoredRun.diagnosis.kind).toBe("assertion-mismatch");
    const screenshot = await fetch(session.url + restoredRun.artifacts.screenshot);
    expect(screenshot.status).toBe(200);
    expect(screenshot.headers.get("content-type")).toContain("image/png");
    const trace = await fetch(session.url + restoredRun.artifacts.trace);
    expect(trace.status).toBe(200);
    expect(trace.headers.get("content-type")).toContain("application/zip");

    const restoredSuite = await (await fetch(
      session.url + "/api/suites/" + suite.id)).json();
    expect(restoredSuite.verdict).toBe("failed");
    expect(restoredSuite.summary).toMatchObject({
      passed: 1, failed: 1, completed: 2,
    });
    expect(restoredSuite.tests.every((entry: any) => entry.detailAvailable)).toBe(true);
    const report = await (await fetch(
      session.url + restoredSuite.report)).json();
    expect(report.summary.failed).toBe(1);

    // History is collapsed, last on the page, and combines single/batch
    // executions under the same named website without duplicating members.
    await page.goto(session.url);
    await expect(page.locator("#history-panel")).toBeHidden();
    await expect(page.getByRole("button", { name: "Show History" })).toBeVisible();
    await expect(page.locator("#execution-panel").locator("section").last())
      .toHaveAttribute("id", "history-panel");
    await page.getByRole("button", { name: "Show History" }).click();
    await expect(page.locator("#history-site")).toHaveValue("http://127.0.0.1:3000");
    await expect(page.locator("#history-suite-list .history-entry")).toHaveCount(3);
    await expect(page.locator("#history-run-list")).toHaveCount(0);
    await expect(page.locator("#history-page-info")).toContainText("Page 1 of 1");
    await page.locator("#history-suite-list").getByRole("button", {
      name: "Open results",
    }).first().click();
    await expect(page.locator("#suite-results .run-step")).toHaveCount(2);
    await page.locator("#history-suite-list").getByRole("button", {
      name: "Open results",
    }).nth(1).click();
    await expect(page.locator("#run-results")).toBeVisible();
    await expect(page.locator("#run-status")).toContainText("No test was rerun");
    await page.getByRole("button", { name: "Hide History" }).click();
    await expect(page.locator("#history-panel")).toBeHidden();
  } finally {
    if (current) await stop(current);
    await rm(dir, { recursive: true, force: true });
  }
});

test("restoration ignores incomplete, corrupt and unrecognized directories", async ({ browser }) => {
  const dir = await mkdtemp(join(tmpdir(), "ui-history-bad-"));
  const ignored = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const legacy = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  let current: Server | undefined;
  try {
    await mkdir(join(dir, "run-results", ignored), { recursive: true });
    await writeFile(join(dir, "run-results", ignored, "report.json"),
      '{"partial":true}');
    await mkdir(join(dir, "run-results", legacy), { recursive: true });
    await writeFile(join(dir, "run-results", legacy, "report.json"),
      JSON.stringify({
        schemaVersion: 1, testId: "legacy", title: "Pre-history valid report",
        status: "passed", startedAt: "2026-11-21T00:00:00.000Z",
        durationMs: 37, steps: [], artifacts: {}, evidenceErrors: [],
      }));
    await mkdir(join(dir, "run-results", "suites", ignored), { recursive: true });
    await writeFile(join(dir, "run-results", "suites", ignored, "report.json"),
      '{"state":"running"}');
    await mkdir(join(dir, "run-results", "not-a-run"), { recursive: true });
    await writeFile(join(dir, "run-results", "not-a-run", "report.json"),
      '{"state":"finished"}');

    const instance = await start(dir, browser);
    current = instance.server;
    const payload = await (await fetch(instance.url + "/api/history")).json();
    expect(payload.entries).toHaveLength(1);
    expect(payload.entries[0]).toMatchObject({
      id: legacy, kind: "single", verdict: "passed",
      siteUrl: "__legacy__", title: "Pre-history valid report",
    });
    expect(payload.sites).toEqual([{
      siteUrl: "__legacy__", label: "Older / unknown website", executions: 1,
    }]);
    const unavailable = await fetch(instance.url + "/api/runs/" + ignored);
    expect(unavailable.status).toBe(404);
    const legacyResponse = await fetch(instance.url + "/api/runs/" + legacy);
    expect(legacyResponse.status).toBe(200);
  } finally {
    if (current) await stop(current);
    await rm(dir, { recursive: true, force: true });
  }
});


test("history rejects invalid pagination without changing saved tests", async ({ browser }) => {
  const dir = await mkdtemp(join(tmpdir(), "history-pagination-boundaries-"));
  let server: Server | undefined;
  try {
    const ids = await seed(dir);
    const instance = await start(dir, browser);
    server = instance.server;
    for (const query of ["page=0", "page=-1", "page=1.5", "page=NaN", "page=100001", "siteUrl=" + "x".repeat(2049)]) {
      const response = await fetch(instance.url + "/api/history?" + query);
      expect(response.status, query.slice(0, 60)).toBe(400);
      expect((await response.json()).error).toContain("Invalid history page or website filter");
    }
    const valid = await fetch(instance.url + "/api/history?page=1");
    expect(valid.status).toBe(200);
    expect((await valid.json()).entries).toEqual([]);
    expect((await (await fetch(instance.url + "/api/tests")).json()).tests).toHaveLength(ids.length);
  } finally {
    if (server) { server.closeAllConnections(); await stop(server); }
    await rm(dir, { recursive: true, force: true });
  }
});

test("passing run has a report but does not expose nonexistent failure screenshot", async ({ browser }) => {
  const dir = await mkdtemp(join(tmpdir(), "history-artifact-boundaries-"));
  let server: Server | undefined;
  try {
    const ids = await seed(dir);
    const instance = await start(dir, browser);
    server = instance.server;
    const started = await post(instance.url, "/api/run", { id: ids[0], baseURL: "http://127.0.0.1:3000" });
    expect(started.status).toBe(202);
    const completed = await completion(instance.url, "/api/runs/" + started.data.id);
    expect(completed.report.status).toBe("passed");
    const path = instance.url + "/api/runs/" + completed.id;
    expect((await fetch(path + "/report.json")).status).toBe(200);
    expect((await fetch(path + "/failure.png")).status).toBe(404);
    expect((await fetch(instance.url + "/api/runs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/report.json")).status).toBe(404);
    expect((await (await fetch(instance.url + "/api/history")).json()).entries).toHaveLength(1);
  } finally {
    if (server) { server.closeAllConnections(); await stop(server); }
    await rm(dir, { recursive: true, force: true });
  }
});
