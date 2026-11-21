import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ensureAllowedNavigation } from "../src/inspect.js";
import { generateDraft, makeGenerationPrompt } from "../src/generation.js";
import { runTest } from "../src/runner.js";
import { preflightSelectors } from "../src/preflight.js";
import { generatePlaywrightSpec } from "../src/export.js";

test.use({ trace: "off" });

const appHTML = `<!doctype html>
<html lang="en"><head><title>TodoMVC fixture</title></head><body>
  <main>
    <h1>todos</h1>
    <label for="todo">What needs to be done?</label>
    <input id="todo" autocomplete="off" />
    <ul id="tasks"></ul>
    <p role="status">0 items left</p>
  </main>
  <script>
    const input = document.querySelector('#todo');
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || !input.value.trim()) return;
      const item = document.createElement('li');
      item.textContent = input.value.trim();
      document.querySelector('#tasks').appendChild(item);
      document.querySelector('[role=status]').textContent =
        document.querySelectorAll('#tasks li').length + ' item left';
      input.value = '';
    });
  </script>
</body></html>`;

function testDefinition() {
  return {
    schemaVersion: 1, id: "todomvc-groceries", title: "Buy groceries in TodoMVC",
    version: 1,
    steps: [
      { id: "open", description: "Open configured TodoMVC application", action: {
        kind: "navigate", url: "/",
      } },
      { id: "fill", description: "Enter Buy groceries", action: {
        kind: "fill", target: { by: "label", value: "What needs to be done?" },
        value: "Buy groceries",
      } },
      { id: "enter", description: "Submit by pressing Enter", action: {
        kind: "press", target: { by: "label", value: "What needs to be done?" },
        key: "Enter",
      } },
      { id: "visible", description: "Buy groceries appears in the list", action: {
        kind: "assert-visible", target: { by: "text", value: "Buy groceries" },
        provenance: "requirements",
      } },
      { id: "count", description: "One item is left", action: {
        kind: "assert-text", target: { by: "role", role: "status" },
        expected: "1 item left", provenance: "requirements",
      } },
      { id: "url", description: "We have not left the TodoMVC app", action: {
        kind: "assert-url", expected: "/", provenance: "requirements",
      } },
    ],
  };
}
async function site(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    if (req.url !== "/todomvc/") {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end("<h1>404 Not Found</h1>");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(appHTML);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: "http://127.0.0.1:" +
    (server.address() as AddressInfo).port + "/todomvc/#/" };
}
async function stop(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()));
}

test("a bare / navigates to the configured nested hash app, never the 404 origin root", async ({ browser }, info) => {
  const { server, url } = await site();
  try {
    const base = new URL(url);
    expect(ensureAllowedNavigation("/", base).href).toBe(url);
    expect(ensureAllowedNavigation("#/active", base).href)
      .toBe(url.replace("#/", "#/active"));
    expect(ensureAllowedNavigation("/todomvc/#/active", base).href)
      .toBe(url.replace("#/", "#/active"));
    expect(ensureAllowedNavigation(base.origin + "/", base).href).toBe(base.origin + "/");
    expect(() => ensureAllowedNavigation("https://unrelated.example/", base))
      .toThrow(/origin/);

    // This is a previously saved script with the old first-step shorthand.
    const report = await runTest(testDefinition(), {
      baseURL: url, outputDir: info.outputPath("nested-todomvc"), timeoutMs: 1500,
    }, browser);
    expect(report.status, JSON.stringify(report, null, 2)).toBe("passed");
    expect(report.steps.every((step) => step.status === "passed")).toBe(true);
    expect(report.steps.find((step) => step.id === "url")?.observed).toBe(url);

    // The read-only preflight and Playwright exporter must resolve / alike.
    const preflight = await preflightSelectors(testDefinition(), url, browser);
    expect(preflight.inspectedURL).toBe(url);
    const standalone = generatePlaywrightSpec(testDefinition(), {
      baseURL: url, timeoutMs: 1500,
    });
    expect(standalone).toContain('sameOriginURL("/todomvc/#/")');
    expect(standalone).not.toContain('sameOriginURL("/")');
  } finally {
    await stop(server);
  }
});

test("generated draft uses the snapshot's exact TodoMVC URL, including /todomvc/#/", async ({ browser }, info) => {
  const { server, url } = await site();
  try {
    const draft = await generateDraft({
      baseURL: url, model: "test-stub",
      requirements: 'Enter "Buy groceries", press Enter and verify it appears.',
    }, async () => JSON.stringify(testDefinition()), browser);
    const first = draft.definition.steps[0].action;
    expect(first.kind).toBe("navigate");
    if (first.kind !== "navigate") throw new Error("Expected navigation");
    expect(first.url).toBe(url);
    expect(draft.snapshot.url).toBe(url);

    const system = makeGenerationPrompt("Add a task", draft.snapshot).system;
    expect(system).toContain("FIRST step MUST use exactly the page snapshot URL");
    expect(system).toContain(JSON.stringify(url));
    expect(system).not.toContain("Navigate action: {kind:'navigate',url:'/'}");

    const report = await runTest(draft.definition, {
      baseURL: url, outputDir: info.outputPath("generated-todomvc"), timeoutMs: 1500,
    }, browser);
    expect(report.status, JSON.stringify(report, null, 2)).toBe("passed");
    expect(report.steps.find((step) => step.id === "visible")?.status).toBe("passed");
  } finally {
    await stop(server);
  }
});
