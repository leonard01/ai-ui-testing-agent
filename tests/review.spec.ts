import { selectSavedScript } from "./helpers/select-saved-script.js";
import { test, expect } from "@playwright/test";

// Legacy recovery tests explicitly opt in; every other case exercises JSON-only.
let previousResponsePolicy: string | undefined;
test.beforeEach(async ({}, info) => {
  previousResponsePolicy = process.env.GROQ_RESPONSE_POLICY;
  const legacy = ["Test 1 repairs string-valued","two malformed responses stop"].some(prefix => info.title.startsWith(prefix));
  process.env.GROQ_RESPONSE_POLICY = legacy ? "hybrid" : "json";
});
test.afterEach(() => {
  if (previousResponsePolicy === undefined) delete process.env.GROQ_RESPONSE_POLICY;
  else process.env.GROQ_RESPONSE_POLICY = previousResponsePolicy;
});
// The app runner owns traces for its test contexts; avoid harness tracing twice.
test.use({ trace: "off" });
import { createReviewServer } from "../src/review-server.js";
import { GroqProviderError } from "../src/hosted-providers.js";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { approvedPath, listApprovedIds } from "./helpers/saved-files.js";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

let server: Server;
let url: string;
let outputDir: string;
test.beforeAll(async ({ browser }) => {
  outputDir = await mkdtemp(join(tmpdir(), "ui-review-"));
  server = await createReviewServer(outputDir, browser);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});
test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()));
  await rm(outputDir, { recursive: true, force: true });
});

// All generated tests now require a name, not just tests that are saved.
async function clickGenerateDraft(page: import("@playwright/test").Page) {
  if (!(await page.locator("#test-name").inputValue()).trim()) {
    await page.locator("#test-name").fill(test.info().title.slice(0, 200));
  }
  await page.getByRole("button", { name: "Generate draft" }).click();
}


test("initial page JavaScript exception is explained separately from selector defects", async ({ page }) => {
  const definition = JSON.parse(await readFile("examples/add-task.json", "utf8"));
  const snapshot = {
    url: "http://127.0.0.1:3000/", title: "Test app",
    headings: ["Task list"], controls: [], statusText: [], sampleText: [],
    inspection: {
      mainDocumentStatus: 200, pageErrors: 1,
      allowedCrossOriginRequests: 0, blockedCrossOriginRequests: 0,
      pageErrorSummaries: ["TypeError: Cannot read properties of undefined"],
    },
  };
  await page.goto(url);
  await page.route("**/api/generate", route => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({
      definition, needsReview: true, provider: "groq", generationAttempts: 1,
      memorySuggestions: [], diagnostics: {
        provider: "groq", model: "mock", attempts: 1, snapshot,
        warnings: ["The website raised 1 JavaScript exception(s) while loading. This does NOT mean a test step or selector has failed. Open Generation diagnostics for the redacted error summary, then use Check selectors (read-only) to inspect starting-page targets before approving."],
      },
      message: "AI-generated draft",
    }),
  }));
  await page.getByLabel("Your test instructions").fill("Add a task");
  await page.getByLabel("Generate with").selectOption("groq");
  await clickGenerateDraft(page);
  await expect(page.locator("#draft-quality-warnings")).toContainText(
    "does NOT mean a test step or selector has failed");
  await expect(page.locator("#generation-page-error-summary")).toContainText(
    "TypeError: Cannot read properties of undefined");
  await expect(page.locator("#draft-preflight-panel")).toBeVisible();
  const preflightBeforeSteps = await page.locator("#draft-preflight-panel").evaluate(
    element => {
      const steps = document.querySelector("#step-list");
      return !!steps && !!(element.compareDocumentPosition(steps) &
        Node.DOCUMENT_POSITION_FOLLOWING);
    });
  expect(preflightBeforeSteps).toBe(true);
  await expect(page.locator("#save")).toBeDisabled();
});

