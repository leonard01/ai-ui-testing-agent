import { expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { runTest } from "../src/runner.js";
import { discoverTarget, findAssertionAlternatives } from "../src/discovery.js";
import type { TestDefinition } from "../src/domain.js";

test.use({ trace: "off" });

const pageHtml = [
  '<!doctype html><html><body><main>',
  '<h1>User administration</h1>',
  '<button id="btn_7">Create user</button>',
  '<div id="panel"></div><ul id="users"></ul><p role="status">0 users</p>',
  '</main>',
  '<script>',
  'document.getElementById("btn_7").onclick = () => {',
  '  document.getElementById("panel").innerHTML =',
  '    \'<form><div class="row"><span>Username</span><input id="fld_73" /></div>\' +',
  '    \'<button type="submit" class="b_19">Save user</button></form>\';',
  '  document.querySelector("form").onsubmit = (event) => {',
  '    event.preventDefault();',
  '    const name = document.getElementById("fld_73").value.trim();',
  '    if (!name) return;',
  '    const li = document.createElement("li");',
  '    const span = document.createElement("span");',
  '    span.textContent = name;',
  '    const remove = document.createElement("button");',
  '    remove.textContent = "Delete " + name;',
  '    remove.onclick = () => {',
  '      li.remove();',
  '      document.querySelector(\'[role="status"]\').textContent = "0 users";',
  '    };',
  '    li.append(span, remove);',
  '    document.querySelector("#users").append(li);',
  '    document.querySelector(\'[role="status"]\').textContent = "1 user";',
  '  };',
  '};',
  '</script></body></html>',
].join("\n");

let server: Server;
let baseURL: string;
test.beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(pageHtml);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseURL = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});
test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()));
});

test("resolves intent after opening a dynamic form with a poorly labelled input", async ({ browser }, info) => {
  const definition: TestDefinition = {
    schemaVersion: 1, id: "dynamic-user-form", title: "Create and delete Bob", version: 1,
    steps: [
      { id: "open", description: "Open users", action: { kind: "navigate", url: "/" } },
      { id: "show", description: "Open user form", action: {
        kind: "click", target: { by: "intent", value: "Create user", role: "button" },
      } },
      { id: "name", description: "Enter Bob into Username", action: {
        kind: "fill", target: { by: "intent", value: "Username", role: "textbox" }, value: "Bob",
      } },
      { id: "save", description: "Save user", action: {
        kind: "click", target: { by: "intent", value: "Save user", role: "button" },
      } },
      { id: "visible", description: "Bob is visible", action: {
        kind: "assert-visible", target: { by: "intent", value: "Bob" }, provenance: "requirements",
      } },
      { id: "status", description: "One user exists", action: {
        kind: "assert-text", target: { by: "intent", value: "status", role: "status" },
        expected: "1 user", provenance: "requirements",
      } },
      { id: "delete", description: "Delete Bob", action: {
        kind: "click", target: { by: "intent", value: "Delete Bob", role: "button" },
      } },
      { id: "empty", description: "Back to zero users", action: {
        kind: "assert-text", target: { by: "intent", value: "status", role: "status" },
        expected: "0 users", provenance: "requirements",
      } },
    ],
  };
  const report = await runTest(definition, {
    baseURL, outputDir: info.outputPath("dynamic"), timeoutMs: 1200,
  }, browser);
  expect(report.status, JSON.stringify(report.steps, null, 2)).toBe("passed");
  expect(report.steps.every((step) => step.status === "passed")).toBe(true);
  const entered = report.steps.find((step) => step.id === "name");
  expect(entered?.resolution).toMatchObject({
    method: "live-dom", intent: "Username", tag: "input", role: "textbox",
  });
  expect(entered?.resolution?.nearby).toContain("Username");
  expect(report.steps.find((step) => step.id === "visible")?.resolution?.tag).toBe("span");
});

test("assertion DOM search finds visible Products span, not absent heading", async ({ browser }) => {
  const page = await browser.newPage();
  try {
    await page.setContent('<!doctype html><main><header><span class="title">Products</span></header>' +
      '<p>Browse products here</p></main>');
    const candidates = await findAssertionAlternatives(
      page, { by: "role", role: "heading", name: "Products" }, "assert-visible",
    );
    expect(candidates).toMatchObject({
      query: "Products",
      total: 1,
      candidates: [{ tag: "span", name: "Products",
        target: { by: "text", value: "Products" } }],
    });
    expect(await page.getByRole("heading", { name: "Products" }).count()).toBe(0);
    expect(await page.getByText("Products", { exact: true }).count()).toBe(1);
    const missing = await findAssertionAlternatives(
      page, { by: "role", role: "heading", name: "Invoices" }, "assert-visible",
    );
    expect(missing.candidates).toHaveLength(0);
    expect(missing.total).toBe(0);
  } finally {
    await page.close();
  }
});

