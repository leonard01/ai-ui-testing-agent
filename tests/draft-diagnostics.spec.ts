import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createReviewServer } from "../src/review-server.js";

// Exercise the real draft UI with a controlled response; no live eBay/Groq request.
test.use({ trace: "off" });
test("draft shows quality warnings and inspected-page evidence, then clears them on failure", async ({ page, browser }) => {
  const dir = await mkdtemp(join(tmpdir(), "draft-evidence-"));
  const server: Server = await createReviewServer(dir, browser);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const instructions = "search for 'Wooden Abacus' and verify 'wooden' and 'abacus' in results";
  const errorText = "Something went wrong on our end";
  const definition = {
    schemaVersion: 1, id: "ebay-search", title: "Search eBay", version: 1,
    steps: [
      { id: "open", description: "Open eBay", action: { kind: "navigate", url: "https://www.ebay.com/" } },
      { id: "unexpected", description: "Verify error page message", action: {
        kind: "assert-text", target: { by: "text", value: errorText },
        expected: errorText, provenance: "inferred",
      } },
    ],
  };
  let fail = false;
  try {
    await page.route("**/api/generate", (route) =>
      route.fulfill({
        status: fail ? 502 : 200,
        contentType: "application/json",
        body: fail ? JSON.stringify({ source: "groqcloud", category: "timeout", error: "Request timed out" })
          : JSON.stringify({
            definition, needsReview: true, provider: "groq", generationAttempts: 1,
            message: "AI-generated draft. Review before approval.",
            memorySuggestions: [],
            diagnostics: {
              provider: "groq", model: "openai/gpt-oss-20b", attempts: 1,
              snapshot: {
                url: "https://www.ebay.com/", title: "eBay", headings: [],
                controls: [], statusText: [errorText], sampleText: [],
                inspection: {
                  mainDocumentStatus: 200, blockedCrossOriginRequests: 12, pageErrors: 1,
                },
              },
              warnings: [
                'The generated steps do not mention quoted requirement value(s): "Wooden Abacus".',
                'Step "Verify error page message" asserts an unexpected error message as success. This could create a false pass.',
              ],
            },
          }),
      }));
    await page.goto(url);
    await page.getByLabel("Application URL").fill("https://www.ebay.com");
    await page.locator("#test-name").fill("Diagnostic warning test");
    await page.getByLabel("Your test instructions").fill(instructions);
    await page.getByRole("button", { name: "Generate draft" }).click();
    await expect(page.locator("#draft-quality-warnings")).toBeVisible();
    await expect(page.locator("#draft-quality-warnings")).toContainText("Wooden Abacus");
    await expect(page.locator("#draft-quality-warnings")).toContainText("false pass");
    await expect(page.locator("#generation-status")).toContainText("Review the advisory quality warnings");
    await expect(page.locator("#generation-diagnostics")).toBeVisible();
    await page.locator("#generation-diagnostics summary").click();
    await expect(page.locator("#generation-diagnostics-meta")).toContainText("openai/gpt-oss-20b");
    await expect(page.locator("#generation-diagnostics-snapshot")).toContainText('"blockedCrossOriginRequests": 12');
    await expect(page.locator("#generation-diagnostics-output")).toContainText(errorText);
    fail = true;
    await page.getByRole("button", { name: "Generate draft" }).click();
    await expect(page.locator("#generation-error")).toContainText("timeout");
    await expect(page.locator("#draft-quality-warnings")).toBeHidden();
    await expect(page.locator("#generation-diagnostics")).toBeHidden();
    await expect(page.locator("#draft")).toBeHidden();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
