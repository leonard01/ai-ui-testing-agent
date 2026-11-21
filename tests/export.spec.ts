import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createReviewServer } from "../src/review-server.js";
import { generatePlaywrightSpec } from "../src/export.js";
import type { TestDefinition } from "../src/domain.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

test.use({ trace: "off" });
const execute = promisify(execFile);
const baseURL = "http://127.0.0.1:3000";

async function example(): Promise<TestDefinition> {
  return JSON.parse(await readFile("examples/add-task.json", "utf8")) as TestDefinition;
}

function withIntent(original: TestDefinition): TestDefinition {
  const definition = structuredClone(original);
  definition.steps[2].action = {
    kind: "fill", target: { by: "intent", value: "Task", role: "textbox" },
    value: "Prepare interview",
  };
  definition.steps[3].action = {
    kind: "click", target: { by: "intent", value: "Add", role: "button" },
  };
  definition.steps[5].action = {
    kind: "check", target: { by: "intent", value: "Complete Prepare interview", role: "checkbox" },
  };
  definition.steps[7].action = {
    kind: "click", target: { by: "intent", value: "Delete Prepare interview", role: "button" },
  };
  return definition;
}

async function executePortable(source: string, resultsDir: string, environmentURL = baseURL) {
  // Playwright skips the repository's ignored test-results directory when
  // collecting tests. Generate the independent spec under tests/ instead,
  // with a unique folder and clean it up immediately after the child run.
  const dir = await mkdtemp(join(resolve("tests"), "portable-export-"));
  try {
    const spec = join(dir, "independent.spec.ts");
    const config = join(dir, "playwright.config.cjs");
    await writeFile(spec, source);
    await writeFile(config, [
      "module.exports = {",
      "  testDir: " + JSON.stringify(dir) + ",",
      "  outputDir: " + JSON.stringify(resultsDir) + ",",
      '  testMatch: "**/independent.spec.ts",',
      "  workers: 1,",
      '  reporter: "line",',
      '  use: { browserName: "chromium" },',
      "};",
      "",
    ].join("\n"));
    return await execute(process.execPath, [
      resolve("node_modules/@playwright/test/cli.js"), "test", "--config", config,
    ], { cwd: process.cwd(), timeout: 40_000, env: { ...process.env, TEST_BASE_URL: environmentURL } });
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

test("portable TypeScript passes in a separate Playwright process with live intent targets", async ({}, info) => {
  const source = generatePlaywrightSpec(withIntent(await example()), {
    baseURL, timeoutMs: 1500,
  });
  expect(source).toContain('import { test, expect, type Page, type Locator } from "@playwright/test";');
  expect(source).toContain("async function intentLocator(");
  expect(source).toContain("await target.check()");
  expect(source).not.toMatch(/from\s+["'][^"']*(?:src\/|ai-ui-testing-agent)[^"']*["']/);
  expect(source).not.toContain("GROQ_API_KEY");
  const result = await executePortable(source, info.outputPath("portable"));
  expect(result.stdout + result.stderr).toMatch(/1 passed/);
});

test("exported assertion mismatch fails independently without weakening the expectation", async ({}, info) => {
  const definition = await example();
  const action = definition.steps[1].action;
  if (action.kind !== "assert-text") throw new Error("Expected text assertion");
  action.expected = "Wrong count — must fail";
  const source = generatePlaywrightSpec(definition, { baseURL, timeoutMs: 500 });
  expect(source).toContain("Wrong count — must fail");
  let failure: { code?: string | number; stdout?: string; stderr?: string } | undefined;
  try {
    await executePortable(source, info.outputPath("failure"));
  } catch (error) {
    failure = error as typeof failure;
  }
  expect(failure).toBeDefined();
  expect(failure?.code).toBe(1);
  expect((failure?.stdout ?? "") + (failure?.stderr ?? "")).toMatch(/1 failed/);
});

test("export supports every action, escapes content and permits origin overrides", async () => {
  const definition = await example();
  definition.title = 'Quotes " $(touch never) \n suspicious title';
  definition.steps[0].description = 'Description with "); process.exit(1); //';
  definition.steps[0].action = { kind: "navigate", url: baseURL + "/?scenario=1" };
  definition.steps[1].action = {
    kind: "assert-url", expected: baseURL + "/?scenario=1", provenance: "requirements",
  };
  definition.steps[2].action = {
    kind: "select-option", target: { by: "role", role: "combobox", name: "Shipping" }, value: "fast",
  };
  definition.steps[3].action = {
    kind: "check", target: { by: "role", role: "checkbox", name: "Terms" },
  };
  definition.steps[4].action = {
    kind: "uncheck", target: { by: "label", value: "Terms" },
  };
  definition.steps[5].action = {
    kind: "press", target: { by: "role", role: "textbox", name: "Command" }, key: "Enter",
  };
  definition.steps[6].action = {
    kind: "assert-count", target: { by: "role", role: "button", name: "Save" },
    expected: 0, provenance: "inferred",
  };
  definition.steps[7].action = {
    kind: "assert-visible", target: { by: "text", value: "Ready" }, provenance: "human-confirmed",
  };
  definition.steps[8].action = {
    kind: "click", target: { by: "role", role: "button", name: "Finish" },
  };
  const source = generatePlaywrightSpec(definition, { baseURL, timeoutMs: 1000 });
  expect(source).toContain('await target.selectOption("fast")');
  expect(source).toContain("await target.check()");
  expect(source).toContain("await target.uncheck()");
  expect(source).toContain('await target.press("Enter")');
  expect(source).toContain("await expect(target).toHaveCount(0");
  expect(source).toContain('toHaveURL(sameOriginURL("/?scenario=1")');
  expect(source).not.toContain('sameOriginURL("http://127.0.0.1:3000/?scenario=1")');
  expect(source).toContain("Assertion provenance: inferred");
  expect(source).toContain(JSON.stringify(definition.title));
  expect(source).toContain(JSON.stringify("1. " + definition.steps[0].description));
  expect(source.match(/^import .*from/gm)).toHaveLength(1);
  expect(source).not.toContain("async function intentLocator");
});

test("export rejects cross-origin URL assertions, navigation and malformed input", async () => {
  const definition = await example();
  expect(() => generatePlaywrightSpec(definition, { baseURL: "file:///tmp/site" })).toThrow();
  const changed = structuredClone(definition);
  changed.steps[0].action = { kind: "navigate", url: "https://unrelated.example/" };
  expect(() => generatePlaywrightSpec(changed, { baseURL })).toThrow(/origin/);
  changed.steps[0].action = { kind: "navigate", url: "/" };
  changed.steps[1].action = {
    kind: "assert-url", expected: "https://unrelated.example/path", provenance: "requirements",
  };
  expect(() => generatePlaywrightSpec(changed, { baseURL })).toThrow(/origin/);
  expect(() => generatePlaywrightSpec(definition, { baseURL, timeoutMs: -1 })).toThrow(/timeout/);
  expect(() => generatePlaywrightSpec({ schemaVersion: 1, steps: [] }, { baseURL })).toThrow();
});

test("CLI exports a standalone spec without starting a browser", async ({}, info) => {
  const target = info.outputPath("cli-export.spec.ts");
  const result = await execute(process.execPath, [
    "dist/cli.js", "export", "examples/add-task.json",
    "--base-url", baseURL, "--output", target,
  ], { cwd: process.cwd(), timeout: 10000 });
  expect(result.stdout).toContain("Exported standalone Playwright TypeScript");
  const source = await readFile(target, "utf8");
  expect(source).toContain('test("Add, complete and delete a task"');
  expect(source).not.toContain('from "./runner.js"');
});

test("review UI exports only approved saved tests and never creates an extra file", async ({ browser, page }) => {
  const dir = await mkdtemp(join(tmpdir(), "review-export-"));
  const server: Server = await createReviewServer(dir, browser);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  try {
    await page.goto(url);
    const link = page.getByRole("link", { name: "Export Playwright (.spec.ts)" });
    await expect(link).toBeHidden();
    await page.getByLabel("Your test instructions").fill("Create a task and then remove it.");
    await page.getByLabel("Generate with").selectOption("fixture");
    await page.getByRole("button", { name: "Generate draft" }).click();
    await expect(page.locator(".step")).toHaveCount(9);
    await expect(link).toBeHidden();
    for (const checkbox of await page.locator(".step input[type=checkbox]").all()) {
      await checkbox.check();
    }
    await page.getByRole("button", { name: "Approve and save JSON test" }).click();
    await expect(page.locator("#saved")).toContainText("Saved and ready to execute");
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    if (!href) throw new Error("Download link was not generated");
    expect(href).toMatch(/^\/api\/tests\/reviewed-\d{13}-[a-f0-9]{8}\.json\/export\.ts\?/);
    const response = await fetch(url + href);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(/attachment; filename="reviewed-.*\.spec\.ts"/);
    const contents = await response.text();
    expect(contents).toContain('import { test, expect');
    const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
    expect(download.suggestedFilename()).toMatch(/^reviewed-\d{13}-[a-f0-9]{8}\.spec\.ts$/);
    const invalid = await fetch(url + href.replace(/timeoutMs=5000/, "timeoutMs=-20"));
    expect(invalid.status).toBe(400);
    const missing = await fetch(url +
      "/api/tests/reviewed-1700000000000-deadbeef.json/export.ts?baseURL=" +
      encodeURIComponent(baseURL));
    expect(missing.status).toBe(400);
    const wrongOrigin = await fetch(url + href.replace(
      encodeURIComponent(baseURL), encodeURIComponent("file:///tmp/private")));
    expect(wrongOrigin.status).toBe(400);
    const files = await readdir(dir);
    expect(files.filter((name) => name.endsWith(".spec.ts"))).toHaveLength(0);
  } finally {
    await new Promise<void>((done, reject) => server.close((err) => err ? reject(err) : done()));
    await rm(dir, { force: true, recursive: true });
  }
});
