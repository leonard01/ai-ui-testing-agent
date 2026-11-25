import type { Page } from "@playwright/test";

/** The Run Tests UI requires an explicit website-suite choice before choosing a script. */
export async function selectSavedScript(page: Page, id: string): Promise<void> {
  const response = await page.request.get(new URL("/api/tests", page.url()).href);
  if (!response.ok()) throw new Error("Unable to retrieve approved tests for selection");
  const payload = await response.json() as { tests: Array<{
    id: string; siteUrl: string | null;
  }> };
  const test = payload.tests.find((item) => item.id === id);
  if (!test) throw new Error("Saved test is not available: " + id);
  await page.locator("#nav-run").click();
  await page.getByLabel("Test suite (website URL)").selectOption(test.siteUrl || "__legacy__");
  await page.getByLabel("Test script", { exact: true }).selectOption(id);
}