test("unverified login placeholders are critical blockers, not amber advisory warnings @sanity", async ({page}) => {
  const login = {
    schemaVersion:1, id:"login", title:"Login", version:1,
    steps:[
      {id:"open", description:"Open login page",action:{kind:"navigate",url:"http://127.0.0.1:3000"}},
      {id:"user",description:"Enter username",action:{
        kind:"fill",target:{by:"label",value:"Username"},value:"REPLACE_WITH_YOUR_USERNAME"}},
      {id:"pass",description:"Enter password",action:{
        kind:"fill",target:{by:"label",value:"Password"},value:"REPLACE_WITH_YOUR_PASSWORD"}},
      {id:"login",description:"Click Login",action:{
        kind:"click",target:{by:"role",role:"button",name:"Login"}}},
      {id:"verify",description:"Verify Products",action:{
        kind:"assert-visible",target:{by:"text",value:"Products"},provenance:"requirements"}},
    ],
  };
  await page.goto(url);
  await page.route("**/api/generate",route => route.fulfill({
    status:200,contentType:"application/json",
    body:JSON.stringify({
      definition:login,needsReview:true,provider:"groq",generationAttempts:1,
      memorySuggestions:[],
      diagnostics:{
        provider:"groq",model:"mock",attempts:1,
        snapshot:{url:"http://127.0.0.1:3000",title:"Login",headings:["Login"],
          controls:[],statusText:[],sampleText:[],
          inspection:{mainDocumentStatus:200,blockedCrossOriginRequests:0,
            allowedCrossOriginRequests:0,pageErrors:0}},
        warnings:[],blockingCredentialSteps:[2,3],
      },
      message:"AI-generated draft",
    }),
  }));
  await page.getByLabel("Your test instructions").fill("Log in and verify Products");
  await page.locator("#test-name").fill("Login validation");
  await page.getByLabel("Generate with").selectOption("groq");
  await clickGenerateDraft(page);
  const panel = page.locator("#draft-critical-blockers");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Cannot save or run");
  await expect(panel).toContainText("step 2");
  await expect(panel).toContainText("3");
  const sharedReview = page.locator("#draft-review-feedback");
  await expect(sharedReview).toBeVisible();
  await expect(sharedReview.locator("#draft-review-advisories")).toBeVisible();
  await expect(sharedReview).toContainText("Warnings — review against your test intent");
  await expect(sharedReview).toContainText("could verify something different from what you intended");
  await expect(sharedReview).toContainText("1 DOM-wide assertion");
  // Blockers are the first visible message in the shared review panel.
  const blockerBeforeWarnings = await sharedReview.evaluate(node => {
    const blocker = node.querySelector("#draft-critical-blockers");
    const warning = node.querySelector("#draft-review-advisories");
    return !!blocker && !!warning &&
      !!(blocker.compareDocumentPosition(warning) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(blockerBeforeWarnings).toBe(true);
  await expect(page.locator("#generation-status")).toContainText("BLOCKED");
  await expect(page.locator("#draft-quality-warnings")).toBeHidden();
  await page.getByRole("button",{name:"Approve all steps",exact:true}).click();
  await expect(page.locator("#save")).toBeDisabled();
  await expect(page.locator("#save-and-run")).toBeDisabled();
  await expect(page.locator("#save-draft")).toBeEnabled();

  // Reproduces the user-reported login-memory case: an incomplete login test
  // with credential placeholders must be saved, rediscovered after reload,
  // and reopenable as a draft (never a runnable approved test).
  await page.getByRole("button",{name:"Save Draft",exact:true}).click();
  await expect(page.locator("#draft-save-status")).toContainText("saved and verified");
  const loginTitle = await page.locator("#test-name").inputValue();
  const loginDrafts = (await (await page.request.get(url + "/api/drafts")).json()).drafts;
  const loginDraftId = loginDrafts.find((item: {title:string}) => item.title === loginTitle)?.id;
  expect(loginDraftId).toMatch(/^draft-/);
  await page.reload();
  await page.getByRole("button", {name: "Edit existing test or resume draft"}).click();
  await expect(page.locator("#review-workspace")).toBeVisible();
  await expect(page.locator('#catalog-rows tr[data-record-id="' + loginDraftId + '"]')).toHaveCount(1);
  await page.locator("#edit-suite").selectOption("http://127.0.0.1:3000");
  await page.locator("#edit-script").selectOption(loginDraftId);
  await page.locator('#catalog-rows tr[data-record-id="' + loginDraftId + '"]').getByRole("button",{name:/^Resume /}).click();
  await expect(panel).toBeVisible();
  await expect(page.locator("#save-and-run")).toBeDisabled();

  await panel.getByRole("button",{name:"Edit step 2"}).click();
  const username = page.locator("#step-list .step").nth(1);
  await username.getByLabel("Value to enter").fill("public-demo-user");
  await username.getByRole("button",{name:"Apply changes"}).click();
  await expect(panel).toContainText("1 unresolved login credential step");
  await expect(panel).not.toContainText("Edit step 2");
  await expect(panel.getByRole("button",{name:"Edit step 3"})).toBeVisible();
  await panel.getByRole("button",{name:"Edit step 3"}).click();
  const password = page.locator("#step-list .step").nth(2);
  await password.getByLabel("Value to enter").fill("public-demo-password");
  await password.getByRole("button",{name:"Apply changes"}).click();
  await expect(panel).toBeHidden();
  // Non-blocking warnings remain visible after the blocker has been resolved.
  await expect(sharedReview).toBeVisible();
  await expect(sharedReview.locator("#draft-review-advisories")).toBeVisible();
  await expect(page.locator("#draft-quality-warnings")).toBeHidden();

  // Editing invalidates approval of the changed steps; the user must confirm
  // them again before creating an executable test.
  await expect(page.locator("#save-and-run")).toBeDisabled();
  await page.getByRole("button",{name:"Approve all steps",exact:true}).click();
  await expect(page.locator("#save")).toBeEnabled();
  await expect(page.locator("#save-and-run")).toBeEnabled();
});

test("JavaScript page warnings stay advisory, never incorrectly labelled as blockers", async ({page}) => {
  await page.goto(url);
  await page.route("**/api/generate",route => route.fulfill({
    status:200,contentType:"application/json",
    body:JSON.stringify({
      definition:{
        schemaVersion:1,id:"simple",title:"Simple",version:1,
        steps:[{id:"open",description:"Open site",action:{kind:"navigate",url:"http://127.0.0.1:3000"}}],
      },
      needsReview:true,provider:"groq",generationAttempts:1,memorySuggestions:[],
      diagnostics:{provider:"groq",model:"mock",attempts:1,
        snapshot:{url:"http://127.0.0.1:3000",title:"Todo",headings:["Todo"],
          controls:[],statusText:[],sampleText:[],
          inspection:{mainDocumentStatus:200,blockedCrossOriginRequests:0,
            allowedCrossOriginRequests:0,pageErrors:1,
            pageErrorSummaries:["TypeError: demo script issue"]}},
        blockingCredentialSteps:[],
        warnings:["The website raised a JavaScript exception while loading; no test-step failure is implied."]},
      message:"AI-generated draft",
    }),
  }));
  await page.getByLabel("Your test instructions").fill("Open the page");
  await page.getByLabel("Generate with").selectOption("groq");
  await clickGenerateDraft(page);
  await expect(page.locator("#draft-critical-blockers")).toBeHidden();
  await expect(page.locator("#draft-review-feedback")).toBeVisible();
  await expect(page.locator("#draft-critical-blockers")).toBeHidden();
  await expect(page.locator("#draft-review-advisories")).toContainText(
    "Warnings — review against your test intent");
  await expect(page.locator("#draft-quality-warnings")).toContainText("Other quality checks");
  await expect(page.locator("#draft-quality-warnings")).toContainText("JavaScript exception");
});

// Each journey owns a distinct name even when workers share a persisted catalog.
const fixtureName = () => test.info().title.slice(0, 200);

async function generateFixture(page: import("@playwright/test").Page) {
  await page.goto(url);
  await page.getByLabel("Your test instructions").fill(
    "Add Prepare interview, complete it, then delete it and check the task count.",
  );
  await page.getByLabel("Generate with").selectOption("fixture");
  await clickGenerateDraft(page);
  // Fixture generation includes browser inspection, which can exceed 5s under parallel load.
  await expect(page.locator("#generation-status")).toContainText("Draft ready", { timeout: 15000 });
  await expect(page.locator(".step")).toHaveCount(9);
  await page.locator("#save-test-name").fill(fixtureName());
}

test("test-design issues panel highlights CSS/XPath brittleness and links to step editor", async ({ page }) => {
  await generateFixture(page);
  const card = page.locator("#step-list .step").nth(3);
  await card.getByRole("button", { name: "Edit fields" }).click();
  await card.getByLabel("Locator strategy").selectOption("css");
  await card.getByLabel("CSS selector").fill("form > div:nth-child(2) button");
  await card.getByRole("button", { name: "Apply changes" }).click();
  await expect(card).toContainText("CSS fallback");
  const panel = page.locator("#test-design-issues");
  await panel.locator("summary").click();
  await expect(panel).toContainText("may break when the UI changes");
  const review = panel.getByRole("button", {name:"Review step 4"});
  await review.click();
  await expect(card.getByLabel("CSS selector")).toHaveValue("form > div:nth-child(2) button");
  await card.getByLabel("Locator strategy").selectOption("xpath");
  await card.getByLabel("XPath expression").fill("//form//button[2]");
  await card.getByRole("button", { name: "Apply changes" }).click();
  await expect(card).toContainText("XPath fallback");
  await expect(panel).toContainText("XPath uses positional or structural relationships");
  await expect(page.getByRole("button",{name:"Save Test"})).toBeDisabled();
});

test("read-only selector preflight suggests an Add button when generated label is wrong @sanity", async ({ page }) => {
  await generateFixture(page);
  const addStep = page.locator(".step").nth(3);
  await addStep.getByRole("button", { name: "Edit fields" }).click();
  await addStep.getByLabel("Locator strategy").selectOption("label");
  await addStep.getByRole("button", { name: "Apply changes" }).click();

  await page.getByRole("button", { name: "Check selectors (read-only)" }).click();
  await expect(page.locator("#selector-preflight-status")).toContainText(
    "Selector check complete", { timeout: 20_000 });
  await expect(page.locator("#selector-preflight-results")).toContainText(
    'button named "Add"');
  await expect(page.locator("#selector-preflight-results")).toContainText("Step 4 (warning)");
  await expect(page.locator("#selector-preflight-results")).toContainText("deferred");
  // Preflight did not auto-confirm any step, save, change expectations or run a test.
  await expect(page.locator("#save")).toBeDisabled();
  await expect(page.locator("#saved")).toBeEmpty();
  await expect(page.locator("#run-status")).toContainText("Select an approved test");

  // The warning links directly to its editable step, before any execution.
  await page.getByRole("button", { name: "Review step 4" }).click();
  await expect(addStep.getByLabel("Locator strategy")).toHaveValue("label");
  await addStep.getByLabel("Locator strategy").selectOption("role");
  await addStep.getByRole("button", { name: "Apply changes" }).click();
  await expect(page.locator("#selector-preflight-status")).toBeEmpty();
  await page.getByRole("button", { name: "Check selectors (read-only)" }).click();
  await expect(page.locator("#selector-preflight-status")).toContainText(
    "Selector check complete", { timeout: 20_000 });
  await expect(page.locator("#selector-preflight-results")).not.toContainText(
    'a different locator does match: button named "Add"');
});

test("HTTP 403 target shows inspection error and no draft instead of a false-positive test", async ({ page }) => {
  const blocked = createServer((_req, res) => {
    res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<title>Access denied</title><main>Something went wrong on our end</main>");
  });
  await new Promise<void>((resolve) => blocked.listen(0, "127.0.0.1", resolve));
  const siteURL = "http://127.0.0.1:" + (blocked.address() as AddressInfo).port;
  try {
    await page.goto(url);
    await page.getByLabel("Application URL").fill(siteURL);
    await page.getByLabel("Your test instructions").fill(
      "Search for 'Wooden Abacus' and verify matching search results",
    );
    await page.getByLabel("Generate with").selectOption("fixture");
    await clickGenerateDraft(page);
    await expect(page.locator("#generation-error")).toContainText(
      "Possible automation block by the website under test (HTTP 403 Forbidden)",
      { timeout: 20_000 });
    await expect(page.locator("#generation-error")).toContainText(
      "HTTP 403 alone does not prove automated access was blocked");
    await expect(page.locator("#generation-error")).toContainText(
      "ask the website or test-environment administrator");
    await expect(page.locator("#generation-error")).toContainText("No AI request was made");
    await expect(page.locator("#generation-review-status")).toContainText("Generation failed");
    await expect(page.locator("#draft")).toBeHidden();
    await expect(page.locator("#step-list .step")).toHaveCount(0);
    await expect(page.locator("#save")).toBeHidden();
  } finally {
    await new Promise<void>((resolve, reject) =>
      blocked.close((error) => error ? reject(error) : resolve()));
  }
});

test("plain-English input produces a readable review-only fixture draft", async ({ page }) => {
  await generateFixture(page);
  await expect(page.getByText("Fixture is a prewritten demonstration, not AI-generated.")).toBeVisible();
  await expect(page.locator(".step").nth(2)).toContainText("Enter");
  await expect(page.locator(".step").nth(2)).toContainText("Prepare interview");
  const save = page.getByRole("button", { name: "Save Test" });
  await expect(save).toBeDisabled();
  for (const box of await page.locator(".step input[type=checkbox]").all()) {
    await box.check();
  }
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.locator("#saved")).toContainText("The test has NOT been executed");
  const files = await listApprovedIds(outputDir);
  expect(files).toHaveLength(1);
  const draft = JSON.parse(await readFile(await approvedPath(outputDir, files[0]), "utf8"));
  expect(draft.steps).toHaveLength(9);
  expect(draft.steps.every((step: { action: { provenance?: string } }) =>
    step.action.provenance !== "human-confirmed",
  )).toBe(true);
});

test("Approve all steps explicitly confirms every proposed step without auto-saving or hiding individual review", async ({ page }) => {
  const previouslySaved = (await listApprovedIds(outputDir)).length;
  await generateFixture(page);
  const addAll = page.getByRole("button", { name: "Approve all steps", exact: true });
  const save = page.getByRole("button", { name: "Save Test" });
  await expect(addAll).toBeEnabled();
  await expect(save).toBeDisabled();
  await expect(page.locator("#review-progress")).toHaveText("0 of 9 steps confirmed");

  // Confirm one step manually, then bulk-confirm the rest. This must not
  // mutate definitions, save to disk, execute tests or map requirements.
  await page.locator(".step input[type=checkbox]").first().check();
  await expect(page.locator("#review-progress")).toHaveText("1 of 9 steps confirmed");
  await addAll.click();
  await expect(page.locator(".step input[type=checkbox]:checked")).toHaveCount(9);
  await expect(page.locator("#review-progress")).toHaveText("9 of 9 steps confirmed");
  await expect(addAll).toBeDisabled();
  await expect(save).toBeEnabled();
  await expect(page.locator("#saved")).toBeEmpty();
  expect(await listApprovedIds(outputDir)).toHaveLength(previouslySaved);

  // Individual checks remain editable, and changing a step requires
  // confirmation again: bulk approval is not permanent or automatic.
  await page.locator(".step input[type=checkbox]").nth(2).uncheck();
  await expect(save).toBeDisabled();
  await expect(addAll).toBeEnabled();
  await addAll.click();
  const step = page.locator(".step").nth(3);
  await step.getByRole("button", { name: "Edit fields" }).click();
  await step.getByRole("button", { name: "Apply changes" }).click();
  await expect(page.locator("#review-progress")).toHaveText("8 of 9 steps confirmed");
  await expect(save).toBeDisabled();
  await addAll.click();
  await expect(page.locator("#review-progress")).toHaveText("9 of 9 steps confirmed");

  await save.click();
  await expect(page.locator("#saved")).toContainText("Saved and ready to execute");
  expect(await listApprovedIds(outputDir)).toHaveLength(previouslySaved + 1);
});

test("user edits a step using form fields, without editing JSON", async ({ page }) => {
  await generateFixture(page);
  const thirdStep = page.locator(".step").nth(2);
  await thirdStep.getByRole("button", { name: "Edit fields" }).click();
  await thirdStep.getByLabel("Value to enter").fill("Prepare release");
  await thirdStep.getByRole("button", { name: "Apply changes" }).click();
  await expect(thirdStep).toContainText('Enter "Prepare release"');
  await expect(thirdStep.locator('input[type=checkbox]')).not.toBeChecked();

  // Users must be able to fix AI-suggested locator strategies without editing JSON:
  // a wrongly generated getByLabel("Add") can become getByRole("button", {name:"Add"}).
  const addStep = page.locator(".step").nth(3);
  await addStep.getByRole("button", { name: "Edit fields" }).click();
  await addStep.getByLabel("Locator strategy").selectOption("label");
  await expect(addStep.getByLabel("Form label text")).toHaveValue("Add");
  await addStep.getByLabel("Locator strategy").selectOption("role");
  await expect(addStep.getByLabel("Element role")).toHaveValue("button");
  await expect(addStep.getByLabel("Accessible name (may be blank)")).toHaveValue("Add");
  await addStep.getByRole("button", { name: "Apply changes" }).click();

  const taskStep = page.locator(".step").nth(4);
  await taskStep.getByRole("button", { name: "Edit fields" }).click();
  await taskStep.getByLabel("Locator strategy").selectOption("intent");
  await taskStep.getByLabel("Target intention (not a CSS selector)").fill("Prepare interview");
  await taskStep.getByRole("button", { name: "Apply changes" }).click();
  await expect(taskStep).toContainText('element matching intent "Prepare interview"');

  for (const box of await page.locator(".step input[type=checkbox]").all()) await box.check();
  await page.locator("#save-test-name").fill(fixtureName());
  await page.getByRole("button", { name: "Save Test" }).click();
  await expect(page.locator("#saved")).toContainText("Saved and ready to execute");
  const files = await listApprovedIds(outputDir);
  const drafts = await Promise.all(files.map(async (file) => JSON.parse(
    await readFile(await approvedPath(outputDir, file), "utf8"),
  )));
  expect(drafts.some((draft) => draft.steps[2].action.value === "Prepare release")).toBe(true);
  expect(drafts.some((draft) => draft.steps[3].action.target.by === "role" && draft.steps[3].action.target.role === "button" && draft.steps[3].action.target.name === "Add")).toBe(true);
});

async function approveDraft(page: import("@playwright/test").Page) {
  for (const box of await page.locator(".step input[type=checkbox]").all()) await box.check();
  await page.locator("#save-test-name").fill(fixtureName());
  await page.getByRole("button", { name: "Save Test" }).click();
  await expect(page.locator("#saved")).toContainText("Saved and ready to execute");
  await page.locator("#nav-run").click();
  await expect(page.getByRole("button", { name: "Run selected test" })).toBeEnabled();
}

test("review warns when AI proposes generic checkbox intent across multiple items", async ({ page }) => {
  await generateFixture(page);
  const complete = page.locator(".step").nth(5);
  await complete.getByRole("button", { name: "Edit fields" }).click();
  await complete.getByLabel("Locator strategy").selectOption("intent");
  await complete.getByLabel("Target intention (not a CSS selector)").fill("Complete");
  await complete.getByLabel("Expected role (optional)").selectOption("checkbox");
  await complete.getByRole("button", { name: "Apply changes" }).click();
  await expect(complete).toContainText("Ambiguous target risk");
  await complete.getByRole("button", { name: "Edit fields" }).click();
  await complete.getByLabel("Target intention (not a CSS selector)").fill("Complete Prepare interview");
  await complete.getByRole("button", { name: "Apply changes" }).click();
  await expect(complete).not.toContainText("Ambiguous target risk");
});

test("run approved test from browser and show per-step diagnostics without CLI", async ({ page }) => {
  await generateFixture(page);
  await approveDraft(page);
  await page.getByRole("button", { name: "Run selected test" }).click();
  await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 25_000 });
  const passURL = await page.locator("#run-artifacts a").first().getAttribute("href");
  const passReport = await (await fetch(url + passURL)).json();
  expect(passReport.status, JSON.stringify(passReport, null, 2)).toBe("passed");
  await expect(page.locator("#run-summary")).toContainText("PASSED");
  await expect(page.locator("#run-totals")).toContainText("9 passed");
  await expect(page.locator("#run-steps .run-step")).toHaveCount(9);
  await expect(page.locator("#run-steps")).toContainText("Verify the task appears");
  await expect(page.locator("#run-artifacts")).toContainText("View full JSON report");
  await expect(page.locator("#run-screenshot-panel")).toBeHidden();
  const reportURL = await page.locator("#run-artifacts a").first().getAttribute("href");
  expect(reportURL).toMatch(/^\/api\/runs\/[a-f0-9-]+\/report\.json$/);
  const response = await fetch(url + reportURL);
  expect(response.status).toBe(200);
  const report = await response.json();
  expect(report.status).toBe("passed");
  expect(report.steps).toHaveLength(9);
});

test("failed UI run shows first assertion mismatch and screenshot/trace downloads", async ({ page }) => {
  await generateFixture(page);
  const initialStatus = page.locator(".step").nth(1);
  await initialStatus.getByRole("button", { name: "Edit fields" }).click();
  await initialStatus.getByLabel("Expected text").fill("99 tasks, 0 completed");
  await initialStatus.getByRole("button", { name: "Apply changes" }).click();
  await approveDraft(page);
  await page.getByRole("button", { name: "Run selected test" }).click();
  await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 25_000 });
  const failureURL = await page.locator("#run-artifacts a").first().getAttribute("href");
  const failureReport = await (await fetch(url + failureURL)).json();
  expect(failureReport.status, JSON.stringify(failureReport, null, 2)).toBe("assertion-failed");
  await expect(page.locator("#run-summary")).toContainText("FAILED");
  await expect(page.locator("#run-diagnosis")).toContainText("expected result");
  await expect(page.locator("#run-steps")).toContainText("99 tasks, 0 completed");
  await expect(page.locator("#run-steps")).toContainText("0 tasks, 0 completed");
  await expect(page.locator("#run-steps .run-step").nth(1)).toContainText("assertion-failed");
  await expect(page.locator("#run-artifacts")).toContainText("Download Playwright trace");
  await expect(page.locator("#run-screenshot")).toBeVisible();
  const screenshotURL = await page.locator("#run-screenshot").getAttribute("src");
  expect(screenshotURL).toMatch(/\/failure\.png$/);
  const response = await fetch(url + screenshotURL);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("image/png");
  const tracePath = await page.getByRole("link", { name: "Download Playwright trace" }).getAttribute("href");
  const traceResponse = await fetch(url + tracePath);
  expect(traceResponse.status).toBe(200);
  expect(traceResponse.headers.get("content-type")).toContain("application/zip");
});

