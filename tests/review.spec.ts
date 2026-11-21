import { test, expect } from "@playwright/test";
import { createReviewServer } from "../src/review-server.js";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

let server: Server;
let url: string;
let outputDir: string;
test.beforeAll(async () => {
  outputDir = await mkdtemp(join(tmpdir(), "ui-review-"));
  server = await createReviewServer(outputDir);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});
test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()));
  await rm(outputDir, { recursive: true, force: true });
});

async function generateFixture(page: import("@playwright/test").Page) {
  await page.goto(url);
  await page.getByLabel("Your test instructions").fill(
    "Add Prepare interview, complete it, then delete it and check the task count.",
  );
  await page.getByLabel("Generate with").selectOption("fixture");
  await page.getByRole("button", { name: "Generate draft" }).click();
  await expect(page.locator("#generation-status")).toContainText("Draft ready");
  await expect(page.locator(".step")).toHaveCount(9);
}

test("plain-English input produces a readable review-only fixture draft", async ({ page }) => {
  await generateFixture(page);
  await expect(page.getByText("Fixture is a prewritten demonstration, not AI-generated.")).toBeVisible();
  await expect(page.locator(".step").nth(2)).toContainText("Enter");
  await expect(page.locator(".step").nth(2)).toContainText("Prepare interview");
  const save = page.getByRole("button", { name: "Approve and save JSON test" });
  await expect(save).toBeDisabled();
  for (const box of await page.locator(".step input[type=checkbox]").all()) {
    await box.check();
  }
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.locator("#saved")).toContainText("The test has NOT been executed");
  const files = await readdir(outputDir);
  expect(files).toHaveLength(1);
  const draft = JSON.parse(await readFile(join(outputDir, files[0]), "utf8"));
  expect(draft.steps).toHaveLength(9);
  expect(draft.steps.every((step: { action: { provenance?: string } }) =>
    step.action.provenance !== "human-confirmed",
  )).toBe(true);
});

test("user edits a step using form fields, without editing JSON", async ({ page }) => {
  await generateFixture(page);
  const thirdStep = page.locator(".step").nth(2);
  await thirdStep.getByRole("button", { name: "Edit fields" }).click();
  await thirdStep.getByLabel("Value to enter").fill("Prepare release");
  await thirdStep.getByRole("button", { name: "Apply changes" }).click();
  await expect(thirdStep).toContainText('Enter "Prepare release"');
  await expect(thirdStep.locator('input[type=checkbox]')).not.toBeChecked();
  for (const box of await page.locator(".step input[type=checkbox]").all()) await box.check();
  await page.getByRole("button", { name: "Approve and save JSON test" }).click();
  await expect(page.locator("#saved")).toContainText("Saved!");
  const files = await readdir(outputDir);
  const drafts = await Promise.all(files.map(async (file) => JSON.parse(
    await readFile(join(outputDir, file), "utf8"),
  )));
  expect(drafts.some((draft) => draft.steps[2].action.value === "Prepare release")).toBe(true);
});

test("review server rejects malformed instructions and off-origin writes", async () => {
  const invalid = await fetch(url + "/api/generate", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseURL: "http://127.0.0.1:3000", provider: "groq", requirements: "" }),
  });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({ error: expect.stringContaining("Enter a test instruction") });
  const forbidden = await fetch(url + "/api/save", {
    method: "POST", headers: {
      "Content-Type": "application/json",
      Origin: "https://another-website.example",
    }, body: JSON.stringify({}),
  });
  expect(forbidden.status).toBe(403);
});
