import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { runTest } from "../src/runner.js";
import { createReviewServer } from "../src/review-server.js";
import type { TestDefinition } from "../src/domain.js";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { approvedPath, listApprovedIds } from "./helpers/saved-files.js";
import { tmpdir } from "node:os";

test.use({ trace: "off" });

function caseDefinition(): TestDefinition {
  return {
    schemaVersion: 1, version: 1, id: "new-actions", title: "Forms and URL actions",
    steps: [
      { id: "open", description: "Open fixture", action: { kind: "navigate", url: "/" } },
      { id: "url", description: "Initial URL", action: {
        kind: "assert-url", expected: "/", provenance: "requirements",
      } },
      { id: "none", description: "Zero missing buttons", action: {
        kind: "assert-count", target: { by: "role", role: "button", name: "Absent" },
        expected: 0, provenance: "requirements",
      } },
      { id: "two", description: "Two duplicate buttons", action: {
        kind: "assert-count", target: { by: "role", role: "button", name: "Duplicate" },
        expected: 2, provenance: "requirements",
      } },
      { id: "shipping", description: "Select express delivery", action: {
        kind: "select-option", target: { by: "intent", value: "Shipping", role: "combobox" }, value: "fast",
      } },
      { id: "shipping-text", description: "Selected delivery", action: {
        kind: "assert-text", target: { by: "role", role: "status", name: "Shipping result" },
        expected: "fast", provenance: "requirements",
      } },
      { id: "check", description: "Check terms", action: {
        kind: "check", target: { by: "intent", value: "Accept terms", role: "checkbox" },
      } },
      { id: "checked", description: "Terms checked", action: {
        kind: "assert-text", target: { by: "role", role: "status", name: "Terms result" },
        expected: "checked", provenance: "requirements",
      } },
      { id: "uncheck", description: "Uncheck terms", action: {
        kind: "uncheck", target: { by: "role", role: "checkbox", name: "Accept terms" },
      } },
      { id: "unchecked", description: "Terms unchecked", action: {
        kind: "assert-text", target: { by: "role", role: "status", name: "Terms result" },
        expected: "unchecked", provenance: "requirements",
      } },
      { id: "radio", description: "Choose Option B", action: {
        kind: "check", target: { by: "role", role: "radio", name: "Option B" },
      } },
      { id: "radio-result", description: "Selected option", action: {
        kind: "assert-text", target: { by: "role", role: "status", name: "Radio result" },
        expected: "b", provenance: "requirements",
      } },
      { id: "press", description: "Press Enter in command", action: {
        kind: "press", target: { by: "role", role: "textbox", name: "Command" }, key: "Enter",
      } },
      { id: "pressed", description: "Enter processed", action: {
        kind: "assert-text", target: { by: "role", role: "status", name: "Command result" },
        expected: "Enter received", provenance: "requirements",
      } },
      { id: "receipt", description: "Open receipt", action: { kind: "navigate", url: "/receipt?ok=1" } },
      { id: "receipt-url", description: "Correct path and query", action: {
        kind: "assert-url", expected: "/receipt?ok=1", provenance: "requirements",
      } },
    ],
  };
}

function testSite(): Server {
  return createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (req.url?.startsWith("/receipt")) {
      res.end("<title>Receipt</title><h1>Receipt</h1>");
      return;
    }
    res.end(`<!doctype html><title>Action fixture</title>
      <label>Shipping<select id="shipping"><option value="">Choose</option><option value="fast">Express</option></select></label>
      <div role="status" aria-label="Shipping result" id="shipping-result">none</div>
      <label>Accept terms <input type="checkbox" id="terms"></label>
      <div role="status" aria-label="Terms result" id="terms-result">unchecked</div>
      <label>Option A <input type="radio" name="option" value="a"></label>
      <label>Option B <input type="radio" name="option" value="b"></label>
      <div role="status" aria-label="Radio result" id="radio-result">none</div>
      <label>Command <input type="text" id="command"></label>
      <div role="status" aria-label="Command result" id="command-result">none</div>
      <button>Duplicate</button><button>Duplicate</button>
      <script>
        document.querySelector('#shipping').addEventListener('change', e =>
          document.querySelector('#shipping-result').textContent = e.target.value);
        document.querySelector('#terms').addEventListener('change', e =>
          document.querySelector('#terms-result').textContent = e.target.checked ? 'checked' : 'unchecked');
        document.querySelectorAll('[name=option]').forEach(node =>
          node.addEventListener('change', e => document.querySelector('#radio-result').textContent = e.target.value));
        document.querySelector('#command').addEventListener('keydown', e => {
          if (e.key === 'Enter') document.querySelector('#command-result').textContent = 'Enter received';
        });
      </script>`);
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return "http://127.0.0.1:" + (server.address() as AddressInfo).port;
}
async function close(server: Server) {
  // Review UI requests can leave idle HTTP keep-alive connections open after
  // the final assertion. Close the listener, then terminate idle sockets so
  // test teardown cannot exceed Playwright's 30-second test timeout.
  await new Promise<void>((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
    server.closeIdleConnections();
    server.closeAllConnections();
  });
}