test("ambiguous intent stops safely without clicking a random button", async ({ browser }, info) => {
  const tab = await browser.newPage();
  try {
    await tab.setContent("<!doctype html><button>Save</button><button>Save</button>");
    await expect(discoverTarget(tab, { by: "intent", value: "Save", role: "button" }, "click", 250))
      .rejects.toThrow(/Ambiguous intent/);
  } finally {
    await tab.close();
  }
  const definition: TestDefinition = {
    schemaVersion: 1, id: "missing-target", title: "Missing target", version: 1,
    steps: [
      { id: "open", description: "Open users", action: { kind: "navigate", url: "/" } },
      { id: "missing", description: "Target absent", action: {
        kind: "click", target: { by: "intent", value: "nonexistent", role: "button" },
      } },
      { id: "later", description: "No execution", action: {
        kind: "assert-text", target: { by: "role", role: "status" },
        expected: "0 users", provenance: "requirements",
      } },
    ],
  };
  const report = await runTest(definition, {
    baseURL, outputDir: info.outputPath("no-match"), timeoutMs: 250,
  }, browser);
  expect(report.status).toBe("execution-error");
  expect(report.steps[1].error).toContain("Could not resolve intent");
  expect(report.steps[2].status).toBe("skipped");
});

test("intent targets work for dynamically added task text in the existing demo", async ({ browser }, info) => {
  const definition: TestDefinition = {
    schemaVersion: 1, id: "task-by-intent", title: "Task by intent", version: 1,
    steps: [
      { id: "open", description: "Open", action: { kind: "navigate", url: "/" } },
      { id: "fill", description: "Enter task", action: {
        kind: "fill", target: { by: "intent", value: "Task", role: "textbox" },
        value: "Prepare interview",
      } },
      { id: "add", description: "Add task", action: {
        kind: "click", target: { by: "intent", value: "Add task", role: "button" },
      } },
      { id: "visible", description: "Check task appears", action: {
        kind: "assert-visible", target: { by: "intent", value: "Prepare interview" },
        provenance: "requirements",
      } },
    ],
  };
  const report = await runTest(definition, {
    baseURL: "http://127.0.0.1:3000", outputDir: info.outputPath("task"),
  }, browser);
  expect(report.status, JSON.stringify(report.steps, null, 2)).toBe("passed");
  expect(report.steps[2].resolution?.name).toBe("Add");
});

test("two task checkboxes reject generic Complete but resolve exact intended task", async ({ browser }) => {
  const tab = await browser.newPage();
  try {
    await tab.setContent(`<!doctype html><main>
      <label><input type="checkbox" aria-label="Complete preparing a presentation">
        preparing a presentation</label>
      <label><input type="checkbox" aria-label="Complete reviewing documentation">
        reviewing documentation</label>
    </main>`);
    await expect(discoverTarget(tab, {
      by: "intent", value: "Complete", role: "checkbox",
    }, "click", 250)).rejects.toThrow(/Ambiguous intent.*Complete/);
    await expect(discoverTarget(tab, {
      by: "intent", value: "Complete", role: "checkbox",
    }, "click", 250)).rejects.toMatchObject({
      ambiguity: {
        intent: "Complete",
        role: "checkbox",
        total: 2,
        candidates: [
          { role: "checkbox", name: "Complete preparing a presentation" },
          { role: "checkbox", name: "Complete reviewing documentation" },
        ],
      },
    });

    const resolved = await discoverTarget(tab, {
      by: "intent", value: "Complete preparing a presentation", role: "checkbox",
    }, "click", 250);
    expect(resolved.evidence.name).toBe("Complete preparing a presentation");
    await resolved.locator.check();
    await expect(tab.getByRole("checkbox", { name: "Complete preparing a presentation" })).toBeChecked();
    await expect(tab.getByRole("checkbox", { name: "Complete reviewing documentation" })).not.toBeChecked();
  } finally {
    await tab.close();
  }
});