test("tester reviews dynamic final text assertion, explicitly approves correction and reruns", async ({ page }) => {
  const testDefinition = {
    schemaVersion: 1,
    id: "two-task-final-status",
    title: "Complete presentation, delete documentation and verify final count",
    version: 1,
    steps: [
      { id: "open", description: "Open task list", action: { kind: "navigate", url: "/" } },
      { id: "task1", description: "Enter presentation", action: {
        kind: "fill", target: { by: "role", role: "textbox", name: "Task" },
        value: "preparing a presentation",
      } },
      { id: "add1", description: "Add presentation", action: {
        kind: "click", target: { by: "role", role: "button", name: "Add" },
      } },
      { id: "task2", description: "Enter documentation", action: {
        kind: "fill", target: { by: "role", role: "textbox", name: "Task" },
        value: "reviewing documentation",
      } },
      { id: "add2", description: "Add documentation", action: {
        kind: "click", target: { by: "role", role: "button", name: "Add" },
      } },
      { id: "finish", description: "Complete presentation", action: {
        kind: "click", target: {
          by: "intent", value: "Complete preparing a presentation", role: "checkbox",
        },
      } },
      { id: "verify-two", description: "Two tasks, one completed", action: {
        kind: "assert-text", target: { by: "role", role: "status" },
        expected: "2 tasks, 1 completed", provenance: "requirements",
      } },
      { id: "delete", description: "Delete unfinished documentation", action: {
        kind: "click", target: {
          by: "intent", value: "Delete reviewing documentation", role: "button",
        },
      } },
      { id: "final", description: "Verify only completed presentation remains", action: {
        kind: "assert-text", target: { by: "role", role: "status" },
        expected: "1 tasks, 1 completed", provenance: "requirements",
      } },
    ],
  };
  const savedResponse = await page.request.post(url + "/api/save", {
    data: { testName: fixtureName(), definition: testDefinition, baseURL: "http://127.0.0.1:3000" },
  });
  expect(savedResponse.status()).toBe(200);
  const saved = await savedResponse.json();
  await page.goto(url);
  await selectSavedScript(page, saved.id);
  await page.getByRole("button", { name: "Run selected test" }).click();
  await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 25_000 });
  await expect(page.locator("#run-summary")).toContainText("FAILED");
  const panel = page.locator(".assertion-repair");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Original expected: 1 tasks, 1 completed");
  await expect(panel).toContainText("Observed from run: 1 task, 1 completed");
  const expectedField = panel.getByLabel("New expected text", { exact: true });
  await expect(expectedField).toHaveValue("1 tasks, 1 completed");
  const confirm = panel.getByRole("checkbox", { name: /I verified this new expected text/ });
  const reviseButton = panel.getByRole("button", { name: "Save reviewed assertion and rerun from start" });
  await expect(reviseButton).toBeDisabled();

  const originalReportLink = await page.getByRole("link", { name: "View full JSON report" }).getAttribute("href");
  if (!originalReportLink) throw new Error("Missing run report link");
  const runId = originalReportLink.split("/")[3];
  // No arbitrary changes to a run's expectations without human confirmation.
  const unconfirmed = await page.request.post(url + "/api/repair-assertion", {
    data: { runId, stepId: "final", expected: "1 task, 1 completed", confirmed: false },
  });
  expect(unconfirmed.status()).toBe(400);
  expect(await unconfirmed.json()).toMatchObject({
    error: expect.stringContaining("explicitly confirm"),
  });
  const notFailed = await page.request.post(url + "/api/repair-assertion", {
    data: { runId, stepId: "verify-two", expected: "2 tasks, 0 completed", confirmed: true },
  });
  expect(notFailed.status()).toBe(400);

  await panel.getByRole("button", { name: "Use observed text as draft" }).click();
  await expect(expectedField).toHaveValue("1 task, 1 completed");
  await expect(reviseButton).toBeDisabled();
  await confirm.check();
  await expect(reviseButton).toBeEnabled();
  const original = JSON.parse(await readFile(await approvedPath(outputDir, saved.id), "utf8"));
  await reviseButton.click();
  await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 25_000 });
  await expect(page.locator("#run-summary")).toContainText("PASSED");
  const revisedId = await page.locator("#execution-panel").getByLabel("Test", { exact: true }).inputValue();
  expect(revisedId).not.toBe(saved.id);
  expect((await listApprovedIds(outputDir)).includes(saved.id)).toBe(false);
  await expect(page.locator("#approved-tests option[value='" + saved.id + "']")).toHaveCount(0);
  expect((await page.request.get(url + originalReportLink)).status()).toBe(404);
  const revised = JSON.parse(await readFile(await approvedPath(outputDir, revisedId), "utf8"));
  expect(original.steps[8].action).toMatchObject({
    expected: "1 tasks, 1 completed", provenance: "requirements",
  });
  expect(revised.steps[8].action).toMatchObject({
    expected: "1 task, 1 completed", provenance: "human-confirmed",
  });
  expect(revised.steps.slice(0, 8)).toEqual(original.steps.slice(0, 8));
  const reportLink = await page.getByRole("link", { name: "View full JSON report" }).getAttribute("href");
  const report = await (await fetch(url + reportLink)).json();
  expect(report.status).toBe("passed");
  expect(report.steps[8]).toMatchObject({
    status: "passed", expected: "1 task, 1 completed",
    observed: "1 task, 1 completed",
  });
});

test("saved test can be loaded, edited and resaved entirely via the review UI", async ({ page }) => {
  await generateFixture(page);
  await approveDraft(page);
  const originalId = await page.locator("#execution-panel").getByLabel("Test", { exact: true }).inputValue();
  expect(originalId).toMatch(/^reviewed-/);
  await expect(page.getByRole("button", { name: "Edit test" })).toBeEnabled();
  const original = JSON.parse(await readFile(await approvedPath(outputDir, originalId), "utf8"));
  const beforeList = (await (await page.request.get(url + "/api/tests")).json()).tests;
  // A malformed replacement must never remove the source file.
  const rejected = await page.request.post(url + "/api/save", {
    data: { testName: fixtureName(), definition: { ...original, schemaVersion: 17 },
      baseURL: "http://127.0.0.1:3000", replaceId: originalId },
  });
  expect(rejected.status()).toBe(400);
  expect((await listApprovedIds(outputDir)).includes(originalId)).toBe(true);
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Edit test" }).click();
  await expect(page.locator("#draft-hint")).toContainText("Loaded an approved test for editing");
  await expect(page.locator(".step")).toHaveCount(9);
  await expect(page.getByRole("button", { name: "Save Test" })).toBeDisabled();
  const fourth = page.locator(".step").nth(3);
  await fourth.getByRole("button", { name: "Edit fields" }).click();
  await fourth.getByLabel("Description").fill("Add a task via the button");
  await fourth.getByRole("button", { name: "Apply changes" }).click();
  await expect(fourth).toContainText("Add a task via the button");
  for (const box of await page.locator(".step input[type=checkbox]").all()) {
    await box.check();
  }
  await page.locator("#save-test-name").fill(fixtureName());
  await page.getByRole("button", { name: "Save Test" }).click();
  await expect(page.locator("#saved")).toContainText("old version removed from the list");
  const revisedId = await page.locator("#execution-panel").getByLabel("Test", { exact: true }).inputValue();
  expect(revisedId).not.toBe(originalId);
  await expect(page.locator("#approved-tests option[value='" + originalId + "']")).toHaveCount(0);
  await expect(page.locator("#approved-tests option[value='" + revisedId + "']")).toHaveCount(1);
  const afterList = (await (await page.request.get(url + "/api/tests")).json()).tests;
  expect(afterList.length).toBe(beforeList.length);
  await expect.poll(async () => (await listApprovedIds(outputDir)).includes(originalId)).toBe(false);
  const revised = JSON.parse(await readFile(await approvedPath(outputDir, revisedId), "utf8"));
  expect(original.steps[3].description).not.toBe("Add a task via the button");
  expect(revised.steps[3].description).toBe("Add a task via the button");
  expect(revised.steps[3].action).toEqual(original.steps[3].action);
  await page.locator("#nav-run").click();
  await page.getByRole("button", { name: "Run selected test" }).click();
  await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 30000 });
  await expect(page.locator("#run-summary")).toContainText("PASSED");
});

test("editable DOM search works with no initial suggestions and cannot silently fix expectation", async ({ page }) => {
  const site = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end('<!doctype html><body><div>Sauce Labs Backpack</div>' +
      '<button>Add to cart</button></body>');
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const baseURL = "http://127.0.0.1:" + (site.address() as AddressInfo).port;
  try {
    const definition = { schemaVersion: 1, id: "must-not-auto-pass",
      title: "Missing expected product", version: 1, steps: [
        { id: "open", description: "Open", action: { kind: "navigate", url: "/" } },
        { id: "missing", description: "Check incorrect expectation", action: {
          kind: "assert-text", target: { by: "role", role: "button", name: "Add to cart" },
          expected: "Sauce Labs Laptop", provenance: "requirements",
        } },
      ],
    };
    const savedResponse = await page.request.post(url + "/api/save", {
      data: { testName: fixtureName(), definition, baseURL },
    });
    expect(savedResponse.status()).toBe(200);
    const saved = await savedResponse.json();
    await page.goto(url);
    // The one-script dropdown is intentionally scoped to the chosen website.
    await page.locator("#nav-run").click();
    await page.getByLabel("Test suite (website URL)").selectOption(baseURL);
    await page.getByLabel("Execution URL").fill(baseURL);
    await selectSavedScript(page, saved.id);
    await page.getByRole("button", { name: "Run selected test" }).click();
    await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 30000 });
    await expect(page.locator("#run-summary")).toContainText("FAILED");
    const picker = page.locator("#run-steps .run-step").nth(1).locator(".assertion-dom-repair");
    await expect(picker).toBeVisible();
    await expect(picker.locator(".assertion-dom-option")).toHaveCount(0);
    const field = picker.getByLabel("Search visible DOM text");
    await expect(field).toHaveValue("Sauce Labs Laptop");
    await field.fill("Backpack");
    await picker.getByRole("button", { name: "Search captured DOM" }).click();
    await expect(picker.locator(".assertion-dom-option")).toHaveCount(1);
    await expect(picker).toContainText("Sauce Labs Backpack");
    await picker.locator('input[type="radio"]').check();
    await picker.getByRole("button", { name: "Save corrected assertion target and rerun" }).click();
    await expect.poll(async () =>
      page.locator("#execution-panel").getByLabel("Test", { exact: true }).inputValue(), { timeout: 30000 },
    ).not.toBe(saved.id);
    await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 30000 });
    await expect(page.locator("#run-summary")).toContainText("FAILED");
    const currentId = await page.locator("#execution-panel").getByLabel("Test", { exact: true }).inputValue();
    expect((await listApprovedIds(outputDir)).includes(saved.id)).toBe(false);
    const amended = JSON.parse(await readFile(await approvedPath(outputDir, currentId), "utf8"));
    expect(amended.steps[1].action).toEqual({
      kind: "assert-text", target: { by: "text", value: "Sauce Labs Backpack" },
      expected: "Sauce Labs Laptop", provenance: "requirements",
    });
    await expect(page.locator("#run-steps .run-step").nth(1)).toContainText('expected "Sauce Labs Laptop"');
    await expect(page.locator("#run-steps .run-step").nth(1)).toContainText('observed "Sauce Labs Backpack"');
  } finally {
    await new Promise<void>((resolve, reject) =>
      site.close((error) => error ? reject(error) : resolve()));
  }
});

