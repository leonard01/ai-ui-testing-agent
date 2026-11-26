import { selectSavedScript } from "./helpers/select-saved-script.js";
import { test, expect, type Browser, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReviewServer } from "../src/review-server.js";
import { approvedPath } from "./helpers/saved-files.js";

test.use({ trace: "off" });

const duplicateButtons = `<!doctype html>
<html lang="en"><head><title>Duplicate controls demo</title></head>
<body>
  <button id="add">Add Element</button><section id="buttons"></section>
  <script>
    document.querySelector("#add").addEventListener("click", () => {
      const button = document.createElement("button");
      button.textContent = "Delete";
      button.addEventListener("click", () => button.remove());
      document.querySelector("#buttons").append(button);
    });
  </script>
</body></html>`;

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return "http://127.0.0.1:" + (server.address() as AddressInfo).port;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()));
}

for (const nth of [0, 1]) {
  test("human-selected duplicate Delete button " + (nth + 1) +
    " is saved as an indexed role locator and reruns successfully", async ({ browser, page }) => {
    const dir = await mkdtemp(join(tmpdir(), "duplicate-repair-"));
    const targetServer = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(duplicateButtons);
    });
    let review: Server | undefined;
    try {
      const websiteURL = await listen(targetServer);
      review = await createReviewServer(dir, browser);
      const reviewURL = await listen(review);

      const definition = {
        schemaVersion: 1, id: "remove-one", title: "Add twice, delete once", version: 1,
        steps: [
          { id: "open", description: "Open demo", action: { kind: "navigate", url: "/" } },
          { id: "add-first", description: "Add first button", action: {
            kind: "click", target: { by: "role", role: "button", name: "Add Element" },
          } },
          { id: "add-second", description: "Add second button", action: {
            kind: "click", target: { by: "role", role: "button", name: "Add Element" },
          } },
          { id: "two-buttons", description: "Two Delete buttons are shown", action: {
            kind: "assert-count", target: { by: "role", role: "button", name: "Delete" },
            expected: 2, provenance: "requirements",
          } },
          { id: "delete", description: "Click one Delete button", action: {
            kind: "click", target: { by: "intent", value: "Delete", role: "button" },
          } },
          { id: "one-button", description: "One Delete button remains", action: {
            kind: "assert-count", target: { by: "role", role: "button", name: "Delete" },
            expected: 1, provenance: "requirements",
          } },
        ],
      };
      const savedResponse = await page.request.post(reviewURL + "/api/save", {
        data: { testName: "Regression test", definition, baseURL: websiteURL },
      });
      expect(savedResponse.status()).toBe(200);
      const saved = await savedResponse.json();

      await page.goto(reviewURL);
      await selectSavedScript(page, saved.id);
      await expect(page.locator("#execution-url")).toHaveValue(websiteURL + "/");
      await page.getByRole("button", { name: "Run selected test" }).click();
      await expect(page.locator("#run-status"))
        .toContainText("Run complete", { timeout: 25000 });
      await expect(page.locator("#run-summary")).toContainText("FAILED");

      const repair = page.locator(".repair-choice");
      await expect(repair).toBeVisible();
      await expect(repair.locator(".repair-option")).toHaveCount(2);
      await expect(repair.locator(".repair-option").nth(0)).toContainText("match 1 of 2");
      await expect(repair.locator(".repair-option").nth(1)).toContainText("match 2 of 2");
      await repair.locator(".repair-option").nth(nth).locator("input").check();
      await expect(repair.getByRole("button", { name: "Save corrected copy and rerun from start" }))
        .toBeEnabled();
      await expect(repair.locator(".repair-feedback")).toContainText(
        "match " + (nth + 1) + " using current page order");

      const firstReport = await page.getByRole("link", { name: "View full JSON report" })
        .getAttribute("href");
      if (!firstReport) throw new Error("Missing original report");
      const initial = await (await page.request.get(reviewURL + firstReport)).json();
      const failed = initial.steps.find((step: {id: string}) => step.id === "delete");
      expect(failed.ambiguity.candidates.map((candidate: {nth: number}) => candidate.nth))
        .toEqual([0, 1]);

      await repair.getByRole("button", {
        name: "Save corrected copy and rerun from start",
      }).click();
      await expect(page.locator("#run-status"))
        .toContainText("Run complete", { timeout: 25000 });
      await expect(page.locator("#run-summary")).toContainText("PASSED");

      const revisedId = await page.getByLabel("Test", { exact: true }).inputValue();
      expect(revisedId).not.toBe(saved.id);
      const corrected = JSON.parse(await readFile(await approvedPath(dir, revisedId), "utf8"));
      expect(corrected.steps[4].action.target).toEqual({
        by: "role", role: "button", name: "Delete", nth,
      });
      expect(corrected.steps[5].action.expected).toBe(1);
      expect((await page.request.get(reviewURL + "/api/tests/" + saved.id)).status())
        .toBe(404);

      const exportURL = reviewURL + "/api/tests/" + revisedId +
        "/export.ts?baseURL=" + encodeURIComponent(websiteURL);
      const exported = await page.request.get(exportURL);
      expect(exported.status()).toBe(200);
      expect(await exported.text()).toContain(
        'page.getByRole("button", { name: "Delete", exact: true }).nth(' + nth + ')');
    } finally {
      if (review) await close(review);
      await close(targetServer);
      await rm(dir, { recursive: true, force: true });
    }
  });
}
