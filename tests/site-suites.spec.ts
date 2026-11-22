import { selectSavedScript } from "./helpers/select-saved-script.js";
import { test, expect } from "@playwright/test";
import { createReviewServer } from "../src/review-server.js";
import { websiteDirectory } from "../src/site-storage.js";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestDefinition } from "../src/domain.js";

test.use({ trace: "off" });

let server: Server;
let url: string;
let dir: string;
const sauce = "https://www.saucedemo.com";
const local = "http://127.0.0.1:3000";

async function post(path: string, body: unknown) {
  const response = await fetch(url + path, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
async function save(title: string, baseURL: string) {
  const original = JSON.parse(await readFile("examples/add-task.json", "utf8")) as TestDefinition;
  const definition = structuredClone(original);
  definition.title = title;
  definition.id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const response = await post("/api/save", { definition, baseURL, testName: title });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.id as string;
}
async function list() {
  const response = await fetch(url + "/api/tests");
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    tests: Array<{ id: string; title: string; sourceUrl: string | null; siteUrl: string | null }>;
    sites: Array<{ siteUrl: string | null; scripts: number }>;
  }>;
}

test.beforeEach(async ({ browser }) => {
  dir = await mkdtemp(join(tmpdir(), "website-suite-"));
  server = await createReviewServer(dir, browser);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});
test.afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()));
  await rm(dir, { force: true, recursive: true });
});