test("wrong existing button text assertion searches product div and repairs selector via UI", async ({ page }) => {
  const site = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end('<!doctype html><html><title>Shop</title><main>' +
      '<div class="inventory_details_name large_size">Sauce Labs Backpack</div>' +
      '<button type="button">Add to cart</button>' +
      '<div class="inventory_details_price">$29.99</div></main></html>');
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const baseURL = "http://127.0.0.1:" + (site.address() as AddressInfo).port;
  try {
    const definition = {
      schemaVersion: 1, id: "saucedemo-wrong-selector", title: "Backpack detail",
      version: 1, steps: [
        { id: "open", description: "Open product page", action: { kind: "navigate", url: "/" } },
        { id: "backpack", description: "Confirm backpack product name", action: {
          kind: "assert-text",
          target: { by: "role", role: "button", name: "Add to cart" },
          expected: "Sauce Labs Backpack", provenance: "requirements",
        } },
      ],
    };
    const resp = await page.request.post(url + "/api/save", {
      data: { testName: fixtureName(), definition, baseURL },
    });
    expect(resp.status(), await resp.text()).toBe(200);
    const saved = await resp.json();
    const original = JSON.parse(await readFile(await approvedPath(outputDir, saved.id), "utf8"));
    await page.goto(url);
    // The one-script dropdown is intentionally scoped to the chosen website.
    await page.locator("#nav-run").click();
    await page.getByLabel("Test suite (website URL)").selectOption(baseURL);
    await page.getByLabel("Execution URL").fill(baseURL);
    await selectSavedScript(page, saved.id);
    await page.getByRole("button", { name: "Run selected test" }).click();
    await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 30000 });
    await expect(page.locator("#run-summary")).toContainText("FAILED");
    const failed = page.locator("#run-steps .run-step").nth(1);
    await expect(failed).toContainText('expected "Sauce Labs Backpack"');
    await expect(failed).toContainText('observed "Add to cart"');
    const picker = failed.locator(".assertion-dom-repair");
    await expect(picker).toBeVisible();
    await expect(picker).toContainText('Sauce Labs Backpack');
    await expect(picker).toContainText('<div>');
    await expect(picker.locator(".assertion-dom-option")).toHaveCount(1);
    await expect(picker).toContainText('Visible text "Sauce Labs Backpack"');
    const button = picker.getByRole("button", { name: "Save corrected assertion target and rerun" });
    await expect(button).toBeDisabled();
    const link = await page.getByRole("link", { name: "View full JSON report" }).getAttribute("href");
    if (!link) throw new Error("Missing failed report");
    const report = await (await fetch(url + link)).json();
    expect(report.steps[1]).toMatchObject({
      status: "assertion-failed",
      expected: "Sauce Labs Backpack",
      observed: "Add to cart",
      assertionAlternatives: {
        query: "Sauce Labs Backpack",
        attempted: { by: "role", role: "button", name: "Add to cart" },
        total: 1,
        candidates: [{ tag: "div", target: { by: "text", value: "Sauce Labs Backpack" } }],
      },
    });
    const runId = link.split("/")[3];
    const wrongStep = await page.request.post(url + "/api/repair-assertion-target", {
      data: { runId, stepId: "open", candidateIndex: 0 },
    });
    expect(wrongStep.status()).toBe(400);
    const invalidIndex = await page.request.post(url + "/api/repair-assertion-target", {
      data: { runId, stepId: "backpack", candidateIndex: 17 },
    });
    expect(invalidIndex.status()).toBe(400);

    const searchField = picker.getByLabel("Search visible DOM text");
    const search = picker.getByRole("button", { name: "Search captured DOM" });
    await expect(searchField).toHaveValue("Sauce Labs Backpack");
    // The tester can search for DIFFERENT page text without changing the
    // expected assertion or replaying navigation/product actions.
    await searchField.fill("Add to cart");
    await search.click();
    await expect(picker.locator(".assertion-dom-option")).toHaveCount(1);
    await expect(picker.locator(".assertion-dom-option")).toContainText(['button named "Add to cart"']);
    const afterWrongSearch = await page.request.get(url + link);
    const wrongSearchReport = await afterWrongSearch.json();
    expect(wrongSearchReport.steps[1].expected).toBe("Sauce Labs Backpack");

    await searchField.fill("backpack");
    await search.click();
    await expect(picker.locator(".assertion-dom-option")).toHaveCount(1);
    await expect(picker).toContainText('Visible text "Sauce Labs Backpack"');
    const afterSearch = await (await page.request.get(url + link)).json();
    expect(afterSearch.steps[1].assertionAlternatives).toMatchObject({
      query: "backpack", searched: true, total: 1,
    });
    const missingSearchToken = await page.request.post(url + "/api/repair-assertion-target", {
      data: { runId, stepId: "backpack", candidateIndex: 0 },
    });
    expect(missingSearchToken.status()).toBe(400);
    await searchField.fill("no such product");
    await search.click();
    await expect(picker.locator(".assertion-dom-option")).toHaveCount(0);
    await expect(picker).toContainText("No uniquely identifiable visible text matched");
    await expect(button).toBeDisabled();
    await searchField.fill("Backpack");
    await search.click();
    await expect(picker.locator(".assertion-dom-option")).toHaveCount(1);
    await picker.locator('input[type="radio"]').check();
    await expect(button).toBeEnabled();
    await button.click();
    await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 30000 });
    await expect(page.locator("#run-summary")).toContainText("PASSED");
    const revisedId = await page.locator("#execution-panel").getByLabel("Test", { exact: true }).inputValue();
    expect(revisedId).not.toBe(saved.id);
    expect((await listApprovedIds(outputDir)).includes(saved.id)).toBe(false);
    const revised = JSON.parse(await readFile(await approvedPath(outputDir, revisedId), "utf8"));
    expect(revised.steps[0]).toEqual(original.steps[0]);
    expect(revised.steps[1].action).toEqual({
      kind: "assert-text",
      target: { by: "text", value: "Sauce Labs Backpack" },
      expected: "Sauce Labs Backpack",
      provenance: "requirements",
    });
    expect((await page.request.get(url + link)).status()).toBe(404);
    const reportLink = await page.getByRole("link", { name: "View full JSON report" }).getAttribute("href");
    const finalReport = await (await fetch(url + reportLink)).json();
    expect(finalReport.status).toBe("passed");
    expect(finalReport.steps[1]).toMatchObject({
      status: "passed", expected: "Sauce Labs Backpack", observed: "Sauce Labs Backpack",
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      site.close((error) => error ? reject(error) : resolve()));
  }
});

test("live DOM Products text repairs missing heading assertion through UI, then reruns", async ({ page }) => {
  // Mirrors real-world inventory markup: "Products" is a visible span,
  // not an accessible heading. No SauceDemo network access is needed in CI.
  const external = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end('<!doctype html><html><title>Shop</title><main>' +
      '<div class="inventory_header"><span class="title">Products</span></div>' +
      '<div>Welcome to the inventory</div></main></html>');
  });
  await new Promise<void>((resolve) => external.listen(0, "127.0.0.1", resolve));
  const baseURL = "http://127.0.0.1:" + (external.address() as AddressInfo).port;
  try {
    const definition = {
      schemaVersion: 1, id: "shop-products-assertion", title: "Products page",
      version: 1, steps: [
        { id: "navigate", description: "Open shop", action: {
          kind: "navigate", url: "/",
        } },
        { id: "products", description: "Verify Products heading", action: {
          kind: "assert-visible",
          target: { by: "role", role: "heading", name: "Products" },
          provenance: "requirements",
        } },
      ],
    };
    const savedResponse = await page.request.post(url + "/api/save", {
      data: { testName: fixtureName(), definition, baseURL },
    });
    expect(savedResponse.status(), await savedResponse.text()).toBe(200);
    const saved = await savedResponse.json();
    const original = JSON.parse(await readFile(await approvedPath(outputDir, saved.id), "utf8"));
    await page.goto(url);
    // The one-script dropdown is intentionally scoped to the chosen website.
    await page.locator("#nav-run").click();
    await page.getByLabel("Test suite (website URL)").selectOption(baseURL);
    await page.getByLabel("Execution URL").fill(baseURL);
    await selectSavedScript(page, saved.id);
    await page.getByRole("button", { name: "Run selected test" }).click();
    await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 25_000 });
    await expect(page.locator("#run-summary")).toContainText("FAILED");
    const failed = page.locator("#run-steps .run-step").nth(1);
    await expect(failed).toContainText("getByRole('heading'");
    const picker = failed.locator(".assertion-dom-repair");
    await expect(picker).toBeVisible();
    await expect(picker).toContainText('Products');
    await expect(picker).toContainText('<span>');
    await expect(picker.locator(".assertion-dom-option")).toHaveCount(1);
    await expect(picker).toContainText('Visible text "Products"');
    const action = picker.getByRole("button", { name: "Save corrected assertion target and rerun" });
    await expect(action).toBeDisabled();

    const reportLink = await page.getByRole("link", { name: "View full JSON report" }).getAttribute("href");
    if (!reportLink) throw new Error("Missing report link");
    const report = await (await fetch(url + reportLink)).json();
    expect(report.steps[1].assertionAlternatives).toMatchObject({
      attempted: { by: "role", role: "heading", name: "Products" },
      query: "Products", total: 1,
      candidates: [{
        tag: "span", name: "Products",
        target: { by: "text", value: "Products" },
      }],
    });
    const runId = reportLink.split("/")[3];
    const invalidStep = await page.request.post(url + "/api/repair-assertion-target", {
      data: { runId, stepId: "navigate", candidateIndex: 0 },
    });
    expect(invalidStep.status()).toBe(400);
    const invalidChoice = await page.request.post(url + "/api/repair-assertion-target", {
      data: { runId, stepId: "products", candidateIndex: 99 },
    });
    expect(invalidChoice.status()).toBe(400);
    // No candidate may be applied without explicit selection in the UI.
    await picker.locator('input[type="radio"]').check();
    await expect(action).toBeEnabled();
    await action.click();
    await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 25_000 });
    await expect(page.locator("#run-summary")).toContainText("PASSED");
    const correctedId = await page.locator("#execution-panel").getByLabel("Test", { exact: true }).inputValue();
    expect(correctedId).not.toBe(saved.id);
    const amended = JSON.parse(await readFile(await approvedPath(outputDir, correctedId), "utf8"));
    expect(original.steps[1].action.target).toEqual({
      by: "role", role: "heading", name: "Products",
    });
    expect(amended.steps[1].action).toEqual({
      kind: "assert-visible", target: { by: "text", value: "Products" },
      provenance: "requirements",
    });
    expect(amended.steps[0]).toEqual(original.steps[0]);
    expect((await listApprovedIds(outputDir)).includes(saved.id)).toBe(false);
    await expect(page.locator("#approved-tests option[value='" + saved.id + "']")).toHaveCount(0);
    expect((await page.request.get(url + reportLink)).status()).toBe(404);
    const latest = await page.getByRole("link", { name: "View full JSON report" }).getAttribute("href");
    const passed = await (await fetch(url + latest)).json();
    expect(passed.steps.map((step: { status: string }) => step.status)).toEqual(["passed", "passed"]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      external.close((error) => error ? reject(error) : resolve()));
  }
});

test("missing Add label exposes live Add button for UI-only repair and complete rerun", async ({ page }) => {
  const definition = JSON.parse(await readFile("examples/add-task.json", "utf8"));
  definition.id = "test-one-missing-add";
  definition.title = "Buy groceries task lifecycle";
  for (const step of definition.steps) {
    step.description = step.description.replaceAll("Prepare interview", "Buy groceries");
    if (typeof step.action.value === "string") {
      step.action.value = step.action.value.replaceAll("Prepare interview", "Buy groceries");
    }
    const target = step.action.target;
    if (target?.name) target.name = target.name.replaceAll("Prepare interview", "Buy groceries");
    if (target?.value) target.value = target.value.replaceAll("Prepare interview", "Buy groceries");
  }
  definition.steps[3].action.target = { by: "label", value: "Add" };
  const savedResponse = await page.request.post(url + "/api/save", {
    data: { testName: fixtureName(), definition, baseURL: "http://127.0.0.1:3000" },
  });
  expect(savedResponse.status(), await savedResponse.text()).toBe(200);
  const saved = await savedResponse.json();
  const original = JSON.parse(await readFile(await approvedPath(outputDir, saved.id), "utf8"));
  await page.goto(url);
  await selectSavedScript(page, saved.id);
  await page.getByRole("button", { name: "Run selected test" }).click();
  await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 30_000 });
  await expect(page.locator("#run-summary")).toContainText("FAILED");
  const failed = page.locator("#run-steps .run-step").nth(3);
  await expect(failed).toContainText("getByLabel('Add'");
  const repair = failed.locator(".locator-repair");
  await expect(repair).toBeVisible();
  await expect(repair).toContainText("Failed locator: field labelled \"Add\"");
  await expect(repair.locator(".locator-option")).toHaveCount(1);
  await expect(repair).toContainText("button named Add");
  const save = repair.getByRole("button", { name: "Save corrected locator and rerun from start" });
  await expect(save).toBeDisabled();
  const reportLink = await page.getByRole("link", { name: "View full JSON report" }).getAttribute("href");
  if (!reportLink) throw new Error("Missing report link");
  const report = await (await fetch(url + reportLink)).json();
  expect(report.steps[3].locatorAlternatives).toMatchObject({
    attempted: { by: "label", value: "Add" },
    total: 1,
    candidates: [{ role: "button", name: "Add" }],
  });
  const runId = reportLink.split("/")[3];
  const tampered = await page.request.post(url + "/api/repair-target", {
    data: { runId, stepId: "enter", candidateIndex: 0 },
  });
  expect(tampered.status()).toBe(400);
  const outOfRange = await page.request.post(url + "/api/repair-target", {
    data: { runId, stepId: "add", candidateIndex: 99 },
  });
  expect(outOfRange.status()).toBe(400);

  await repair.locator(".locator-option input[type=radio]").check();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 30_000 });
  await expect(page.locator("#run-summary")).toContainText("PASSED");
  const correctedId = await page.locator("#execution-panel").getByLabel("Test", { exact: true }).inputValue();
  expect(correctedId).not.toBe(saved.id);
  expect((await listApprovedIds(outputDir)).includes(saved.id)).toBe(false);
  await expect(page.locator("#approved-tests option[value='" + saved.id + "']")).toHaveCount(0);
  const discarded = await page.request.get(url + reportLink);
  expect(discarded.status()).toBe(404);
  const corrected = JSON.parse(await readFile(await approvedPath(outputDir, correctedId), "utf8"));
  expect(original.steps[3].action.target).toEqual({ by: "label", value: "Add" });
  expect(corrected.steps[3].action.target).toEqual({
    by: "role", role: "button", name: "Add",
  });
  expect(corrected.steps.filter((step: { id: string }) => step.id !== "add"))
    .toEqual(original.steps.filter((step: { id: string }) => step.id !== "add"));
  const finalReportLink = await page.getByRole("link", { name: "View full JSON report" }).getAttribute("href");
  const final = await (await fetch(url + finalReportLink)).json();
  expect(final.status).toBe("passed");
  expect(final.steps.every((step: { status: string }) => step.status === "passed")).toBe(true);
});

