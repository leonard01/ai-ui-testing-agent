import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createReviewServer } from "../src/review-server.js";
import { approvedPath } from "./helpers/saved-files.js";

test.use({ trace: "off" });

const html = (separateForm = false) => `<!doctype html>
<html lang="en"><head><title>Search with blocked button</title>
<style>
  #holder { position:relative; width:175px; height:36px; margin-top:14px; }
  #holder input { position:absolute; inset:0; width:100%; height:100%; }
  #overlay { position:absolute; inset:0; z-index:5; background:rgba(255,255,255,.3);
    pointer-events:auto; }
</style></head><body>
<form id="search-form">
  <input aria-label="Search" role="combobox" name="q" autocomplete="off" />
  ${separateForm ? '</form><form id="other-form">' : ''}
  <div id="holder"><input type="submit" role="button" value="Google Search"
       aria-label="Google Search" /><span id="overlay">Suggestions</span></div>
</form>
<p role="status"></p>
<script>
  document.querySelector('#search-form').addEventListener('submit', e => {
    e.preventDefault();
    document.querySelector('[role=status]').textContent =
      'Results for ' + document.querySelector('[name=q]').value;
  });
  document.querySelector('#other-form')?.addEventListener('submit', e => e.preventDefault());
</script>
</body></html>`;

async function listen(server: Server) {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return "http://127.0.0.1:" + (server.address() as AddressInfo).port;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
}
function definition() {
  return {
    schemaVersion: 1, id: "blocked-google-search", title: "Search speed test",
    version: 1,
    steps: [
      { id: "open", description: "Open search", action: {
        kind: "navigate", url: "/",
      } },
      { id: "fill", description: "Type search query", action: {
        kind: "fill", target: { by: "role", role: "combobox", name: "Search" },
        value: "speed test",
      } },
      { id: "click", description: "Click Google Search", action: {
        kind: "click", target: { by: "role", role: "button", name: "Google Search" },
      } },
      { id: "verify", description: "Verify search results", action: {
        kind: "assert-text", target: { by: "role", role: "status" },
        expected: "Results for speed test", provenance: "requirements",
      } },
    ],
  };
}
async function setup(browser: Parameters<typeof createReviewServer>[1], separate = false) {
  const dir = await mkdtemp(join(tmpdir(), "blocked-search-"));
  const website = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html(separate));
  });
  const baseURL = await listen(website);
  const review = await createReviewServer(dir, browser);
  const reviewURL = await listen(review);
  return { dir, website, baseURL, review, reviewURL };
}

test("unique Google Search button blocked by autocomplete offers human-approved Enter alternative", async ({ browser, page }) => {
  const site = await setup(browser);
  try {
    const approval = await page.request.post(site.reviewURL + "/api/save", {
      data: { definition: definition(), baseURL: site.baseURL },
    });
    expect(approval.status(), await approval.text()).toBe(200);
    const saved = await approval.json();
    await page.goto(site.reviewURL);
    await page.getByLabel("Approved saved test").selectOption(saved.id);
    await page.getByRole("button", { name: "Run selected test" }).click();
    await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 25000 });
    await expect(page.locator("#run-summary")).toContainText("FAILED");
    const link = await page.getByRole("link", { name: "View full JSON report" }).getAttribute("href");
    expect(link).toBeTruthy();
    const before = await (await page.request.get(site.reviewURL + link)).json();
    expect(before.steps[1].status).toBe("passed");
    expect(before.steps[2].error).toContain("intercepts pointer events");
    expect(before.steps[2].locatorAlternatives).toBeUndefined();
    expect(before.steps[2].blockedClick).toEqual({
      reason: "pointer-interception",
      submitWithEnter: { sourceStepId: "fill",
        target: { by: "role", role: "combobox", name: "Search" } },
    });

    const repair = page.locator("#run-steps .locator-repair").first();
    await expect(repair).toContainText("Click blocked by another page element");
    await expect(repair).toContainText("press Enter");
    const denied = await page.request.post(site.reviewURL + "/api/repair-submit", {
      data: { runId: before.id, stepId: "click", confirmed: false },
    });
    expect(denied.status()).toBe(400);

    page.once("dialog", dialog => dialog.accept());
    await repair.getByRole("button", { name: "Use Enter to submit and rerun" }).click();
    await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 25000 });
    await expect(page.locator("#run-summary")).toContainText("PASSED");
    const currentId = await page.getByLabel("Approved saved test").inputValue();
    expect(currentId).not.toBe(saved.id);
    const corrected = JSON.parse(await readFile(await approvedPath(site.dir, currentId), "utf8"));
    expect(corrected.steps[2].action).toEqual({
      kind: "press",
      target: { by: "role", role: "combobox", name: "Search" },
      key: "Enter",
    });
    expect(corrected.steps[3].action.expected).toBe("Results for speed test");
    expect((await page.request.get(site.reviewURL + "/api/tests/" + saved.id)).status())
      .toBe(404);
  } finally {
    await close(site.review);
    await close(site.website);
    await rm(site.dir, { recursive: true, force: true });
  }
});

test("blocked submit button outside the query form never offers an unverified Enter change", async ({ browser, page }) => {
  const site = await setup(browser, true);
  try {
    const response = await page.request.post(site.reviewURL + "/api/save", {
      data: { definition: definition(), baseURL: site.baseURL },
    });
    expect(response.status()).toBe(200);
    const saved = await response.json();
    const start = await page.request.post(site.reviewURL + "/api/run", {
      data: { id: saved.id, baseURL: site.baseURL, timeoutMs: 600 },
    });
    expect(start.status()).toBe(202);
    const run = await start.json();
    let result: any;
    await expect.poll(async () => {
      const response = await page.request.get(site.reviewURL + "/api/runs/" + run.id);
      result = await response.json();
      return result.state;
    }, { timeout: 20000 }).toBe("finished");
    expect(result.report.steps[2].blockedClick).toEqual({ reason: "pointer-interception" });
    const denied = await page.request.post(site.reviewURL + "/api/repair-submit", {
      data: { runId: run.id, stepId: "click", confirmed: true },
    });
    expect(denied.status()).toBe(400);
  } finally {
    await close(site.review);
    await close(site.website);
    await rm(site.dir, { recursive: true, force: true });
  }
});