test("runner executes dropdown, checkbox, radio, keyboard and URL/count assertions", async ({ browser }, info) => {
  const server = testSite();
  const baseURL = await listen(server);
  try {
    const report = await runTest(caseDefinition(), {
      baseURL, outputDir: info.outputPath("new-actions"), timeoutMs: 1500,
    }, browser);
    expect(report.status, JSON.stringify(report, null, 2)).toBe("passed");
    expect(report.steps).toHaveLength(16);
    expect(report.steps.find((s) => s.id === "none")?.observed).toBe("0");
    expect(report.steps.find((s) => s.id === "two")?.observed).toBe("2");
    expect(report.steps.find((s) => s.id === "receipt-url")?.observed).toBe(baseURL + "/receipt?ok=1");
    expect(report.steps.every((s) => s.status === "passed")).toBe(true);
  } finally {
    await close(server);
  }
});

test("wrong counts and URLs are assertion failures with expected/observed evidence", async ({ browser }, info) => {
  const server = testSite();
  const baseURL = await listen(server);
  try {
    for (const broken of ["two", "url"]) {
      const definition = caseDefinition();
      const action = definition.steps.find((s) => s.id === broken)!.action;
      if (action.kind === "assert-count") action.expected = 3;
      if (action.kind === "assert-url") action.expected = "/unexpected";
      const report = await runTest(definition, {
        baseURL, outputDir: info.outputPath(broken), timeoutMs: 300,
      }, browser);
      expect(report.status).toBe("assertion-failed");
      const failed = report.steps.find((s) => s.id === broken)!;
      expect(failed.status).toBe("assertion-failed");
      expect(failed.observed).toBe(broken === "two" ? "2" : baseURL + "/");
      expect(failed.error).toContain(broken === "two" ? "Count assertion failed" : "URL assertion failed");
      expect(report.artifacts.screenshot).toBe("failure.png");
      expect(report.artifacts.trace).toBe("trace.zip");
    }
  } finally {
    await close(server);
  }
});

test("UI renders and allows editing of generated new action fields without manual JSON", async ({ browser, page }) => {
  const server = testSite();
  const baseURL = await listen(server);
  const dir = await mkdtemp(join(tmpdir(), "action-review-"));
  const definition = caseDefinition();
  const review = await createReviewServer(dir, browser, async () => JSON.stringify({
    ...definition,
    // The Groq test double must provide a proposed mapping for the explicitly
    // requested workflow, otherwise the preservation gate correctly blocks it.
    coverage: { entries: [{
      id: "R1",
      interpretation: "Exercise all available form actions",
      stepIds: definition.steps.map(step => step.id),
      availability: "identified",
    }] },
  }));
  const reviewURL = await listen(review);
  try {
    await page.goto(reviewURL);
    await page.locator("#base-url").fill(baseURL);
    await page.locator("#test-name").fill("Add, complete and delete a task");
    await page.getByLabel("Your test instructions").fill("Exercise all available form actions");
    await page.getByLabel("Generate with").selectOption("groq");
    await page.getByRole("button", { name: "Generate draft" }).click();
    await expect(page.locator("#generation-status")).toContainText("Draft ready", { timeout: 15000 });
    await expect(page.locator("#step-list")).toContainText('Select option value "fast"');
    await expect(page.locator("#step-list")).toContainText("Check");
    await expect(page.locator("#step-list")).toContainText("Press Enter");
    await expect(page.locator("#step-list")).toContainText("matches 2 elements");

    const selectCard = page.locator(".step").nth(4);
    await selectCard.getByRole("button", { name: "Edit fields" }).click();
    await expect(selectCard.getByLabel("Option value")).toHaveValue("fast");
    await selectCard.getByLabel("Option value").fill("");
    await selectCard.getByRole("button", { name: "Apply changes" }).click();
    await expect(selectCard).toContainText('Select option value ""');

    const urlCard = page.locator(".step").nth(1);
    await urlCard.getByRole("button", { name: "Edit fields" }).click();
    await urlCard.getByLabel("Expected URL / path").fill("/receipt");
    await urlCard.getByRole("button", { name: "Apply changes" }).click();
    await expect(urlCard).toContainText('Verify current URL equals "/receipt"');

    const countCard = page.locator(".step").nth(3);
    await countCard.getByRole("button", { name: "Edit fields" }).click();
    await expect(countCard.getByLabel("Expected element count")).toHaveValue("2");
    await countCard.getByLabel("Expected element count").fill("1");
    await countCard.getByRole("button", { name: "Apply changes" }).click();
    await expect(countCard).toContainText("matches 1 elements");

    for (const box of await page.locator(".step input[type=checkbox]").all()) await box.check();
    await page.locator("#save-test-name").fill("Add, complete and delete a task");
    await page.getByRole("button", { name: "Save Test" }).click();
    await expect(page.locator("#saved")).toContainText("Saved and ready to execute");
    const names = (await listApprovedIds(dir));
    expect(names).toHaveLength(1);
    const saved = JSON.parse(await readFile(await approvedPath(dir, names[0]), "utf8")) as TestDefinition;
    expect(saved.steps[4].action).toMatchObject({ kind: "select-option", value: "" });
    expect(saved.steps[1].action).toMatchObject({ kind: "assert-url", expected: "/receipt" });
    expect(saved.steps[3].action).toMatchObject({ kind: "assert-count", expected: 1 });
  } finally {
    await close(review);
    await close(server);
    await rm(dir, { force: true, recursive: true });
  }
});