test("bulk locator repair previews later matching steps and preserves other actions", async ({ page }) => {
  const definition = JSON.parse(await readFile("examples/add-task.json", "utf8"));
  definition.steps[3].action.target = { by: "label", value: "Add" };
  definition.steps.push(
    { id: "enter-second", description: "Enter second task", action: {kind:"fill",target:{by:"label",value:"Task"},value:"Second task"} },
    { id: "add-second", description: "Add second task", action: {kind:"click",target:{by:"label",value:"Add"}} },
    { id: "verify-second", description: "Verify second task", action: {kind:"assert-visible",target:{by:"text",value:"Second task"},provenance:"requirements"} },
  );
  const response = await page.request.post(url+"/api/save",{data:{testName:"Bulk repair",definition,baseURL:"http://127.0.0.1:3000"}});
  expect(response.status()).toBe(200);
  const saved=await response.json();
  await page.goto(url);
  await selectSavedScript(page,saved.id);
  await page.getByRole("button",{name:"Run selected test"}).click();
  await expect(page.locator("#run-status")).toContainText("Run complete",{timeout:30000});
  await expect(page.locator("#run-summary")).toContainText("FAILED");
  await expect(page.locator("#run-metrics")).toContainText("Failed");
  const repair=page.locator("#run-steps .locator-repair").first();
  await repair.locator(".locator-option input").check();
  const all=repair.getByRole("checkbox",{name:"Amend all matching occurrences in this test (2)"});
  await expect(all).toBeVisible();
  await expect(all).not.toBeChecked();
  await expect(repair).toContainText("Step 11 — Add second task");
  const reportLink=await page.getByRole("link",{name:"View full JSON report"}).getAttribute("href");
  const runId=reportLink!.split("/")[3];
  const rejected=await page.request.post(url+"/api/repair-target",{data:{runId,stepId:"add",candidateIndex:0,scope:"all",confirmedStepIds:["add"]}});
  expect(rejected.status()).toBe(400);
  await all.check();
  await repair.getByRole("button",{name:"Save all matching corrections and rerun from start"}).click();
  await expect(page.locator("#run-status")).toContainText("Run complete",{timeout:30000});
  await expect(page.locator("#run-summary")).toContainText("PASSED");
  const id=await page.locator("#approved-tests").inputValue();
  const corrected=JSON.parse(await readFile(await approvedPath(outputDir,id),"utf8"));
  for (const entry of definition.steps) {
    const revised=corrected.steps.find((step:{id:string})=>step.id===entry.id);
    expect(revised).toEqual(["add","add-second"].includes(entry.id)
      ? {...entry,action:{...entry.action,target:{by:"role",role:"button",name:"Add"}}} : entry);
  }
});

test("human chooses among live checkbox candidates; repaired copy reruns successfully @sanity", async ({ page }) => {
  const ambiguous = {
    schemaVersion: 1,
    id: "two-task-choice",
    title: "Complete only the presentation task",
    version: 1,
    steps: [
      { id: "open", description: "Open task list", action: { kind: "navigate", url: "/" } },
      { id: "task1", description: "Enter presentation", action: {
        kind: "fill", target: { by: "role", role: "textbox", name: "Task" },
        value: "preparing a presentation",
      } },
      { id: "add1", description: "Add presentation", action: {
        kind: "click", target: { by: "role", role: "button", name: "Add" },
      } },
      { id: "task2", description: "Enter documentation", action: {
        kind: "fill", target: { by: "role", role: "textbox", name: "Task" },
        value: "reviewing documentation",
      } },
      { id: "add2", description: "Add documentation", action: {
        kind: "click", target: { by: "role", role: "button", name: "Add" },
      } },
      { id: "finish", description: "Complete the presentation task", action: {
        kind: "click", target: { by: "intent", value: "Complete", role: "checkbox" },
      } },
      { id: "verify", description: "Check completed count", action: {
        kind: "assert-text", target: { by: "role", role: "status" },
        expected: "2 tasks, 1 completed", provenance: "requirements",
      } },
      { id: "delete", description: "Remove unfinished documentation task", action: {
        kind: "click", target: { by: "intent", value: "Delete reviewing documentation", role: "button" },
      } },
      { id: "final", description: "Only presentation remains", action: {
        kind: "assert-text", target: { by: "role", role: "status" },
        expected: "1 task, 1 completed", provenance: "requirements",
      } },
    ],
  };
  const savedResponse = await page.request.post(url + "/api/save", {
    data: { testName: fixtureName(), definition: ambiguous, baseURL: "http://127.0.0.1:3000" },
  });
  expect(savedResponse.status()).toBe(200);
  const saved = await savedResponse.json();
  await page.goto(url);
  await selectSavedScript(page, saved.id);
  await page.getByRole("button", { name: "Run selected test" }).click();
  await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 25000 });
  await expect(page.locator(".repair-choice")).toBeVisible();
  await expect(page.locator(".repair-option")).toHaveCount(2);
  const radio = page.locator(".repair-option")
    .filter({ hasText: "Complete preparing a presentation" })
    .locator('input[type="radio"]');
  await radio.check();
  const firstRun = await page.getByRole("link", { name: "View full JSON report" }).getAttribute("href");
  if (!firstRun) throw new Error("Missing report link");
  const original = JSON.parse(await readFile(await approvedPath(outputDir, saved.id), "utf8"));
  const originalReport = await (await fetch(url + firstRun)).json();
  const failingStep = originalReport.steps.find((step: { id: string }) => step.id === "finish");
  expect(failingStep.status).toBe("execution-error");
  expect(failingStep.ambiguity.candidates).toHaveLength(2);
  expect(failingStep.ambiguity.intent).toBe("Complete");

  // The repair endpoint must reject arbitrary candidate indices even on valid runs.
  const rejected = await page.request.post(url + "/api/repair", {
    data: { runId: firstRun.split("/")[3], candidateIndex: 99 },
  });
  expect(rejected.status()).toBe(400);

  await page.getByRole("button", { name: "Save corrected copy and rerun from start" }).click();
  await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 25000 });
  await expect(page.locator("#run-summary")).toContainText("PASSED");
  const newFile = await page.locator("#execution-panel").getByLabel("Test", { exact: true }).inputValue();
  expect(newFile).not.toBe(saved.id);
  const files = await listApprovedIds(outputDir);
  const repaired = JSON.parse(await readFile(await approvedPath(outputDir, newFile), "utf8"));
  expect(original.steps[5].action.target.value).toBe("Complete");
  expect(repaired.steps[5].action.target).toEqual({
    by: "intent", value: "Complete preparing a presentation", role: "checkbox",
  });
  expect(repaired.steps[6].action.expected).toBe("2 tasks, 1 completed");
  expect(repaired.steps[8].action.expected).toBe("1 task, 1 completed");
  expect(files).toContain(newFile);
  expect(files).not.toContain(saved.id);
  await expect(page.locator("#approved-tests option[value='" + saved.id + "']")).toHaveCount(0);
  expect((await page.request.get(url + firstRun)).status()).toBe(404);
  const finalReportURL = await page.getByRole("link", { name: "View full JSON report" }).getAttribute("href");
  const finalReport = await (await fetch(url + finalReportURL)).json();
  expect(finalReport.status).toBe("passed");
  expect(finalReport.steps[5].resolution.name).toBe("Complete preparing a presentation");
});

test("cannot run an unsaved or arbitrary path, or access nonexistent report", async () => {
  const invalid = await fetch(url + "/api/run", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "../../examples/add-task.json", baseURL: "http://127.0.0.1:3000" }),
  });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({ error: expect.stringContaining("Invalid approved test") });
  const notFound = await fetch(url + "/api/runs/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/report.json");
  expect(notFound.status).toBe(404);
});

test("Test 1 repairs string-valued steps with one extra mocked Groq call @sanity", async ({ page, browser }) => {
  const valid = JSON.parse(await readFile("examples/add-task.json", "utf8"));
  valid.id = "groq-test-one";
  valid.title = "Buy groceries task lifecycle";
  for (const step of valid.steps) {
    step.description = step.description.replaceAll("Prepare interview", "Buy groceries");
    if (step.action.value) step.action.value = step.action.value.replaceAll("Prepare interview", "Buy groceries");
    if (step.action.target?.name) {
      step.action.target.name = step.action.target.name.replaceAll("Prepare interview", "Buy groceries");
    }
    if (step.action.target?.value) {
      step.action.target.value = step.action.target.value.replaceAll("Prepare interview", "Buy groceries");
    }
    if (step.action.provenance === "human-confirmed") step.action.provenance = "requirements";
  }
  const malformed = {
    ...valid,
    steps: Array.from({ length: 13 }, (_, index) =>
      [4, 6, 8, 10, 12].includes(index)
        ? "Verify a task count" : structuredClone(valid.steps[index % 9]),
    ),
  };
  const prompts: string[] = [];
  const mock = async ({ prompt }: { prompt: string }) => {
    prompts.push(prompt);
    return JSON.stringify(prompts.length === 1 ? malformed : {...valid,coverage:{entries:[{id:"R1",interpretation:"Task lifecycle",stepIds:valid.steps.map((step:{id:string})=>step.id),availability:"identified"}]}});
  };
  const temporary = await createReviewServer(outputDir, browser, mock);
  await new Promise<void>((resolve) => temporary.listen(0, "127.0.0.1", resolve));
  const tempURL = "http://127.0.0.1:" + (temporary.address() as AddressInfo).port;
  try {
    await page.goto(tempURL);
    await page.getByLabel("Your test instructions").fill(
      'Open the task list, add "Buy groceries", complete it, delete it and verify each count.',
    );
    await clickGenerateDraft(page);
    await expect(page.locator("#generation-status")).toContainText("Draft ready", { timeout: 25000 });
    await expect(page.locator("#generation-status")).toContainText("One extra AI call");
    await expect(page.locator("#generation-error")).toBeEmpty();
    await expect(page.locator(".step")).toHaveCount(9);
    await expect(page.locator("#draft-hint")).toContainText("first AI draft was invalid");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("steps[4]");
    expect(prompts[1]).toContain("expected object, received string");
    expect(prompts[1]).toContain("COMPLETE test definition");
    await expect(page.getByRole("button", { name: "Save Test" })).toBeDisabled();
  } finally {
    // Close the Playwright page's idle HTTP connections before awaiting shutdown.
    // Otherwise server.close can hang on CI and consume the entire test timeout.
    temporary.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      temporary.close((err) => err ? reject(err) : resolve()));
  }
});

test("two malformed responses stop after one bounded retry with safe step diagnostics", async ({ page, browser }) => {
  const mockOutput = JSON.stringify({
    schemaVersion: 1, id: "invalid-test", title: "Invalid output", version: 1,
    steps: [
      { id: "open", description: "Open", action: { kind: "navigate", url: "/" } },
      "Verify task count",
      { id: "status", description: "Check count", action: {
        kind: "assert-text", target: { by: "role", role: "status" },
        expected: "0 tasks, 0 completed", provenance: "requirements",
      } },
    ],
  });
  let calls = 0;
  const temporary = await createReviewServer(outputDir, browser, async () => {
    calls++;
    return mockOutput;
  });
  await new Promise<void>((resolve) => temporary.listen(0, "127.0.0.1", resolve));
  const tempURL = "http://127.0.0.1:" + (temporary.address() as AddressInfo).port;
  try {
    await page.goto(tempURL);
    await page.getByLabel("Your test instructions").fill("Open and verify initial task count");
    await clickGenerateDraft(page);
    await expect(page.locator("#generation-error")).toContainText("schema-validation", { timeout: 25000 });
    await expect(page.locator("#generation-error")).toContainText("steps[1]: expected object, received string");
    await expect(page.locator("#generation-error")).toContainText("Attempts: 2");
    expect(calls).toBe(2);
    await expect(page.locator("#draft")).toBeHidden();
  } finally {
    // Close the Playwright page's idle HTTP connections before awaiting shutdown.
    // Otherwise server.close can hang on CI and consume the entire test timeout.
    temporary.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      temporary.close((err) => err ? reject(err) : resolve()));
  }
});

