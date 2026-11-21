import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createReviewServer } from "../src/review-server.js";
import { runTest } from "../src/runner.js";
import { preflightSelectors } from "../src/preflight.js";
import { approvedPath } from "./helpers/saved-files.js";

test.use({ trace: "off" });

const googleLikeHTML = `<!doctype html><html lang="en"><head>
<title>Mock search engine</title></head><body>
<form id="search-form">
  <input name="q" role="combobox" aria-label="Search" autocomplete="off" />
  <div class="autocomplete">
    <input name="btnK" type="submit" role="button" value="Google Search"
           aria-label="Google Search" />
  </div>
  <div class="main-buttons">
    <input name="btnK" type="submit" role="button" value="Google Search"
           aria-label="Google Search" />
  </div>
</form>
<p role="status"></p>
<script>
  document.querySelector('#search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    document.querySelector('[role=status]').textContent =
      'Results for ' + document.querySelector('[name=q]').value;
  });
</script>
</body></html>`;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return "http://127.0.0.1:" + (server.address() as AddressInfo).port;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((done, reject) =>
    server.close((error) => error ? reject(error) : done()));
}
function definition() {
  return {
    schemaVersion: 1, id: "search-speed", title: "Search for speed test",
    version: 1,
    steps: [
      { id: "open", description: "Open search engine", action: {
        kind: "navigate", url: "/",
      } },
      { id: "fill", description: "Search for speed test", action: {
        kind: "fill", target: { by: "role", role: "combobox", name: "Search" },
        value: "speed test",
      } },
      { id: "click", description: "Click Google Search", action: {
        kind: "click", target: { by: "role", role: "button", name: "Google Search" },
      } },
      { id: "results", description: "Results are visible", action: {
        kind: "assert-text", target: { by: "role", role: "status" },
        expected: "Results for speed test", provenance: "requirements",
      } },
    ],
  };
}

for (const nth of [0, 1]) {
  test("identical Google Search buttons offer reviewed match " + (nth + 1) +
      " and rerun successfully", async ({ browser, page }) => {
    const dir = await mkdtemp(join(tmpdir(), "google-buttons-"));
    const website = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(googleLikeHTML);
    });
    let review: Server | undefined;
    try {
      const baseURL = await listen(website);
      review = await createReviewServer(dir, browser);
      const reviewURL = await listen(review);
      const approval = await page.request.post(reviewURL + "/api/save", {
        data: { definition: definition(), baseURL },
      });
      expect(approval.status()).toBe(200);
      const saved = await approval.json();
      await page.goto(reviewURL);
      await page.getByLabel("Approved saved test").selectOption(saved.id);
      await page.getByRole("button", { name: "Run selected test" }).click();
      await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 25000 });
      await expect(page.locator("#run-summary")).toContainText("FAILED");

      const originalLink = await page.getByRole("link", { name: "View full JSON report" })
        .getAttribute("href");
      expect(originalLink).toBeTruthy();
      const report = await (await page.request.get(reviewURL + originalLink)).json();
      expect(report.steps[1].status).toBe("passed");
      expect(report.steps[2].status).toBe("execution-error");
      expect(report.steps[2].error).toMatch(/strict mode violation/);
      expect(report.steps[3].status).toBe("skipped");
      expect(report.steps[2].locatorAlternatives).toMatchObject({
        total: 2, attempted: { by: "role", role: "button", name: "Google Search" },
      });
      expect(report.steps[2].locatorAlternatives.candidates.map(
        (candidate: { nth: number }) => candidate.nth)).toEqual([0, 1]);

      const repair = page.locator("#run-steps .locator-repair").first();
      await expect(repair).toBeVisible();
      await expect(repair.locator(".locator-option")).toHaveCount(2);
      await expect(repair.locator(".locator-option").nth(0)).toContainText("match 1 of 2");
      await expect(repair.locator(".locator-option").nth(1)).toContainText("match 2 of 2");
      await repair.locator(".locator-option").nth(nth).locator("input").check();
      await expect(repair.locator(".repair-feedback"))
        .toContainText("page's current element order");
      await repair.getByRole("button", { name: "Save corrected locator and rerun from start" })
        .click();
      await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 25000 });
      await expect(page.locator("#run-summary")).toContainText("PASSED");

      const updatedId = await page.getByLabel("Approved saved test").inputValue();
      expect(updatedId).not.toBe(saved.id);
      const corrected = JSON.parse(await readFile(await approvedPath(dir, updatedId), "utf8"));
      expect(corrected.steps[2].action.target).toEqual({
        by: "role", role: "button", name: "Google Search", nth,
      });
      expect(corrected.steps[3].action.expected).toBe("Results for speed test");
      expect((await page.request.get(reviewURL + "/api/tests/" + saved.id)).status())
        .toBe(404);
      const exported = await page.request.get(reviewURL + "/api/tests/" + updatedId +
        "/export.ts?baseURL=" + encodeURIComponent(baseURL));
      expect(exported.status()).toBe(200);
      expect(await exported.text()).toContain(
        'page.getByRole("button", { name: "Google Search", exact: true }).nth(' + nth + ')');
      const preflight = await preflightSelectors(corrected, baseURL, browser);
      expect(preflight.findings.find((item) => item.stepId === "click")?.matches).toBe(1);
    } finally {
      if (review) await close(review);
      await close(website);
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("pressing Enter on unique search combobox works without choosing duplicate submit buttons", async ({ browser }, info) => {
  const website = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(googleLikeHTML);
  });
  try {
    const baseURL = await listen(website);
    const def = definition();
    def.steps[2].action = {
      kind: "press", target: { by: "role", role: "combobox", name: "Search" },
      key: "Enter",
    } as typeof def.steps[number]["action"];
    const report = await runTest(def, {
      baseURL, outputDir: info.outputPath("press-enter-search"), timeoutMs: 2000,
    }, browser);
    expect(report.status, JSON.stringify(report, null, 2)).toBe("passed");
  } finally {
    await close(website);
  }
});
