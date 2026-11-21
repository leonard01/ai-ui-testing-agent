import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createReviewServer } from "../src/review-server.js";
import { approvedPath } from "./helpers/saved-files.js";

test.use({ trace: "off" });

const markup = `<!doctype html><html lang="en"><head><title>TodoMVC-like page</title></head><body>
  <section class="todoapp">
    <header><input placeholder="What needs to be done?" id="new-todo"></header>
    <section class="main"><ul class="todo-list"></ul></section>
    <footer><strong id="todo-count">0 items left</strong></footer>
  </section>
  <script>
    const field = document.querySelector("#new-todo");
    field.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !field.value.trim()) return;
      const li = document.createElement("li");
      li.className = "todo";
      const view = document.createElement("div");
      view.className = "view";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "toggle";
      const label = document.createElement("label");
      label.textContent = field.value.trim();
      view.append(box, label);
      li.append(view);
      document.querySelector(".todo-list").append(li);
      document.querySelector("#todo-count").textContent = "1 item left";
      field.value = "";
    });
  </script>
</body></html>`;

async function start(server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return "http://127.0.0.1:" + (server.address() as AddressInfo).port;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((done, reject) =>
    server.close((error) => error ? reject(error) : done()));
}
function definition(target: unknown) {
  return {
    schemaVersion: 1, id: "todo-text-assertion", title: "Verify Buy groceries item",
    version: 1,
    steps: [
      { id: "open", description: "Open TodoMVC", action: {
        kind: "navigate", url: "/todomvc/#/",
      } },
      { id: "fill", description: "Enter Buy groceries", action: {
        kind: "fill", target: { by: "placeholder", value: "What needs to be done?" },
        value: "Buy groceries",
      } },
      { id: "enter", description: "Press Enter", action: {
        kind: "press", target: { by: "placeholder", value: "What needs to be done?" },
        key: "Enter",
      } },
      { id: "verify-item", description: "Buy groceries must appear", action: {
        kind: "assert-visible", target, provenance: "requirements",
      } },
      { id: "verify-count", description: "One item left", action: {
        kind: "assert-text", target: { by: "text", value: "1 item left" },
        expected: "1 item left", provenance: "requirements",
      } },
    ],
  };
}

for (const [description, wrongTarget] of [
  ["incorrect heading role", { by: "role", role: "heading", name: "Buy groceries" }],
  ["unresolvable list item intent", { by: "intent", role: "listitem", value: "Buy groceries" }],
] as const) {
  test("visible task text offers a verified locator repair for " + description, async ({ browser, page }) => {
    const dir = await mkdtemp(join(tmpdir(), "todo-assert-repair-"));
    const website = createServer((req, res) => {
      res.writeHead(req.url?.startsWith("/todomvc/") ? 200 : 404,
        { "Content-Type": "text/html; charset=utf-8" });
      res.end(req.url?.startsWith("/todomvc/") ? markup : "<h1>404</h1>");
    });
    let review: Server | undefined;
    try {
      const appURL = await start(website);
      review = await createReviewServer(dir, browser);
      const reviewURL = await start(review);
      const saved = await page.request.post(reviewURL + "/api/save", {
        data: { definition: definition(wrongTarget), baseURL: appURL + "/todomvc/#/" },
      });
      expect(saved.status(), await saved.text()).toBe(200);
      const id = (await saved.json()).id;
      await page.goto(reviewURL);
      await page.getByLabel("Approved saved test").selectOption(id);
      await page.getByRole("button", { name: "Run selected test" }).click();
      await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 25000 });
      await expect(page.locator("#run-summary")).toContainText("FAILED");
      const failed = page.locator("#run-steps .run-step").nth(3);
      await expect(failed).toContainText("execution-error");
      await expect(failed.locator(".assertion-dom-repair")).toBeVisible();
      const radio = failed.locator(".assertion-dom-option");
      await expect(radio).toHaveCount(1);
      await expect(radio).toContainText('Visible text "Buy groceries"');
      const reportLink = await page.getByRole("link", { name: "View full JSON report" })
        .getAttribute("href");
      expect(reportLink).toBeTruthy();
      const report = await (await page.request.get(reviewURL + reportLink)).json();
      expect(report.steps[2].status).toBe("passed");
      expect(report.steps[3].actionKind).toBe("assert-visible");
      expect(report.steps[3].assertionAlternatives.candidates[0].target)
        .toEqual({ by: "text", value: "Buy groceries" });
      await radio.locator("input").check();
      await failed.getByRole("button", { name: "Save corrected assertion target and rerun" }).click();
      await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 25000 });
      await expect(page.locator("#run-summary")).toContainText("PASSED");
      const updated = await page.getByLabel("Approved saved test").inputValue();
      const amended = JSON.parse(await readFile(await approvedPath(dir, updated), "utf8"));
      expect(amended.steps[3].action).toEqual({
        kind: "assert-visible", target: { by: "text", value: "Buy groceries" },
        provenance: "requirements",
      });
      expect(amended.steps[4].action.expected).toBe("1 item left");
    } finally {
      if (review) await close(review);
      await close(website);
      await rm(dir, { force: true, recursive: true });
    }
  });
}

test("unverified locator still offers direct manual edit of the failing assertion", async ({ browser, page }) => {
  const dir = await mkdtemp(join(tmpdir(), "todo-assert-manual-"));
  const website = createServer((req, res) => {
    res.writeHead(req.url?.startsWith("/todomvc/") ? 200 : 404,
      { "Content-Type": "text/html; charset=utf-8" });
    res.end(req.url?.startsWith("/todomvc/") ? markup : "<h1>404</h1>");
  });
  let review: Server | undefined;
  try {
    const appURL = await start(website);
    review = await createReviewServer(dir, browser);
    const reviewURL = await start(review);
    const saved = await page.request.post(reviewURL + "/api/save", {
      data: {
        definition: definition({ by: "role", role: "heading", name: "Entirely absent phrase" }),
        baseURL: appURL + "/todomvc/#/",
      },
    });
    expect(saved.status()).toBe(200);
    const id = (await saved.json()).id;
    await page.goto(reviewURL);
    await page.getByLabel("Approved saved test").selectOption(id);
    await page.getByRole("button", { name: "Run selected test" }).click();
    await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 25000 });
    const failed = page.locator("#run-steps .run-step").nth(3);
    await expect(failed.locator(".assertion-dom-option")).toHaveCount(0);
    const manual = failed.getByRole("button", { name: "Edit failing assertion locator" });
    await expect(manual).toBeEnabled();
    await manual.click();
    await expect(page.locator("#draft-title")).toContainText("Editing Verify Buy groceries item");
    const step = page.locator("#step-list .step").nth(3);
    await expect(step).toContainText("Locator strategy");
    await expect(step.locator("select").first()).toHaveValue("role");
    await expect(step).toContainText("Entirely absent phrase");
    await expect(page.locator("#draft-hint")).toContainText("Loaded an approved test for editing");
  } finally {
    if (review) await close(review);
    await close(website);
    await rm(dir, { force: true, recursive: true });
  }
});