test("Test 1 Groq upstream 400 is identified correctly in the generator UI without a real model call", async ({ page, browser }) => {
  const testOneInstructions = [
    '1. Open the task list application.',
    '2. Verify that the list initially contains zero tasks.',
    '3. Add a task called "Buy groceries".',
    '4. Verify that "Buy groceries" appears in the task list.',
    '5. Verify that the status reads "1 task, 0 completed".',
    '6. Mark "Buy groceries" as completed.',
    '7. Verify that the status reads "1 task, 1 completed".',
    '8. Delete "Buy groceries".',
    '9. Verify that the status reads "0 tasks, 0 completed".',
  ].join("\n");
  const stubProvider = async () => {
    throw new GroqProviderError(
      400, "json-generation", "json_validate_failed", "invalid_request_error",
      undefined, "Groq could not produce acceptable JSON.",
    );
  };
  const tempServer = await createReviewServer(outputDir, browser, stubProvider);
  await new Promise<void>((resolve) => tempServer.listen(0, "127.0.0.1", resolve));
  const tempURL = "http://127.0.0.1:" + (tempServer.address() as AddressInfo).port;
  try {
    await page.goto(tempURL);
    await page.getByLabel("Your test instructions").fill(testOneInstructions);
    await clickGenerateDraft(page);
    await expect(page.locator("#generation-error")).toContainText("GroqCloud rejected the request (provider HTTP 400)", { timeout: 15_000 });
    await expect(page.locator("#generation-error")).toContainText("json_validate_failed");
    await expect(page.locator("#generation-error")).toContainText("json-generation");
    await expect(page.locator("#generation-error")).toContainText(testOneInstructions.length + " characters");
    const providerResponse = await fetch(tempURL + "/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseURL: "http://127.0.0.1:3000",
        requirements: testOneInstructions,
        provider: "groq",
      }),
    });
    expect(providerResponse.status).toBe(502);
    expect(await providerResponse.json()).toMatchObject({
      source: "groqcloud",
      providerStatus: 400,
      category: "json-generation",
      providerCode: "json_validate_failed",
      requirementsCharacters: testOneInstructions.length,
    });
  } finally {
    // Close the Playwright page's idle HTTP connections before awaiting shutdown.
    // Otherwise server.close can hang on CI and consume the entire test timeout.
    tempServer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      tempServer.close((error) => error ? reject(error) : resolve()));
  }
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

test("requires a human test name and offers previous application URLs", async ({ page }) => {
  await generateFixture(page);
  const name = page.locator("#save-test-name");
  const save = page.getByRole("button", { name: "Save Test" });
  await name.fill("  ");
  await page.getByRole("button", { name: "Approve all steps", exact: true }).click();
  await expect(save).toBeDisabled();

  await name.fill("SD-001 — Explicit tester name");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.locator("#saved")).toContainText("Saved and ready to execute");
  const savedId = await page.locator("#execution-panel").getByLabel("Test", { exact: true }).inputValue();
  const saved = JSON.parse(await readFile(await approvedPath(outputDir, savedId), "utf8"));
  expect(saved.title).toBe("SD-001 — Explicit tester name");

  await page.locator("#stage-instructions").click();
  const previous = page.getByLabel("Choose a previously used website");
  await expect(previous.locator("option")).toContainText(["Choose a previous URL (optional)", "http://127.0.0.1:3000/"]);
  await page.locator("#base-url").fill("http://127.0.0.1:9999");
  await previous.selectOption("http://127.0.0.1:3000/");
  await expect(page.locator("#base-url")).toHaveValue("http://127.0.0.1:3000/");
});

test("saving a new website test switches Run Tests from the previous suite to its own URL", async ({ page }) => {
  // An existing locally saved test is selected before another website is used.
  await generateFixture(page);
  await page.getByRole("button", { name: "Approve all steps", exact: true }).click();
  await page.getByRole("button", { name: "Save Test" }).click();
  await expect(page.getByLabel("Test suite (website URL)"))
    .toHaveValue("http://127.0.0.1:3000");

  const ebay = "https://www.ebay.com/";
  const proposal = {
    schemaVersion: 1, id: "ebay-search", title: "Search products", version: 1,
    steps: [
      { id: "open", description: "Open eBay", action: { kind: "navigate", url: ebay } },
      { id: "search", description: "Enter Wooden Abacus", action: {
        kind: "fill", target: { by: "intent", value: "Search for anything", role: "textbox" },
        value: "Wooden Abacus",
      } },
      { id: "submit", description: "Submit search", action: {
        kind: "press", target: { by: "intent", value: "Search for anything", role: "textbox" },
        key: "Enter",
      } },
      { id: "verify", description: "Verify result text", action: {
        kind: "assert-visible", target: { by: "text", value: "Wooden Abacus" },
        provenance: "requirements",
      } },
    ],
  };
  // This is a selector-state regression test, not a live eBay or AI request.
  await page.route("**/api/generate", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({
      definition: proposal, provider: "groq", generationAttempts: 1,
      needsReview: true, memorySuggestions: [], message: "AI-generated draft.",
    }),
  }));
  await page.locator("#stage-instructions").click();
  await page.getByLabel("Application URL").fill(ebay);
  await page.getByLabel("Your test instructions").fill(
    "search for 'Wooden Abacus' and verify a result contains both words",
  );
  await page.locator("#test-name").fill("eBay search smoke");
  await page.getByLabel("Generate with").selectOption("groq");
  await clickGenerateDraft(page);
  await expect(page.locator("#generation-status")).toContainText("Draft ready");
  await page.getByRole("button", { name: "Approve all steps", exact: true }).click();
  await page.getByRole("button", { name: "Save Test" }).click();
  await expect(page.locator("#saved")).toContainText("Saved and ready to execute");

  const suite = page.getByLabel("Test suite (website URL)");
  const script = page.locator("#execution-panel").getByLabel("Test", { exact: true });
  await expect(suite).toHaveValue("https://www.ebay.com");
  await expect(script).not.toHaveValue("");
  await expect(page.getByLabel("Application URL")).toHaveValue(ebay);
  await expect(page.getByLabel("Execution URL")).toHaveValue(ebay);
  await expect(page.locator("#suite-site-note")).toContainText(
    "saved test scripts for https://www.ebay.com",
  );
  const savedId = await script.inputValue();
  const catalog = await (await page.request.get(url + "/api/tests")).json();
  expect(catalog.tests.find((item: { id: string }) => item.id === savedId))
    .toMatchObject({ sourceUrl: ebay, siteUrl: "https://www.ebay.com" });
});

test("save API rejects missing or whitespace-only tester names", async ({ page }) => {
  const definition = JSON.parse(await readFile("examples/add-task.json", "utf8"));
  for (const testName of [undefined, "  "]) {
    const response = await page.request.post(url + "/api/save", {
      data: { definition, baseURL: "http://127.0.0.1:3000", testName },
    });
    expect(response.status()).toBe(400);
    expect((await response.json()).error).toContain("Enter a test name");
  }
});

test("reviewer selects Contains and saved assertion preserves its explicit comparison mode", async ({ page }) => {
  await generateFixture(page);
  const assertion = page.locator("#step-list .step").nth(1);
  await assertion.getByRole("button", { name: "Edit fields" }).click();
  await assertion.getByLabel("Text comparison").selectOption("contains");
  await assertion.getByRole("button", { name: "Apply changes" }).click();
  for (const checkbox of await page.locator(".step input[type=checkbox]").all()) {
    await checkbox.check();
  }
  await page.getByRole("button", { name: "Save Test" }).click();
  await expect(page.locator("#saved")).toContainText("Saved and ready to execute");
  const id = await page.locator("#execution-panel").getByLabel("Test", { exact: true }).inputValue();
  const saved = JSON.parse(await readFile(await approvedPath(outputDir, id), "utf8"));
  expect(saved.steps[1].action.match).toBe("contains");
});