test("website suites group scripts by origin and retain exact source URL in separate safe folders", async ({ page }) => {
  const first = await save("Add user", sauce + "/");
  const second = await save("Remove user", sauce + "/inventory.html");
  const third = await save("Create task locally", local + "/");
  const sites = await list();
  expect(sites.sites).toEqual([
    { siteUrl: local, scripts: 1 },
    { siteUrl: sauce, scripts: 2 },
  ]);
  const expected = new Map([[first, sauce + "/"], [second, sauce + "/inventory.html"],
    [third, local + "/"]]);
  for (const [id, sourceUrl] of expected) {
    const dirPath = websiteDirectory(dir, sourceUrl);
    const saved = JSON.parse(await readFile(join(dirPath, id), "utf8")) as TestDefinition;
    expect(saved.sourceUrl).toBe(sourceUrl);
    expect((await readdir(dirPath))).toContain(id);
  }
  expect(websiteDirectory(dir, sauce)).not.toBe(websiteDirectory(dir, local));
  await page.goto(url);
  const suite = page.getByLabel("Test suite (website URL)");
  const singleBeforeSuite = page.getByLabel("Test script", { exact: true });
  await expect(suite).toHaveValue("");
  await expect(singleBeforeSuite).toBeDisabled();
  await expect(singleBeforeSuite).toHaveValue("");
  await expect(page.getByRole("button", { name: "Run selected test" })).toBeDisabled();
  await suite.selectOption(sauce);
  await expect(singleBeforeSuite).toBeEnabled();
  await expect(singleBeforeSuite).toHaveValue("");
  const timeout = page.getByLabel("Step timeout (also used for batch runs)");
  await expect(timeout).toHaveValue("5000");
  await timeout.selectOption("10000");
  await expect(timeout).toHaveValue("10000");
  await expect(page.getByRole("button", { name: "Run selected test" })).toBeDisabled();
  const single = page.getByLabel("Test script", { exact: true });
  await expect(single.locator("option")).toHaveCount(3); // blank + two SauceDemo scripts
  await expect(single.locator('option[value="' + first + '"]')).toHaveCount(1);
  await expect(single.locator('option[value="' + second + '"]')).toHaveCount(1);
  await expect(single.locator('option[value="' + third + '"]')).toHaveCount(0);
  await single.selectOption(first);
  await expect(page.getByRole("button", { name: "Run selected test" })).toBeEnabled();
  await expect(page.getByRole("link", { name: "Export Playwright (.spec.ts)" })).toBeVisible();
  await expect(page.getByRole("link", { name: "View requirement matrix (JSON)" })).toBeVisible();
  await expect(page.locator("#suite-test-list input[type=checkbox]")).toHaveCount(2);
  await expect(page.locator("#suite-site-note")).toContainText("2 saved test scripts");
  await expect(page.locator("#base-url")).toHaveValue(sauce + "/");
  await page.getByRole("button", { name: "Select first 10" }).click();
  await expect(page.locator("#suite-selection-status")).toContainText("2 tests selected");
  await suite.selectOption(local);
  await expect(single.locator("option")).toHaveCount(2); // blank + local website script
  await expect(single.locator('option[value="' + first + '"]')).toHaveCount(0);
  await expect(single.locator('option[value="' + second + '"]')).toHaveCount(0);
  await expect(single.locator('option[value="' + third + '"]')).toHaveCount(1);
  await expect(single).toHaveValue("");
  await expect(page.getByRole("button", { name: "Run selected test" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Edit selected saved test in review form" })).toBeDisabled();
  await expect(page.getByRole("link", { name: "Export Playwright (.spec.ts)" })).toBeHidden();
  await expect(page.locator("#suite-test-list input[type=checkbox]")).toHaveCount(1);
  await expect(page.locator("#suite-selection-status")).toContainText("0 tests selected");
  await expect(page.locator("#base-url")).toHaveValue(local + "/");
  await expect(page.getByRole("button", { name: "Run selected suite" })).toBeDisabled();
  await single.selectOption(third);
  await expect(page.getByRole("button", { name: "Run selected test" })).toBeEnabled();
  await suite.selectOption(sauce);
  await expect(single).toHaveValue(""); // switching suites never retains a foreign script
  await expect(single.locator('option[value="' + third + '"]')).toHaveCount(0);

  const mixed = await post("/api/suites", {
    ids: [first, third], baseURL: local,
  });
  expect(mixed.status).toBe(400);
  expect(mixed.body.error).toContain("website suite");
});

test("confirmed individual deletion only removes its approved script and preserves other suite members", async ({ page }) => {
  const first = await save("Add user", sauce);
  const second = await save("Remove user", sauce);
  await page.goto(url);
  await selectSavedScript(page, first);
  const denied = await post("/api/delete-test", { id: first, confirmed: false });
  expect(denied.status).toBe(400);
  const badID = await post("/api/delete-test", { id: "../../secrets.json", confirmed: true });
  expect(badID.status).toBe(400);
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Delete selected test script" }).click();
  expect((await list()).tests).toHaveLength(2);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete selected test script" }).click();
  await expect(page.locator("#run-status")).toContainText("Approved test script deleted");
  expect((await list()).tests.map((item) => item.id)).toEqual([second]);
  expect((await readdir(websiteDirectory(dir, sauce)))).toEqual([second]);
  const missing = await fetch(url + "/api/tests/" + first);
  expect(missing.status).toBe(404);
});

test("deleting website suite removes scripts but retains completed run evidence", async ({ page }) => {
  const first = await save("Run history sample", local);
  const second = await save("Another local case", local + "/tasks");
  const started = await post("/api/run", { id: first, baseURL: local });
  expect(started.status).toBe(202);
  const busy = await post("/api/delete-site", { siteUrl: local, confirmed: true });
  expect(busy.status).toBe(409);
  await expect.poll(async () => {
    const response = await fetch(url + "/api/runs/" + started.body.id);
    return (await response.json()).state;
  }, { timeout: 20000 }).toBe("finished");
  const historical = await (await fetch(url + "/api/runs/" + started.body.id)).json();
  expect(historical.report.status).toBe("passed");
  await page.goto(url);
  await page.getByLabel("Test suite (website URL)").selectOption(local);
  const denied = await post("/api/delete-site", { siteUrl: local, confirmed: false });
  expect(denied.status).toBe(400);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete this website test suite" }).click();
  await expect(page.locator("#suite-status")).toContainText("Website suite and its approved test scripts deleted");
  const after = await list();
  expect(after.tests.filter((item) => item.siteUrl === local)).toHaveLength(0);
  expect(after.sites).toHaveLength(0);
  expect((await fetch(url + "/api/tests/" + first)).status).toBe(404);
  expect((await fetch(url + "/api/tests/" + second)).status).toBe(404);
  const again = await (await fetch(url + "/api/runs/" + started.body.id)).json();
  expect(again.report.status).toBe("passed");
  const history = await (await fetch(url + "/api/history")).json();
  expect(history.entries).toHaveLength(1);
  expect(history.entries[0]).toMatchObject({
    kind: "single", siteUrl: local, verdict: "passed",
  });
  expect(history.sites[0].siteUrl).toBe(local);
});

test("existing flat JSON scripts stay visible under unassigned suite and can be deleted", async ({ page }) => {
  const original = JSON.parse(await readFile("examples/add-task.json", "utf8")) as TestDefinition;
  const legacyID = "reviewed-1700000000000-deadbeef.json";
  await writeFile(join(dir, legacyID), JSON.stringify(original));
  const other = await save("New saucedemo script", sauce);
  const listed = await list();
  expect(listed.sites).toEqual([
    { siteUrl: null, scripts: 1 },
    { siteUrl: sauce, scripts: 1 },
  ]);
  await page.goto(url);
  await page.getByLabel("Test suite (website URL)").selectOption("__legacy__");
  await expect(page.getByLabel("Test script", { exact: true }).locator("option")).toHaveCount(2);
  await expect(page.getByLabel("Test script", { exact: true }).locator('option[value="' + other + '"]')).toHaveCount(0);
  await expect(page.locator("#suite-test-list input[type=checkbox]")).toHaveCount(1);
  await expect(page.locator("#suite-site-note")).toContainText("Older saved scripts");
  await expect(page.getByRole("button", { name: "Delete this website test suite" })).toBeDisabled();
  const remove = await post("/api/delete-test", { id: legacyID, confirmed: true });
  expect(remove.status).toBe(200);
  const surviving = await list();
  expect(surviving.tests.map((item) => item.id)).toEqual([other]);
});

test("legacy script assignment needs confirmation, verifies URL and keeps original ID", async ({ page }) => {
  const original = JSON.parse(await readFile("examples/add-task.json", "utf8")) as TestDefinition;
  const legacyID = "reviewed-1700000000000-deadbeef.json";
  await writeFile(join(dir, legacyID), JSON.stringify(original));
  await page.goto(url);
  await selectSavedScript(page, legacyID);
  await expect(page.getByRole("button", { name: "Assign older script to website URL" })).toBeEnabled();
  const denied = await post("/api/assign-site", {
    id: legacyID, baseURL: sauce, confirmed: false,
  });
  expect(denied.status).toBe(400);
  await page.locator("#base-url").fill(sauce);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Assign older script to website URL" }).click();
  await expect(page.locator("#run-status")).toContainText("assigned to the selected website");
  const after = await list();
  expect(after.tests).toHaveLength(1);
  expect(after.tests[0]).toMatchObject({ id: legacyID, siteUrl: sauce, sourceUrl: sauce + "/" });
  expect(after.sites).toEqual([{ siteUrl: sauce, scripts: 1 }]);
  expect((await readdir(websiteDirectory(dir, sauce)))).toContain(legacyID);
  await expect(page.getByRole("button", { name: "Assign older script to website URL" })).toBeDisabled();
  const repeat = await post("/api/assign-site", {
    id: legacyID, baseURL: sauce, confirmed: true,
  });
  expect(repeat.status).toBe(400);
});
