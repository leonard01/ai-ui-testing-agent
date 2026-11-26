import { test, expect } from "@playwright/test";
import { createReviewServer } from "../src/review-server.js";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Browser } from "playwright";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

test.use({ trace: "off" });

async function start(dir: string, browser: Browser) {
  const server = await createReviewServer(dir, browser);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: "http://127.0.0.1:" + (server.address() as AddressInfo).port };
}
async function stop(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()));
}
async function request(url: string, body: unknown) {
  const response = await fetch(url + "/api/history/delete-all", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
async function seedHistoricalRun(dir: string, url: string | null, time: string) {
  const id = randomUUID();
  const folder = join(dir, "run-results", id);
  await mkdir(folder, { recursive: true });
  const report = {
    schemaVersion: 1, testId: id, title: "Historical case " + id.slice(0, 8),
    status: "passed", startedAt: time, durationMs: 120,
    steps: [], artifacts: {}, evidenceErrors: [],
  };
  await writeFile(join(folder, "report.json"), JSON.stringify(report));
  await writeFile(join(folder, "run-metadata.json"), JSON.stringify({
    schemaVersion: 1, fileId: "reviewed-1700000000000-deadbeef.json",
    startedAt: time, state: "finished", ...(url ? { baseURL: url } : {}),
  }));
  return id;
}
async function seedMany(dir: string) {
  const websiteA = "https://www.saucedemo.com";
  const websiteB = "https://demo.playwright.dev";
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) {
    ids.push(await seedHistoricalRun(dir, websiteA + "/inventory.html",
      new Date(Date.UTC(2026, 10, 21, 12, i, 0)).toISOString()));
  }
  for (let i = 0; i < 3; i++) {
    await seedHistoricalRun(dir, websiteB + "/todomvc/#/",
      new Date(Date.UTC(2026, 10, 21, 11, i, 0)).toISOString());
  }
  await seedHistoricalRun(dir, null, "2026-11-21T10:00:00.000Z");
  return { websiteA, websiteB, ids };
}

test("website suite dropdown paginates 10 executions and includes singles without duplicate run list", async ({ browser, page }) => {
  const dir = await mkdtemp(join(tmpdir(), "history-pages-"));
  let server: Server | undefined;
  try {
    const { websiteA, websiteB, ids } = await seedMany(dir);
    const app = await start(dir, browser);
    server = app.server;
    const query = "?siteUrl=" + encodeURIComponent(websiteA);
    const first = await (await fetch(app.url + "/api/history" + query + "&page=1")).json();
    expect(first).toMatchObject({
      selectedSiteUrl: websiteA, page: 1, pages: 2, pageSize: 10, total: 12,
    });
    expect(first.entries).toHaveLength(10);
    expect(first.entries[0].id).toBe(ids[11]);
    expect(first.entries.every((entry: any) => entry.siteUrl === websiteA)).toBe(true);
    const second = await (await fetch(app.url + "/api/history" + query + "&page=2")).json();
    expect(second).toMatchObject({ page: 2, pages: 2, total: 12 });
    expect(second.entries).toHaveLength(2);
    expect(second.entries[1].id).toBe(ids[0]);
    const other = await (await fetch(app.url + "/api/history?siteUrl=" +
      encodeURIComponent(websiteB))).json();
    expect(other.total).toBe(3);
    expect(other.entries).toHaveLength(3);
    const legacy = await (await fetch(app.url + "/api/history?siteUrl=__legacy__")).json();
    expect(legacy.total).toBe(1);
    const invalid = await fetch(app.url + "/api/history?page=-2");
    expect(invalid.status).toBe(400);

    await page.goto(app.url);
    await expect(page.locator("#history-panel")).toBeHidden();
    await expect(page.locator("#history-suite-list .history-entry")).toHaveCount(0);
    await page.locator("#nav-diagnostics").click();
    await expect(page.locator("#history-site")).toHaveValue("__all__");
    await expect(page.locator("#history-suite-list .history-entry")).toHaveCount(10);
    await expect(page.locator("#history-page-info")).toContainText("Page 1 of 2");
    await page.locator("#history-site").selectOption(websiteA);
    await expect(page.locator("#history-site")).toHaveValue(websiteA);
    await expect(page.locator("#history-suite-list .history-entry")).toHaveCount(10);
    await expect(page.locator("#history-suite-list .history-entry").first())
      .toContainText(websiteA);
    await expect(page.locator("#history-page-info")).toContainText("Page 1 of 2");
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.locator("#history-suite-list .history-entry")).toHaveCount(2);
    await expect(page.locator("#history-page-info")).toContainText("Page 2 of 2");
    await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Previous", exact: true }).click();
    await expect(page.locator("#history-suite-list .history-entry")).toHaveCount(10);
    await page.locator("#history-site").selectOption(websiteB);
    await expect(page.locator("#history-suite-list .history-entry")).toHaveCount(3);
    await expect(page.locator("#history-page-info")).toContainText("Page 1 of 1");
    await page.locator("#nav-run").click();
    await expect(page.locator("#history-panel")).toBeHidden();
    await page.locator("#nav-diagnostics").click();
    await expect(page.locator("#history-site")).toHaveValue(websiteB);
    await expect(page.locator("#history-suite-list .history-entry")).toHaveCount(3);
  } finally {
    if (server) await stop(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("Delete All History requires confirmation, removes reports globally but keeps approved scripts and unrelated files", async ({ browser, page }) => {
  const dir = await mkdtemp(join(tmpdir(), "history-delete-"));
  let server: Server | undefined;
  try {
    const seeded = await seedMany(dir);
    const approved = "reviewed-1700000000000-deadbeef.json";
    await writeFile(join(dir, approved),
      await readFile("examples/add-task.json", "utf8"));
    const resultsDir = join(dir, "run-results");
    await writeFile(join(resultsDir, "keep.txt"), "not a run");
    await mkdir(join(resultsDir, "unrelated"), { recursive: true });
    await writeFile(join(resultsDir, "unrelated", "keep.txt"), "not a run");
    const app = await start(dir, browser);
    server = app.server;

    expect((await request(app.url, { confirmed: false })).status).toBe(400);
    expect((await request(app.url, {
      confirmed: true, confirmationText: "WRONG",
    })).status).toBe(400);

    await page.goto(app.url);
    await page.locator("#nav-diagnostics").click();
    await expect(page.locator("#history-suite-list .history-entry")).toHaveCount(10);
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByRole("button", { name: "Delete All History" }).click();
    const stillThere = await (await fetch(app.url + "/api/history")).json();
    expect(stillThere.sites).toHaveLength(3);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete All History" }).click();
    await expect(page.locator("#history-status")).toContainText("0 of 0 saved executions");
    await expect(page.locator("#history-suite-list .history-entry")).toHaveCount(0);
    expect((await (await fetch(app.url + "/api/history")).json()).sites).toHaveLength(0);
    expect((await fetch(app.url + "/api/runs/" + seeded.ids[0])).status).toBe(404);
    expect((await readdir(dir))).toContain(approved);
    expect((await readdir(resultsDir))).toContain("keep.txt");
    expect((await readdir(join(resultsDir, "unrelated")))).toContain("keep.txt");

    await stop(app.server);
    server = undefined;
    const restarted = await start(dir, browser);
    server = restarted.server;
    expect((await (await fetch(restarted.url + "/api/history")).json()).entries).toHaveLength(0);
    expect((await (await fetch(restarted.url + "/api/tests")).json()).tests
      .some((entry: {id: string}) => entry.id === approved)).toBe(true);
  } finally {
    if (server) await stop(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("Delete All History rejects deletion while a script is running", async ({ browser }) => {
  const dir = await mkdtemp(join(tmpdir(), "history-busy-"));
  let server: Server | undefined;
  try {
    const definition = JSON.parse(await readFile("examples/add-task.json", "utf8"));
    const incorrect = definition.steps.find((entry: any) => entry.id === "empty");
    incorrect.action.expected = "1000 tasks, 0 completed";
    const id = "reviewed-1700000000000-deadbeef.json";
    await writeFile(join(dir, id), JSON.stringify(definition));
    const app = await start(dir, browser);
    server = app.server;
    const started = await fetch(app.url + "/api/run", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, baseURL: "http://127.0.0.1:3000", timeoutMs: 3000 }),
    });
    expect(started.status).toBe(202);
    expect((await request(app.url, {
      confirmed: true, confirmationText: "DELETE ALL HISTORY",
    })).status).toBe(409);
    const job = await started.json();
    await expect.poll(async () =>
      (await (await fetch(app.url + "/api/runs/" + job.id)).json()).state,
    { timeout: 15_000 }).toBe("finished");
    const deleted = await request(app.url, {
      confirmed: true, confirmationText: "DELETE ALL HISTORY",
    });
    expect(deleted.status).toBe(200);
    expect((await (await fetch(app.url + "/api/history")).json()).entries).toHaveLength(0);
  } finally {
    if (server) await stop(server);
    await rm(dir, { recursive: true, force: true });
  }
});