test("draft and live execution identify DOM-wide assertions without treating them as failures", async ({ page }) => {
  await generateFixture(page);
  await expect(page.locator("#draft-dom-wide-summary")).toBeVisible();
  await expect(page.locator("#draft-dom-wide-summary")).toContainText("4 DOM-wide assertions");
  await expect(page.locator("#draft-review-feedback")).toBeVisible();
  await expect(page.locator("#draft-review-advisories")).toContainText("Warnings — review against your test intent");
  await expect(page.locator("#draft-critical-blockers")).toBeHidden();
  await expect(page.locator("#step-list .step .pill.warn")).toHaveCount(4);
  await expect(page.locator("#step-list .step").first().locator(".pill.warn")).toHaveCount(0);
  await expect(page.locator("#step-list .step").nth(1).locator(".pill.warn")).toContainText("DOM-wide");
  await expect(page.locator("#step-list .step").nth(4).locator(".pill.warn")).toContainText("DOM-wide");

  await page.getByRole("button", { name: "Approve all steps", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save & Run" })).toBeEnabled();
  await page.getByRole("button", { name: "Save & Run" }).click();
  await expect(page.locator("#run-status")).toContainText("Run complete", { timeout: 30_000 });
  await expect(page.locator("#run-summary")).toContainText("PASSED");
  await expect(page.locator("#run-steps .pill.warn")).toHaveCount(4);
  await expect(page.locator("#run-steps .run-step").nth(1).locator(".pill.warn")).toContainText("DOM-wide");
  await expect(page.locator("#run-steps .run-step").first().locator(".pill.warn")).toHaveCount(0);
  const reportPath = await page.locator('#run-artifacts a').first().getAttribute("href");
  expect(reportPath).toMatch(/\/api\/runs\/.*\/report\.json$/);
  const report = await (await page.request.get(url + reportPath)).json();
  expect(report.steps.filter((step: {domWideAssertion?:boolean}) => step.domWideAssertion)).toHaveLength(4);
  expect(report.status).toBe("passed");
});

test("Save & Run persists once, focuses execution and reuses unchanged approved test", async ({ page }) => {
  await generateFixture(page);
  const before = (await (await page.request.get(url + "/api/tests")).json()).tests.length;
  await page.getByRole("button", {name:"Approve all steps",exact:true}).click();
  const save = page.getByRole("button",{name:"Save Test",exact:true});
  const saveAndRun = page.getByRole("button",{name:"Save & Run",exact:true});
  await expect(save).toBeEnabled();
  await expect(saveAndRun).toBeEnabled();
  await saveAndRun.click();
  await expect(page.locator("#run-status")).toContainText("Run complete",{timeout:30000});
  await expect(page.locator("#run-status")).toBeFocused();
  await expect(page.locator("#run-summary")).toContainText("PASSED");
  const first = (await (await page.request.get(url + "/api/tests")).json()).tests;
  expect(first).toHaveLength(before + 1);
  const firstId = await page.locator("#approved-tests").inputValue();
  expect(firstId).toMatch(/^reviewed-/);
  await page.locator("#stage-draft").click();
  await expect(saveAndRun).toBeVisible();
  await expect(saveAndRun).toBeEnabled();
  await saveAndRun.click();
  await expect(page.locator("#run-status")).toContainText("Run complete",{timeout:30000});
  const second = (await (await page.request.get(url + "/api/tests")).json()).tests;
  expect(second).toHaveLength(first.length);
  expect(await page.locator("#approved-tests").inputValue()).toBe(firstId);
  await page.locator("#stage-draft").click();
  await expect(page.locator("#saved")).toContainText("previously saved approved test");
});

test("Save & Run is disabled for unreviewed drafts and does not run after a save failure", async ({page}) => {
  await generateFixture(page);
  await expect(page.locator("#save-and-run")).toBeDisabled();
  await page.getByRole("button",{name:"Approve all steps",exact:true}).click();
  await expect(page.locator("#save-and-run")).toBeEnabled();
  let runs = 0;
  await page.route("**/api/run",route => {runs++;return route.abort();});
  await page.route("**/api/save",route => route.fulfill({
    status:409,contentType:"application/json",
    body:JSON.stringify({error:"Duplicate test name — please choose another"}),
  }));
  await page.locator("#save-and-run").click();
  await expect(page.locator("#save-error")).toContainText("Duplicate test name");
  expect(runs).toBe(0);
  await expect(page.locator("#run-status")).toContainText("Select an approved test to execute");
});

test("Save Draft is discoverable in the Existing Tests picker",async({page})=>{
  await generateFixture(page);
  const beforeDraftCount = (await (await page.request.get(url + "/api/drafts")).json()).drafts.length;
  await page.locator("#step-list .step").first().locator('input[type="checkbox"]').check();
  await page.getByRole("button",{name:"Save Draft",exact:true}).click();
  await expect(page.locator("#draft-save-status")).toContainText("Available in Existing Tests");
  await page.locator("#nav-existing").click();
  const records = (await (await page.request.get(url + "/api/drafts")).json()).drafts;
  expect(records).toHaveLength(beforeDraftCount + 1);
  const id = records.find((item: {title:string}) => item.title === fixtureName())?.id;
  await expect(page.locator('#catalog-rows tr[data-record-id="' + id + '"]').getByRole("button",{name:/^Resume /})).toBeEnabled();
  expect(id).toMatch(/^draft-[a-f0-9-]{36}[.]json$/);
  const stored = JSON.parse(await readFile(join(outputDir,"drafts",id),"utf8"));
  expect(stored.definition.title).toBe(fixtureName());
  await expect(page.locator("#draft-save-status")).toContainText("saved and verified");
  await expect(page.locator("#edit-suite")).toHaveValue("");
  await expect(page.locator("#edit-script")).toHaveValue("");
  await expect(page.locator("#edit-script option[value='" + id + "']")).toContainText("[Draft — not runnable]");
  // Saving a working draft must not accidentally approve or run it.
  await expect(page.locator("#save-and-run")).toBeDisabled();

  // Re-open the full page: the existing-tests list must discover this draft
  // from disk, not a stateful client cache or success toast.
  await page.reload();
  await page.getByRole("button", {name: "Edit existing test or resume draft"}).click();
  await expect(page.locator("#review-workspace")).toBeVisible();
  await page.locator('#catalog-status input[value="draft"]').check();
  await expect(page.locator("#catalog-rows tr")).toHaveCount(beforeDraftCount + 1);
  await page.locator("#edit-suite").selectOption("http://127.0.0.1:3000");
  await page.locator("#edit-script").selectOption(id);
  const resume = page.locator('#catalog-rows tr[data-record-id="' + id + '"]').getByRole("button",{name:/^Resume /});
  await expect(resume).toBeEnabled();
  await resume.click();
  await expect(page.locator("#review-progress")).toContainText("1 of 9 steps confirmed");
  await expect(page.locator("#run-test")).toBeDisabled();
});

test("working draft preserves partial approvals and original instructions without becoming runnable", async ({ page }) => {
  await generateFixture(page);
  const approvedBeforeDraft = (await (await page.request.get(url + "/api/tests")).json()).tests.length;
  const beforeDraftCount = (await (await page.request.get(url + "/api/drafts")).json()).drafts.length;
  const original = await page.getByLabel("Your test instructions").inputValue();
  const steps = page.locator("#step-list .step");
  await steps.nth(0).locator('input[type="checkbox"]').check();
  await steps.nth(1).locator('input[type="checkbox"]').check();
  await page.getByRole("button", { name: "Save Draft" }).click();
  await expect(page.locator("#draft-save-status")).toContainText("2/9 approved");
  const list = await page.request.get(url + "/api/drafts");
  const drafts = (await list.json()).drafts;
  expect(drafts).toHaveLength(beforeDraftCount + 1);
  const selectedDraftId = drafts.find((item: {title:string}) => item.title === fixtureName())?.id;
  expect(drafts.some((draft: {id:string}) => draft.id === selectedDraftId)).toBe(true);
  const saved = await (await page.request.get(url + "/api/drafts/" + selectedDraftId)).json();
  expect(saved.draft.sourceInstructions).toBe(original);
  expect(saved.draft.approvedStepIds).toEqual(["open", "empty"]);
  expect((await (await page.request.get(url + "/api/tests")).json()).tests).toHaveLength(approvedBeforeDraft);

  await page.getByRole("button", { name: "Choose another test" }).click();
  page.once("dialog", dialog => dialog.accept());
  await page.locator('#catalog-rows tr[data-record-id="' + selectedDraftId + '"]').getByRole("button",{name:/^Resume /}).click();
  await expect(page.locator("#review-progress")).toContainText("2 of 9 steps confirmed");
  await expect(page.locator("#original-instructions")).toHaveText(original);
  await expect(page.locator("#requirements")).toHaveValue(original);
  await expect(page.locator("#test-name")).toHaveValue(fixtureName());
});

test("approved test retains source instructions and Save as New keeps original", async ({ page }) => {
  await generateFixture(page);
  const instructions = await page.getByLabel("Your test instructions").inputValue();
  await page.getByRole("button", { name: "Approve all steps", exact: true }).click();
  await page.getByRole("button", { name: "Save Test" }).click();
  await expect(page.locator("#saved")).toContainText("Saved and ready to execute");
  const before = await (await page.request.get(url + "/api/tests")).json();
  const originalId = await page.locator("#execution-panel").getByLabel("Test", { exact: true }).inputValue();
  expect(before.tests.some((test: { id: string }) => test.id === originalId)).toBe(true);
  const saved = await (await page.request.get(url + "/api/tests/" + originalId)).json();
  expect(saved.definition.sourceInstructions).toBe(instructions);
  expect(saved.definition.workingInstructions).toBe(instructions);

  await page.getByRole("button", { name: "Choose another test" }).click();
  await page.getByLabel("Test suite", { exact: true }).selectOption("http://127.0.0.1:3000");
  await page.locator("#review-workspace").getByLabel("Test", { exact: true }).selectOption(originalId);
  page.once("dialog", dialog => dialog.accept());
  await page.locator('#catalog-rows tr[data-record-id="' + originalId + '"]').getByRole("button",{name:/^Edit /}).click();
  await expect(page.locator("#requirements")).toHaveValue(instructions);
  await expect(page.locator("#original-instructions")).toHaveText(instructions);
  await page.locator("#stage-instructions").click();
  await page.getByLabel("Your test instructions").fill(instructions + "\\nAdditional notes for new version.");
  await page.locator("#test-name").fill("Alternative test copy");
  await page.locator("#stage-draft").click();
  await page.getByRole("button", { name: "Approve all steps", exact: true }).click();
  await page.getByRole("button", { name: "Save as new test" }).click();
  await expect(page.locator("#saved")).toContainText("Saved and ready to execute");
  const after = await (await page.request.get(url + "/api/tests")).json();
  expect(after.tests).toHaveLength(before.tests.length + 1);
  expect(after.tests.map((test: {id: string}) => test.id)).toContain(originalId);
  const beforeIds = new Set(before.tests.map((test: { id: string }) => test.id));
  const newer = after.tests.find((test: { id: string }) => !beforeIds.has(test.id));
  expect(newer).toBeDefined();
  const copy = await (await page.request.get(url + "/api/tests/" + newer.id)).json();
  expect(copy.definition.title).toBe("Alternative test copy");
  expect(copy.definition.sourceInstructions).toBe(instructions);
  expect(copy.definition.workingInstructions).toContain("Additional notes for new version.");
});

test("approval and save readiness require a test name before generation and confirmations before save", async ({ page }) => {
  await page.goto(url);
  await page.getByLabel("Your test instructions").fill("Add a task and verify it is listed");
  await page.getByLabel("Generate with").selectOption("fixture");
  await expect(page.getByRole("button", { name: "Generate draft" })).toBeDisabled();
  await page.locator("#test-name").fill("Approval regression check");
  await expect(page.getByRole("button", { name: "Generate draft" })).toBeEnabled();
  await clickGenerateDraft(page);
  await expect(page.locator("#generation-status")).toContainText("Draft ready");
  const save = page.getByRole("button", { name: "Save Test" });
  await expect(save).toBeDisabled();
  await expect(page.locator("#save-readiness")).toContainText("Confirm 9 remaining steps");
  await page.getByRole("button", { name: "Approve all steps", exact: true }).click();
  await expect(page.locator("#save-readiness")).toContainText("Ready to save");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.locator("#saved")).toContainText("Saved and ready to execute");
});

test("name entered before generation survives and save-area name enables approval and JSON save", async ({ page }) => {
  await page.goto(url);
  const originalName = page.locator("#test-name").first();
  await originalName.fill("Name supplied before generation");
  await page.getByLabel("Your test instructions").fill("Add a task, then verify it is visible");
  await page.getByLabel("Generate with").selectOption("fixture");
  await clickGenerateDraft(page);
  await expect(page.locator("#generation-status")).toContainText("Draft ready");
  await expect(originalName).toHaveValue("Name supplied before generation");
  const saveName = page.locator("#save-test-name");
  await expect(saveName).toHaveValue("Name supplied before generation");
  await page.getByRole("button", { name: "Approve all steps", exact: true }).click();
  const save = page.getByRole("button", { name: "Save Test" });
  await expect(save).toBeEnabled();
  await saveName.fill("Name edited next to save");
  await expect(originalName).toHaveValue("Name edited next to save");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.locator("#saved")).toContainText("Saved and ready to execute");
});

test("all required inputs gate Generate Draft and update readiness before save @sanity", async ({ page }) => {
  await page.goto(url);
  const generate = page.getByRole("button", { name: "Generate draft" });
  await expect(page.locator("#test-name")).toHaveAttribute("required", "");
  await expect(page.getByLabel("Application URL")).toHaveAttribute("required", "");
  await expect(page.locator("#requirements")).toHaveAttribute("required", "");
  await expect(generate).toBeDisabled();
  await expect(page.locator("#generate-readiness")).toContainText("Test name");
  await expect(page.locator("#generate-readiness")).toContainText("test instructions");
  await expect(page.locator("#test-name")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#requirements")).toHaveAttribute("aria-invalid", "true");
  await page.getByLabel("Your test instructions").fill("Add a task and verify it appears");
  await expect(generate).toBeDisabled();
  await page.locator("#test-name").fill("Task flow");
  await expect(page.locator("#generate-readiness")).toContainText("All required fields complete");
  await expect(generate).toBeEnabled();
  await page.getByLabel("Application URL").fill("not a valid URL");
  await expect(generate).toBeDisabled();
  await expect(page.locator("#base-url")).toHaveAttribute("aria-invalid", "true");
  await page.getByLabel("Application URL").fill("http://127.0.0.1:3000");
  await expect(generate).toBeEnabled();
  await page.getByLabel("Generate with").selectOption("fixture");
  await clickGenerateDraft(page);
  await expect(page.locator("#generation-status")).toContainText("Draft ready");
  await expect(page.locator("#save-readiness")).toContainText("Confirm 9 remaining steps");
  await page.locator("#save-test-name").fill("Task flow revised");
  await expect(page.locator("#save-readiness")).toContainText("Confirm 9 remaining steps");
  await page.getByRole("button", { name: "Approve all steps", exact: true }).click();
  await expect(page.locator("#save-readiness")).toContainText("Ready to save");
  await expect(page.getByRole("button", { name: "Save Test" })).toBeEnabled();
});

test("new test name entered before generation survives and permits saving and execution", async ({ page }) => {
  await page.goto(url);
  const name = page.locator("#test-name");
  await name.fill("New test from instructions");
  await page.getByLabel("Your test instructions").fill(
    "Open the task page. Check that the initial status contains zero tasks.",
  );
  await page.getByLabel("Generate with").selectOption("fixture");
  await clickGenerateDraft(page);
  await expect(page.locator("#generation-status")).toContainText("Draft ready");
  await expect(name).toHaveValue("New test from instructions");
  const save = page.getByRole("button", { name: "Save Test" });
  await expect(save).toBeDisabled();
  await expect(page.locator("#save-readiness")).toContainText("Confirm 9 remaining steps");
  await page.getByRole("button", { name: "Approve all steps", exact: true }).click();
  await expect(save).toBeEnabled();
  await expect(page.locator("#save-readiness")).toContainText("Ready to save");
  await save.click();
  await expect(page.locator("#saved")).toContainText("Saved and ready to execute");
  const script = page.locator("#execution-panel").getByLabel("Test", { exact: true });
  await page.locator("#nav-run").click();
  await expect(script).not.toHaveValue("");
  await expect(page.getByRole("button", { name: "Run selected test" })).toBeEnabled();
  const id = await script.inputValue();
  const persisted = JSON.parse(await readFile(await approvedPath(outputDir, id), "utf8"));
  expect(persisted.title).toBe("New test from instructions");
  expect(persisted.sourceInstructions).toContain("initial status");
});

test("failed regeneration removes prior successful draft and disables saving stale steps", async ({ page }) => {
  await generateFixture(page);
  await page.getByRole("button", { name: "Approve all steps", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save Test" })).toBeEnabled();
  await expect(page.locator("#step-list .step")).toHaveCount(9);

  await page.route("**/api/generate", async (route) => {
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({
        source: "groqcloud", category: "timeout",
        error: "GroqCloud did not respond within 90 seconds.",
      }),
    });
  });
  await page.locator("#stage-instructions").click();
  await page.getByLabel("Your test instructions").fill("Add several items to basket.");
  await clickGenerateDraft(page);

  await expect(page.locator("#generation-error")).toContainText("GroqCloud request failed (timeout)");
  await expect(page.locator("#generation-review-status")).toContainText(
    "Generation failed. No draft steps are available from this attempt.");
  await expect(page.locator("#draft")).toBeHidden();
  await expect(page.locator("#step-list .step")).toHaveCount(0);
  await expect(page.locator("#save")).toBeDisabled();
  await expect(page.locator("#save-draft")).toBeDisabled();
  await expect(page.locator("#generation-status")).toBeEmpty();
  // The tester's latest instructions remain available to correct and retry.
  await expect(page.getByLabel("Your test instructions")).toHaveValue("Add several items to basket.");
  await page.unroute("**/api/generate");

  await page.getByLabel("Generate with").selectOption("fixture");
  await clickGenerateDraft(page);
  await expect(page.locator("#step-list .step")).toHaveCount(9);
  await expect(page.locator("#generation-error")).toBeEmpty();
  await expect(page.locator("#generation-review-status")).toBeEmpty();
});

test("invalid instructions disable generation without destroying the previously reviewed draft", async ({ page }) => {
  await generateFixture(page);
  await expect(page.locator("#step-list .step")).toHaveCount(9);
  await page.locator("#stage-instructions").click();
  await page.getByLabel("Your test instructions").fill("");
  await expect(page.getByRole("button", { name: "Generate draft" })).toBeDisabled();
  await expect(page.locator("#generate-readiness")).toContainText("test instructions");
  await page.locator("#stage-draft").click();
  await expect(page.locator("#draft")).toBeVisible();
  await expect(page.locator("#step-list .step")).toHaveCount(9);
});

test("URL input and recent website selector visually indicate only one active source", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ai-ui-testing-agent.recent-application-urls", JSON.stringify([
      "https://www.saucedemo.com/",
      "https://example.test/catalog",
    ]));
  });
  await page.goto(url);

  const field = page.locator("#base-url");
  const recent = page.locator("#recent-url");
  await expect(field).not.toHaveClass(/url-source-inactive/);
  await expect(recent).toHaveClass(/url-source-inactive/);
  await expect(page.locator("#url-source-status")).toContainText("Using the URL entered above");

  await recent.selectOption("https://www.saucedemo.com/");
  await expect(field).toHaveValue("https://www.saucedemo.com/");
  await expect(field).toHaveClass(/url-source-inactive/);
  await expect(recent).not.toHaveClass(/url-source-inactive/);
  await expect(page.locator("#url-source-status")).toContainText("Using the selected recent website");

  // The muted field must still be clickable, allowing a new URL without
  // needing to find a separate reset button.
  await field.click();
  await field.fill("https://another.example.test/app");
  await expect(recent).toHaveValue("");
  await expect(field).not.toHaveClass(/url-source-inactive/);
  await expect(recent).toHaveClass(/url-source-inactive/);
  await expect(page.locator("#url-source-status")).toContainText("Using the URL entered above");

  // Users can always switch back to recent URLs.
  await recent.selectOption("https://example.test/catalog");
  await expect(field).toHaveValue("https://example.test/catalog");
  await expect(field).toHaveClass(/url-source-inactive/);
  await expect(recent).not.toHaveClass(/url-source-inactive/);
  await recent.selectOption("");
  await expect(field).not.toHaveClass(/url-source-inactive/);
  await expect(recent).toHaveClass(/url-source-inactive/);
});


