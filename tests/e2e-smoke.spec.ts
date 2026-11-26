import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createReviewServer } from "../src/review-server.js";

// Black-box browser journeys. The harness uses Playwright directly, never the
// agent's JSON test authoring APIs, CLI runner or any hosted AI provider.
// Playwright Test instruments every context it sees, including contexts
// launched inside the app runner. Let the app own execution traces while
// keeping Playwright Test screenshots on smoke failures.
test.use({ trace: "off" });

const demoURL = "http://127.0.0.1:3000";
const instructions =
  "Add Prepare interview, complete it, then delete it and check the task count.";

test.describe("@e2e-smoke application smoke", () => {
  let server: Server | undefined;
  let url: string;
  let dataDir: string | undefined;

  test.beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "agent-e2e-smoke-"));
    // Keep the Playwright Test browser separate from the agent's runner.
    // The app launches its own Chromium contexts and traces during execution.
    server = await createReviewServer(dataDir);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    url = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  });

  test.afterEach(async () => {
    try {
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server!.close((error) => error ? reject(error) : resolve()));
      }
    } finally {
      server = undefined;
      if (dataDir) await rm(dataDir, { recursive: true, force: true });
      dataDir = undefined;
    }
  });

  async function proposeFixture(page: Page, testName: string) {
    await page.goto(url);
    await expect(page.getByRole("heading", { name: "Test Instructions" })).toBeVisible();
    await page.getByLabel("Application URL").fill(demoURL);
    await page.getByLabel("Your test instructions").fill(instructions);
    await page.locator("#test-name").fill(testName);
    await page.getByLabel("Generate with").selectOption("fixture");
    await expect(page.getByRole("button", { name: "Generate draft" })).toBeEnabled();
    await page.getByRole("button", { name: "Generate draft" }).click();
    await expect(page.locator("#generation-status")).toContainText("Draft ready");
    await expect(page.locator("#step-list .step")).toHaveCount(9);
    await expect(page.locator("#instructions-screen")).toBeHidden();
    await expect(page.locator("#review-workspace")).toBeVisible();
    await expect(page.locator("#test-name")).toHaveValue(testName);
  }

  async function saveApprovedFixture(page: Page, testName: string) {
    await proposeFixture(page, testName);
    await expect(page.getByRole("button", {
      name: "Save Test",
    })).toBeDisabled();
    await page.getByRole("button", { name: "Add All", exact: true }).click();
    await expect(page.locator("#review-progress")).toHaveText("9 of 9 steps confirmed");
    await expect(page.locator("#saved")).toBeEmpty(); // approval is not persistence
    await page.getByRole("button", { name: "Save Test" }).click();
    await expect(page.locator("#saved")).toContainText("Saved and ready to execute");
    await page.locator("#nav-run").click();
    return page.getByLabel("Test script", { exact: true }).inputValue();
  }

  test("fixture draft → explicit approval → saved test → execution → history", async ({ page }) => {
    const id = await saveApprovedFixture(page, "Smoke - task lifecycle");
    expect(id).toMatch(/^reviewed-.*\.json$/);
    await expect(page.getByRole("button", { name: "Run selected test" })).toBeEnabled();
    await expect(page.locator("#results-panel")).toBeHidden();
    await expect(page.locator("#stage-results")).toBeDisabled();

    // Click through the real UI; this is not a generated agent test.
    await page.getByRole("button", { name: "Run selected test" }).click();
    await expect(page.locator("#run-status")).toContainText(
      "Run complete", { timeout: 30_000 });
    const reportPath = await page.locator("#run-artifacts a").first().getAttribute("href");
    expect(reportPath).toMatch(/^\/api\/runs\/.*\/report\.json$/);
    const report = await (await page.request.get(url + reportPath)).json();
    expect(report.status, JSON.stringify(report, null, 2)).toBe("passed");
    await expect(page.locator("#run-summary")).toContainText("PASSED");
    await expect(page.locator("#context-label")).toHaveText("Execution context");
    await expect(page.locator("#context-name")).toHaveText("Smoke - task lifecycle");
    await expect(page.locator("#context-url")).toHaveText(demoURL+"/");
    await expect(page.locator("#run-totals")).toContainText("9 passed");
    await expect(page.locator("#run-steps .run-step")).toHaveCount(9);
    await expect(page.locator("#run-steps details[open]")).toHaveCount(0);
    await page.locator("#run-steps details summary").first().click();
    await expect(page.locator("#run-steps details[open]")).toHaveCount(1);
    await page.locator('input[name="run-step-filter"][value="failed"]').check();
    await expect(page.locator("#run-steps .run-step:visible")).toHaveCount(0);
    await expect(page.locator("#run-step-empty")).toBeVisible();
    await page.locator('input[name="run-step-filter"][value="all"]').check();
    await expect(page.locator("#run-steps .run-step:visible")).toHaveCount(9);
    await expect(page.locator("#run-metrics [data-kind=total] strong")).toHaveText("9");
    await expect(page.locator("#results-panel")).toBeVisible();
    await expect(page.locator("#execution-panel")).toBeHidden();
    await expect(page.locator("#suite-output")).toBeHidden();
    await expect(page.locator("#stage-results")).toBeEnabled();
    await expect(page.locator(".app-nav [data-view=results]")).toHaveCount(0);
    await page.locator("#nav-run").click();
    await expect(page.locator("#execution-panel")).toBeVisible();
    await expect(page.locator("#results-panel")).toBeHidden();
    await page.locator("#stage-results").click();
    await expect(page.locator("#run-summary")).toBeVisible();
    await expect(page.locator("#execution-panel")).toBeHidden();

    await page.locator("#nav-diagnostics").click();
    await expect(page.locator("#history-suite-list .history-entry")).toHaveCount(1);
    await expect(page.locator("#history-site")).toHaveValue("__all__");
    await expect(page.locator("#history-metrics [data-kind=passed] strong")).toHaveText("1");
    await page.locator('input[name="history-verdict"][value="failed"]').check();
    await expect(page.locator("#history-suite-list .history-entry")).toHaveCount(0);
    await expect(page.locator("#history-metrics [data-kind=executions] strong")).toHaveText("1");
    await expect(page.locator("#history-metrics [data-kind=passed] strong")).toHaveText("1");
    await expect(page.locator("#history-metrics [data-kind=failed] strong")).toHaveText("0");
    await page.locator('input[name="history-verdict"][value="passed"]').check();
    await expect(page.locator("#history-suite-list .history-entry")).toHaveCount(1);
    await page.locator("#history-search").fill("missing execution");
    await expect(page.locator("#history-suite-list .history-entry")).toHaveCount(0);
    await page.locator("#history-search").fill("task lifecycle");
    await expect(page.locator("#history-suite-list .history-entry")).toHaveCount(1);
    await expect(page.locator("#results-panel")).toBeHidden();
    await page.getByRole("button", {name:"Open results", exact:true}).click();
    await expect(page.locator("#results-panel")).toBeVisible();
    await expect(page.locator("#run-summary")).toContainText("PASSED");
    await expect(page.locator("#diagnostics-panel")).toBeHidden();
  });

  test("partially approved working draft survives reload without becoming executable", async ({ page }) => {
    await proposeFixture(page, "Smoke - unfinished draft");
    await page.locator("#step-list .step input[type=checkbox]").nth(0).check();
    await page.locator("#step-list .step input[type=checkbox]").nth(1).check();
    await page.getByRole("button", { name: "Save Draft" }).click();
    await expect(page.locator("#draft-save-status")).toContainText("2/9 approved");
    await expect(page.getByRole("button", { name: "Save Test" })).toBeDisabled();

    await page.reload();
    // The review workspace is intentionally hidden until the tester opens it.
    await page.getByRole("button", { name: "Edit existing test or resume draft" }).click();
    await expect(page.locator("#review-workspace")).toBeVisible();
    await expect(page.locator("#catalog-rows tr")).toHaveCount(1);
    await expect(page.locator("#catalog-rows")).toContainText("Draft — not runnable");
    await page.getByRole("button", { name: "Resume Smoke - unfinished draft", exact: true }).click();
    await expect(page.locator("#review-progress")).toHaveText("2 of 9 steps confirmed");
    await expect(page.getByLabel("Your test instructions")).toHaveValue(instructions);
    await expect(page.getByRole("button", { name: "Save Test" })).toBeDisabled();
    await page.locator("#nav-run").click();
    await expect(page.getByRole("button", { name: "Run selected test" })).toBeDisabled();
  });

  test("navigation preserves instructions and approvals without invoking AI", async ({page}) => {
    await proposeFixture(page, "Navigation state");
    await page.locator("#step-list .step input[type=checkbox]").first().check();
    await page.locator("#stage-instructions").click();
    await expect(page.locator("#requirements")).toHaveValue(instructions);
    await expect(page.locator("#review-workspace")).toBeHidden();
    await page.locator("#nav-existing").click();
    await expect(page.locator("#placeholder")).toBeVisible();
    await expect(page.locator("#draft")).toBeHidden();
    await page.locator("#nav-run").click();
    await page.locator("#execution-url").fill("https://example.com/");
    await page.locator("#nav-diagnostics").click();
    await expect(page.locator("#history-panel")).toBeVisible();
    await page.locator("#stage-instructions").click();
    await expect(page.locator("#base-url")).toHaveValue(demoURL);
    await expect(page.locator("#requirements")).toHaveValue(instructions);
    await page.locator("#stage-draft").click();
    await expect(page.locator("#review-progress")).toHaveText("1 of 9 steps confirmed");
    await expect(page.locator("#step-list .step input[type=checkbox]").first()).toBeChecked();
  });

  test("compact draft retains executable actions, approval controls and context across navigation", async ({page}) => {
    await proposeFixture(page,"Compact draft");
    const context = page.locator("#test-context");
    await expect(context).toBeVisible();
    await expect(context.locator("#context-name")).toHaveText("Compact draft");
    await expect(context.locator("#context-url")).toHaveText(demoURL+"/");
    const cards = page.locator("#step-list .step");
    await expect(page.locator("#step-list .step-details[open]")).toHaveCount(0);
    await expect(cards.nth(2).locator(".action")).toBeVisible();
    await expect(cards.nth(2).locator(".action")).toContainText("Prepare interview");
    await page.locator("#expand-steps").click();
    await expect(page.locator("#step-list .step-details[open]")).toHaveCount(9);
    await page.locator("#collapse-steps").click();
    await expect(page.locator("#step-list .step-details[open]")).toHaveCount(0);
    await cards.nth(2).getByRole("button",{name:"Edit fields"}).click();
    await expect(cards.nth(2).locator(".edits")).toBeVisible();
    await expect(cards.nth(2).locator(".step-details")).toHaveJSProperty("open",true);
    await cards.nth(2).getByRole("button",{name:"Cancel",exact:true}).click();
    await expect(cards.nth(2).getByRole("button",{name:"Edit fields"})).toBeEnabled();
    await cards.first().locator('input[type=checkbox]').check();
    await expect(cards.first()).toHaveAttribute("data-approved","true");
    await expect(page.locator("#approval-progress")).toHaveJSProperty("value",1);
    await expect(page.locator("#approval-progress")).toHaveJSProperty("max",9);
    await expect(page.locator("#draft-save-bar")).toHaveCSS("position","sticky");
    await page.locator("#stage-instructions").click();
    await expect(context.locator("#context-name")).toHaveText("Compact draft");
    await expect(page.locator("#draft-save-bar")).toBeHidden();
    await page.locator("#stage-draft").click();
    await expect(cards.nth(2).locator(".step-details")).toHaveJSProperty("open",true);
    await expect(page.locator("#review-progress")).toHaveText("1 of 9 steps confirmed");
    await page.locator("#review-add-all").click();
    await expect(page.locator("#approval-progress")).toHaveJSProperty("value",9);
    await expect(page.locator("#save")).toBeEnabled();
    await expect(page.locator("#save-and-run")).toBeEnabled();
  });

  test("New Test resets the editor only after explicit discard and preserves saved tests", async ({page}) => {
    const id = await saveApprovedFixture(page, "Original test");
    await page.locator("#stage-draft").click();
    await page.locator("#stage-instructions").click();
    await expect(page.locator("#test-name")).toHaveValue("Original test");
    page.once("dialog", dialog => dialog.dismiss());
    await page.locator("#nav-new").click();
    await expect(page.locator("#test-name")).toHaveValue("Original test");
    page.once("dialog", dialog => dialog.accept());
    await page.locator("#nav-new").click();
    for (const field of ["test-name","requirements","base-url","recent-url","save-test-name"]) {
      await expect(page.locator("#"+field)).toHaveValue("");
    }
    await expect(page.locator("#step-list .step")).toHaveCount(0);
    await expect(page.locator("#stage-draft")).toBeDisabled();
    await expect(page.locator("#generate")).toBeDisabled();
    await page.locator("#base-url").fill(demoURL);
    await page.locator("#requirements").fill(instructions);
    await page.locator("#test-name").fill(" original TEST ");
    await expect(page.locator("#generate")).toBeDisabled();
    await expect(page.locator("#test-name-conflict")).toBeVisible();
    await expect(page.locator("#test-name-conflict")).toContainText("already exists");
    await expect(page.locator("#test-name")).toHaveAttribute("aria-invalid","true");
    await expect(page.locator("#generate-readiness")).toContainText("Choose a different Test name");
    await page.locator("#test-name").fill("Separate new test");
    await expect(page.locator("#test-name-conflict")).toBeHidden();
    await expect(page.locator("#test-name")).toHaveAttribute("aria-invalid","false");
    await page.locator("#generate").click();
    await expect(page.locator("#step-list .step")).toHaveCount(9);
    await page.locator("#review-add-all").click();
    await page.locator("#save").click();
    await expect(page.locator("#saved")).toContainText("Saved and ready to execute");
    const listing = await (await page.request.get(url+"/api/tests")).json();
    expect(listing.tests).toHaveLength(2);
    expect(listing.tests.some((item:{id:string})=>item.id===id)).toBe(true);
  });

  test("duplicate names are rejected at the API, including concurrent saves and draft promotion", async ({page}) => {
    await proposeFixture(page,"Reserved draft");
    await page.locator("#save-draft").click();
    await expect(page.locator("#draft-save-status")).toContainText("saved and verified");
    const drafts = await (await page.request.get(url+"/api/drafts")).json();
    const draftId = drafts.drafts[0].id;
    const {draft} = await (await page.request.get(url+"/api/drafts/"+draftId)).json();
    const body = {definition:draft.definition,baseURL:demoURL,testName:" reserved DRAFT "};
    const denied = await page.request.post(url+"/api/save",{data:body});
    expect(denied.status()).toBe(409);
    await page.locator("#review-add-all").click();
    await page.locator("#save").click();
    await expect(page.locator("#saved")).toContainText("Saved and ready to execute");
    expect((await (await page.request.get(url+"/api/drafts")).json()).drafts).toHaveLength(0);
    const duplicate = await page.request.post(url+"/api/save",{data:body});
    expect(duplicate.status()).toBe(409);
    const requests = await Promise.all(["Race test"," race TEST "].map(testName =>
      page.request.post(url+"/api/save",{data:{...body,testName}})));
    expect(requests.map(res=>res.status()).sort()).toEqual([200,409]);
    const renamed = await page.request.post(url+"/api/save",{data:{...body,testName:"Unique name"}});
    expect(renamed.status()).toBe(200);
  });

  test("editor status tracks saved drafts and approved tests; catalog filters and resumes them", async ({page}) => {
    await proposeFixture(page,"Catalog unfinished");
    await expect(page.locator("#editor-state")).toHaveText("Unsaved changes");
    await page.locator("#step-list .step input[type=checkbox]").first().check();
    await page.locator("#save-draft").click();
    await expect(page.locator("#draft-save-status")).toContainText("saved and verified");
    await expect(page.locator("#editor-state")).toHaveText("Working draft saved");
    await page.locator("#step-list .step input[type=checkbox]").nth(1).check();
    await expect(page.locator("#editor-state")).toHaveText("Unsaved changes");
    await page.locator("#step-list .step input[type=checkbox]").nth(1).uncheck();
    await expect(page.locator("#editor-state")).toHaveText("Working draft saved");
    await page.locator("#stage-instructions").click();
    await page.locator("#requirements").fill(instructions+" Extra instruction.");
    await expect(page.locator("#editor-state")).toHaveText("Unsaved changes");
    await page.locator("#requirements").fill(instructions);
    await expect(page.locator("#editor-state")).toHaveText("Working draft saved");
    await page.locator("#nav-existing").click();
    await expect(page.locator("#catalog-rows tr")).toHaveCount(1);
    await page.locator('#catalog-status input[value="approved"]').check();
    await expect(page.locator("#catalog-empty")).toBeVisible();
    await page.locator('#catalog-status input[value="draft"]').check();
    await page.locator("#catalog-search").fill("no matching name");
    await expect(page.locator("#catalog-rows tr")).toHaveCount(0);
    await page.locator("#catalog-search").fill("unfinished");
    await expect(page.locator("#catalog-rows tr")).toHaveCount(1);
    await expect(page.locator("#catalog-rows")).toContainText("Draft — not runnable");
    page.once("dialog",dialog=>dialog.accept());
    await page.getByRole("button",{name:"Resume Catalog unfinished",exact:true}).click();
    await expect(page.locator("#editor-state")).toHaveText("Working draft saved");
    await page.locator("#review-add-all").click();
    await page.locator("#save").click();
    await expect(page.locator("#saved")).toContainText("Saved and ready to execute");
    await expect(page.locator("#editor-state")).toHaveText("Approved test saved");
    await page.locator("#nav-existing").click();
    await page.locator('#catalog-status input[value="all"]').check();
    await expect(page.locator("#catalog-rows tr")).toHaveCount(1);
    await expect(page.locator("#catalog-rows")).toContainText("Approved");
    page.once("dialog",dialog=>dialog.accept());
    await page.getByRole("button",{name:"Edit Catalog unfinished",exact:true}).click();
    await expect(page.locator("#editor-state")).toHaveText("Approved test saved");
    await page.locator("#save-test-name").fill("Catalog changed");
    await expect(page.locator("#editor-state")).toHaveText("Unsaved changes");
  });

  test("suite, case, status and search compose without confusing same-name records", async ({page}) => {
    const first = await saveApprovedFixture(page, "Shared name");
    const {definition} = await (await page.request.get(url+"/api/tests/"+first)).json();
    const otherSite = "https://example.com";
    const secondResponse = await page.request.post(url+"/api/save",{data:{definition,baseURL:otherSite,testName:"Shared name"}});
    expect(secondResponse.status()).toBe(200);
    const {id:second} = await secondResponse.json();
    await proposeFixture(page,"Unfinished task");
    await page.locator("#save-draft").click();
    await expect(page.locator("#draft-save-status")).toContainText("saved and verified");
    const drafts = (await (await page.request.get(url+"/api/drafts")).json()).drafts;
    const draftId = drafts.find((item:{title:string})=>item.title==="Unfinished task")?.id;
    expect(draftId).toMatch(/^draft-/);
    await page.reload();
    await page.locator("#nav-existing").click();
    const suite = page.locator("#edit-suite");
    const script = page.locator("#edit-script");
    const rows = page.locator("#catalog-rows tr");
    await expect(rows).toHaveCount(3);
    await expect(page.locator("#catalog-summary")).toHaveText("3 of 3 saved test records · 2 approved · 1 draft");
    await expect(suite).toHaveValue("");
    await expect(script).toHaveValue("");
    await expect(page.locator('#catalog-status input[value="all"]')).toBeChecked();
    await expect(script.locator("option")).toHaveCount(4);
    await script.selectOption(second);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute("data-record-id",second);
    await suite.selectOption(demoURL);
    await expect(script).toHaveValue("");
    await expect(rows).toHaveCount(2);
    await expect(page.locator("#catalog-summary")).toHaveText("2 of 3 saved test records · 1 approved · 1 draft");
    await expect(script.locator("option")).toHaveCount(3);
    await script.selectOption(first);
    await expect(rows.first()).toHaveAttribute("data-record-id",first);
    await page.locator('#catalog-status input[value="draft"]').check();
    await expect(script).toHaveValue("");
    await expect(script.locator("option")).toHaveCount(2);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute("data-record-id",draftId);
    await expect(page.locator("#catalog-summary")).toHaveText("1 of 3 saved test records · 0 approved · 1 draft");
    await page.locator("#catalog-search").fill("shared");
    await expect(page.locator("#catalog-empty")).toBeVisible();
    await expect(page.locator("#catalog-summary")).toHaveText("0 of 3 saved test records · 0 approved · 0 drafts");
    await page.locator("#catalog-search").fill("unfinished");
    await expect(rows).toHaveCount(1);
    await script.selectOption(draftId);
    await expect(rows.first()).toHaveAttribute("data-record-id",draftId);
    await suite.selectOption(otherSite);
    await expect(script).toHaveValue("");
    await expect(rows).toHaveCount(0);
    await page.locator('#catalog-status input[value="approved"]').check();
    await page.locator("#catalog-search").fill("");
    await expect(rows).toHaveCount(1);
    await script.selectOption(second);
    await expect(rows.first()).toHaveAttribute("data-record-id",second);
    await page.getByRole("button",{name:"Edit Shared name",exact:true}).click();
    await expect(page.locator("#test-name")).toHaveValue("Shared name");
    await expect(page.locator("#context-url")).toHaveText(otherSite+"/");
    await page.locator("#nav-existing").click();
    await expect(suite).toHaveValue(otherSite);
    await expect(script).toHaveValue(second);
    await page.reload();
    await page.locator("#nav-existing").click();
    await expect(rows).toHaveCount(3);
    await expect(suite).toHaveValue("");
    await expect(script).toHaveValue("");
  });

  test("unified catalog refresh updates both record types and preserves active filters", async ({page}) => {
    const first = await saveApprovedFixture(page,"Refresh approved");
    await proposeFixture(page,"Refresh draft");
    await page.locator("#save-draft").click();
    await expect(page.locator("#draft-save-status")).toContainText("saved and verified");
    await page.locator("#nav-existing").click();
    await expect(page.locator("#catalog-rows tr")).toHaveCount(2);
    await expect(page.locator("#working-drafts-panel, #draft-select, #edit-load")).toHaveCount(0);
    await page.locator("#edit-suite").selectOption(demoURL);
    await page.locator('#catalog-status input[value="draft"]').check();
    await page.locator("#catalog-search").fill("refresh");
    await expect(page.locator("#catalog-rows tr")).toHaveCount(1);
    const {definition} = await (await page.request.get(url+"/api/tests/"+first)).json();
    const approved = await page.request.post(url+"/api/save",{data:{definition,baseURL:demoURL,testName:"Refresh external approved"}});
    expect(approved.status()).toBe(200);
    const draft = await page.request.post(url+"/api/drafts/save",{data:{definition,baseURL:demoURL,testName:"Refresh external draft",sourceInstructions:instructions,workingInstructions:instructions,approvedStepIds:[]}});
    expect(draft.status()).toBe(200);
    await page.locator("#catalog-refresh").click();
    await expect(page.locator("#catalog-refresh-status")).toHaveText("Tests and drafts refreshed.");
    await expect(page.locator("#edit-suite")).toHaveValue(demoURL);
    await expect(page.locator('#catalog-status input[value="draft"]')).toBeChecked();
    await expect(page.locator("#catalog-search")).toHaveValue("refresh");
    await expect(page.locator("#catalog-rows tr")).toHaveCount(2);
    await expect(page.locator("#catalog-summary")).toHaveText("2 of 4 saved test records · 0 approved · 2 drafts");
    await page.locator('#catalog-status input[value="approved"]').check();
    await expect(page.locator("#catalog-rows tr")).toHaveCount(2);
    await expect(page.locator("#catalog-rows")).toContainText("Refresh external approved");
    await page.route("**/api/drafts",route=>route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Simulated draft listing failure"})}));
    await page.locator("#catalog-refresh").click();
    await expect(page.locator("#catalog-error")).toContainText("Simulated draft listing failure");
    await expect(page.locator("#catalog-refresh-status")).toContainText("Refresh incomplete");
    await page.locator('#catalog-status input[value="draft"]').check();
    await expect(page.locator("#catalog-rows tr")).toHaveCount(2);
  });

  test("two saved scripts can execute as a website suite", async ({ page }) => {
    test.setTimeout(60_000);
    const first = await saveApprovedFixture(page, "Smoke suite - first");
    const second = await saveApprovedFixture(page, "Smoke suite - second");
    expect(second).not.toBe(first);

    await expect(page.getByLabel("Test suite (website URL)")).toHaveValue(demoURL);
    await expect(page.locator("#suite-test-list input[type=checkbox]")).toHaveCount(2);
    await page.getByRole("button", { name: "Select first 10" }).click();
    await expect(page.locator("#suite-selection-status")).toContainText("2 tests selected");
    await page.getByRole("button", { name: "Run selected suite" }).click();
    await expect(page.locator("#suite-status")).toContainText(
      "Suite complete", { timeout: 45_000 });
    await expect(page.locator("#suite-status")).toContainText("PASSED");
    await expect(page.locator("#suite-summary")).toContainText("2 passed, 0 failed");
    await expect(page.locator("#execution-panel")).toBeHidden();
    await expect(page.locator("#suite-output")).toBeVisible();
    await expect(page.locator("#single-output")).toBeHidden();
    await page.getByRole("button", {name:"View details for Smoke suite - first"}).click();
    await expect(page.locator("#run-summary")).toContainText("PASSED");
    await expect(page.locator("#suite-output")).toBeVisible();
    await expect(page.locator("#execution-panel")).toBeHidden();
    await page.locator("#nav-run").click();
    await expect(page.locator("#results-panel")).toBeHidden();
    await expect(page.locator("#execution-panel")).toBeVisible();
  });
});