test("failed radio selection can open direct step editor and change action without AI @sanity", async ({page}) => {
  const site = createServer((_req,res)=>{
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
    res.end('<!doctype html><label><input id="choice" type="radio" name="choice" value="yes">Yes</label><p>Form ready</p>');
  });
  await new Promise<void>(resolve=>site.listen(0,"127.0.0.1",resolve));
  const baseURL="http://127.0.0.1:"+(site.address() as AddressInfo).port;
  try {
    const definition={schemaVersion:1,id:"radio-action-repair",title:"Radio action repair",version:1,
      sourceInstructions:"Select Yes and verify that Yes is selected.",
      steps:[
        {id:"open",description:"Open form",action:{kind:"navigate",url:"/"}},
        {id:"choose",description:"Select Yes",action:{kind:"select-option",target:{by:"id",value:"choice"},value:"yes"}},
        {id:"verify",description:"Verify Yes selected",action:{kind:"assert-visible",target:{by:"css",value:"#choice:checked"},provenance:"requirements"}},
      ]};
    const response=await page.request.post(url+"/api/save",{data:{testName:fixtureName(),definition,baseURL}});
    expect(response.status()).toBe(200);
    const saved=await response.json();
    await page.goto(url);
    await page.locator("#nav-run").click();
    await page.getByLabel("Test suite (website URL)").selectOption(baseURL);
    await page.getByLabel("Execution URL").fill(baseURL);
    await selectSavedScript(page,saved.id);
    await page.getByRole("button",{name:"Run selected test"}).click();
    await expect(page.locator("#run-status")).toContainText("Run complete",{timeout:30000});
    await expect(page.locator("#run-summary")).toContainText("FAILED");
    const failed=page.locator("#run-steps .run-step").nth(1);
    await expect(failed).toHaveAttribute("data-status","execution-error");
    await expect(failed).toContainText("not a <select> element");
    await failed.getByRole("button",{name:"Edit failing step",exact:true}).click();
    const editor=page.locator("#step-list .step").nth(1);
    await expect(editor.getByLabel("Action type")).toHaveValue("select-option");
    await editor.getByLabel("Action type").selectOption("check");
    await expect(editor.getByLabel("HTML ID attribute value")).toHaveValue("choice");
    await expect(editor.getByLabel("Option value")).toHaveCount(0);
    await editor.getByRole("button",{name:"Apply changes"}).click();
    await expect(editor.locator('input[type="checkbox"]')).not.toBeChecked();
    const original=await (await page.request.get(url+"/api/tests/"+encodeURIComponent(saved.id))).json();
    expect(original.definition.steps).toEqual(definition.steps);
    for(const box of await page.locator("#step-list .step input[type=checkbox]").all()) await box.check();
    await page.getByRole("button",{name:"Save Test",exact:true}).click();
    await expect(page.locator("#saved")).toContainText("Amended test saved; old version removed from the list. Ready to execute.");
    const amendedId=await page.locator("#approved-tests").inputValue();
    const amended=JSON.parse(await readFile(await approvedPath(outputDir,amendedId),"utf8"));
    expect(amended.steps[1].action).toEqual({kind:"check",target:{by:"id",value:"choice"}});
    expect(amended.steps[0]).toEqual(definition.steps[0]);
    expect(amended.steps[2]).toEqual(definition.steps[2]);
    expect(amended.sourceInstructions).toBe(definition.sourceInstructions);
    await page.locator("#nav-run").click();
    await expect(page.locator("#approved-tests")).toHaveValue(amendedId);
    await page.getByRole("button",{name:"Run selected test"}).click();
    await expect(page.locator("#run-status")).toContainText("Run complete",{timeout:30000});
    await expect(page.locator("#run-summary")).toContainText("PASSED");
  } finally {
    site.closeAllConnections();
    await new Promise<void>((resolve,reject)=>site.close(error=>error?reject(error):resolve()));
  }
});


for (const scenario of ["fill", "assert-url"] as const) {
  test("direct failed step editor supports " + scenario + " recovery without suggestions @sanity", async ({page}) => {
    const site = createServer((_req,res)=>{
      res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
      res.end('<!doctype html><button id="go" onclick="this.textContent=\'Done\'">Go</button><p id="ready">Ready</p>');
    });
    await new Promise<void>(resolve=>site.listen(0,"127.0.0.1",resolve));
    const baseURL="http://127.0.0.1:"+(site.address() as AddressInfo).port;
    try {
      const target={by:"id",value:"go"};
      const definition={schemaVersion:1,id:"direct-"+scenario,title:"Direct "+scenario,version:1,
        sourceInstructions:scenario==="fill"?"Click Go and verify Done.":"Verify Ready is visible.",
        steps:[
          {id:"open",description:"Open form",action:{kind:"navigate",url:"/"}},
          {id:"failed",description:"Perform requested step",action:scenario==="fill"
            ? {kind:"fill",target,value:"Go"}
            : {kind:"assert-url",expected:"/missing",provenance:"requirements"}},
          {id:"verify",description:"Verify result",action:{kind:"assert-visible",
            target:{by:"text",value:scenario==="fill"?"Done":"Ready"},provenance:"requirements"}},
        ]};
      const response=await page.request.post(url+"/api/save",{data:{testName:fixtureName(),definition,baseURL}});
      expect(response.status()).toBe(200);
      const saved=await response.json();
      await page.goto(url);
      await page.locator("#nav-run").click();
      await page.getByLabel("Test suite (website URL)").selectOption(baseURL);
      await page.getByLabel("Execution URL").fill(baseURL);
      await selectSavedScript(page,saved.id);
      await page.getByRole("button",{name:"Run selected test"}).click();
      await expect(page.locator("#run-status")).toContainText("Run complete",{timeout:30000});
      await expect(page.locator("#run-summary")).toContainText("FAILED");
      const failed=page.locator("#run-steps .run-step").nth(1);
      await expect(failed).toHaveAttribute("data-status",scenario==="fill"?"execution-error":"assertion-failed");
      await failed.getByRole("button",{name:"Edit failing step",exact:true}).click();
      const editor=page.locator("#step-list .step").nth(1);
      await expect(editor.getByLabel("Action type")).toHaveValue(scenario);
      if(scenario==="fill"){
        await editor.getByLabel("Action type").selectOption("click");
        await expect(editor.getByLabel("HTML ID attribute value")).toHaveValue("go");
        await expect(editor.getByLabel("Value to enter")).toHaveCount(0);
      }else{
        await editor.getByLabel("Action type").selectOption("assert-visible");
        await editor.getByLabel("Locator strategy").selectOption("id");
        await editor.getByLabel("HTML ID attribute value").fill("ready");
        page.once("dialog",dialog=>dialog.dismiss());
        await editor.getByRole("button",{name:"Apply changes"}).click();
        await expect(editor.getByLabel("Action type")).toBeVisible();
        page.once("dialog",dialog=>dialog.accept());
      }
      await editor.getByRole("button",{name:"Apply changes"}).click();
      await expect(editor.locator('input[type="checkbox"]')).not.toBeChecked();
      for(const box of await page.locator("#step-list .step input[type=checkbox]").all()) await box.check();
      await page.getByRole("button",{name:"Save Test",exact:true}).click();
      await expect(page.locator("#saved")).toContainText("Amended test saved; old version removed from the list. Ready to execute.");
      const amendedId=await page.locator("#approved-tests").inputValue();
      const amended=JSON.parse(await readFile(await approvedPath(outputDir,amendedId),"utf8"));
      expect(amended.steps[1].action).toEqual(scenario==="fill"
        ? {kind:"click",target}
        : {kind:"assert-visible",target:{by:"id",value:"ready"},provenance:"human-confirmed"});
      expect(amended.steps[0]).toEqual(definition.steps[0]);
      expect(amended.steps[2]).toEqual(definition.steps[2]);
      expect(amended.sourceInstructions).toBe(definition.sourceInstructions);
      await page.locator("#nav-run").click();
      await expect(page.locator("#approved-tests")).toHaveValue(amendedId);
      await page.getByRole("button",{name:"Run selected test"}).click();
      await expect(page.locator("#run-status")).toContainText("Run complete",{timeout:30000});
      await expect(page.locator("#run-summary")).toContainText("PASSED");
    } finally {
      site.closeAllConnections();
      await new Promise<void>((resolve,reject)=>site.close(error=>error?reject(error):resolve()));
    }
  });
}


test("element search API retrieves only the selected failed run step evidence @sanity", async ({page}) => {
  const site=createServer((_req,res)=>{
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
    res.end('<!doctype html><label for="choice">Default radio</label><input id="choice" type="radio"><p>Form ready</p>');
  });
  await new Promise<void>(resolve=>site.listen(0,"127.0.0.1",resolve));
  const baseURL="http://127.0.0.1:"+(site.address() as AddressInfo).port;
  try {
    const definition={schemaVersion:1,id:"element-api",title:"Element API",version:1,steps:[
      {id:"open",description:"Open",action:{kind:"navigate",url:"/"}},
      {id:"choose",description:"Choose default radio",action:{kind:"select-option",target:{by:"id",value:"choice"},value:"yes"}},
      {id:"verify",description:"Verify",action:{kind:"assert-visible",target:{by:"text",value:"Form ready"},provenance:"requirements"}}
    ]};
    const response=await page.request.post(url+"/api/save",{data:{testName:fixtureName(),definition,baseURL}});
    expect(response.status()).toBe(200);
    const saved=await response.json();
    await page.goto(url);
    await page.locator("#nav-run").click();
    await page.getByLabel("Test suite (website URL)").selectOption(baseURL);
    await page.getByLabel("Execution URL").fill(baseURL);
    await selectSavedScript(page,saved.id);
    await page.getByRole("button",{name:"Run selected test"}).click();
    await expect(page.locator("#run-status")).toContainText("Run complete",{timeout:30000});
    const reportLink=await page.getByRole("link",{name:"View full JSON report"}).getAttribute("href");
    const runId=reportLink!.split("/")[3];
    const request={runId,stepId:"choose",query:"radio"};
    const search=await page.request.post(url+"/api/search-elements",{data:request});
    expect(search.status()).toBe(200);
    const result=await search.json();
    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({target:{by:"id",value:"choice"},actions:expect.arrayContaining(["check"])})
    ]));
    for(const invalid of [{stepId:"open"},{stepId:"verify"},{runId:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"},{query:" "},{query:"a".repeat(181)}]){
      const rejected=await page.request.post(url+"/api/search-elements",{data:{...request,...invalid}});
      expect(rejected.status()).toBe(400);
    }
    const report=await (await page.request.get(url+reportLink)).json();
    expect(report.steps.find((step:{id:string})=>step.id==="choose")).toMatchObject({elementSearchAvailable:true,status:"execution-error"});
    expect(JSON.stringify(report)).not.toContain('"actions":["assert-visible"');
  }finally{
    site.closeAllConnections();
    await new Promise<void>((resolve,reject)=>site.close(error=>error?reject(error):resolve()));
  }
});
