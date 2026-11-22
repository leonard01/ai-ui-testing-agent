import { test, expect } from "@playwright/test";
import { createReviewServer } from "../src/review-server.js";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

test.use({ trace: "off" });
const baseURL = "http://127.0.0.1:3000/";
const newStatus = {
  id: "new-status", description: "Verify initial count includes zero",
  action: {
    kind: "assert-text", target: { by: "role", role: "status" },
    expected: "0 tasks", match: "contains", provenance: "requirements",
  },
};
const remainder = [
  { id: "new-fill", description: "Enter a new task", action: {
    kind: "fill", target: { by: "label", value: "Task" }, value: "Buy groceries",
  } },
  { id: "new-add", description: "Add the task", action: {
    kind: "click", target: { by: "role", role: "button", name: "Add" },
  } },
  { id: "new-check", description: "Verify task appears", action: {
    kind: "assert-visible", target: { by: "text", value: "Buy groceries" },
    provenance: "requirements",
  } },
];

let server: Server;
let dir: string;
let url: string;
let mockSteps: unknown[] = [];
let mockCalls = 0;
let prompts: string[] = [];

test.beforeEach(async ({ browser }) => {
  dir = await mkdtemp(join(tmpdir(), "incremental-regeneration-"));
  mockCalls = 0;
  prompts = [];
  mockSteps = [newStatus];
  const mock = async ({ prompt }: { prompt: string }) => {
    mockCalls++;
    prompts.push(prompt);
    return JSON.stringify({ steps: mockSteps });
  };
  server = await createReviewServer(dir, browser, mock);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  url = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});
test.afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

async function original() {
  return JSON.parse(await readFile("examples/add-task.json", "utf8"));
}
async function regenerate(data: Record<string, unknown>) {
  return fetch(url + "/api/regenerate-steps", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      definition: await original(), baseURL,
      stepId: "empty", mode: "step",
      instructions: "Verify count contains zero",
      approvedStepIds: ["open", "empty", "enter"],
      provider: "groq", ...data,
    }),
  });
}

test("single-step proposal preserves unaffected steps and confirmed approvals", async () => {
  const response = await regenerate({});
  expect(response.status).toBe(200);
  const data = await response.json();
  const fixture = await original();
  expect(data.needsReview).toBe(true);
  expect(mockCalls).toBe(1);
  expect(data.removed.map((step: {id:string})=>step.id)).toEqual(["empty"]);
  expect(data.replacement).toHaveLength(1);
  expect(data.replacement[0].id).not.toBe(newStatus.id);
  expect(data.replacement[0].action.match).toBe("contains");
  expect(data.definition.steps[0]).toEqual(fixture.steps[0]);
  expect(data.definition.steps.slice(2)).toEqual(fixture.steps.slice(2));
  expect(data.preservedApprovedStepIds).toEqual(["open", "enter"]);
  expect(prompts[0]).toContain("PRESERVED PRECEDING STEPS");
  expect(prompts[0]).toContain("Replace exactly ONE step");
  expect((await (await fetch(url + "/api/tests")).json()).tests).toHaveLength(0);
});

test("suffix proposal preserves prefix and strips requirement links to removed IDs", async () => {
  mockSteps = remainder;
  const def = await original();
  def.requirements = [{
    id: "R-1", text: "Add a task", stepIds: ["empty", "enter", "visible"],
  }];
  const response = await regenerate({
    definition: def, stepId: "enter", mode: "from",
    approvedStepIds: ["open", "empty", "enter", "visible"],
    instructions: "Add Buy groceries and verify it appears",
  });
  expect(response.status).toBe(200);
  const data = await response.json();
  expect(data.definition.steps).toHaveLength(5);
  expect(data.definition.steps.slice(0, 2)).toEqual(def.steps.slice(0, 2));
  expect(data.definition.requirements[0].stepIds).toEqual(["empty"]);
  expect(data.preservedApprovedStepIds).toEqual(["open", "empty"]);
  expect(data.warnings.join(" ")).toContain("Requirement links");
  expect(data.definition.steps.slice(2).every((step:{id:string}) => step.id.startsWith("regen-"))).toBe(true);
});

test("unsafe and malformed proposals cannot alter or approve a test", async () => {
  const bad = await regenerate({ stepId: "not-a-step" });
  expect(bad.status).toBe(422);
  expect((await bad.json()).error).toContain("not in the test");
  expect(mockCalls).toBe(0);
  mockSteps = [{ ...newStatus, action: { ...newStatus.action, provenance: "human-confirmed" } }];
  const forged = await regenerate({});
  expect(forged.status).toBe(422);
  expect((await forged.json()).error).toContain("human-confirmed");
  expect((await (await fetch(url + "/api/drafts")).json()).drafts).toHaveLength(0);
});

test("UI proposes suffix replacement, requires Apply and leaves replacement steps unapproved", async ({page}) => {
  mockSteps = remainder;
  await page.goto(url);
  await page.getByLabel("Your test instructions").fill("Add and verify a task");
  await page.getByLabel("Generate with").selectOption("fixture");
  await page.getByRole("button", { name: "Generate draft" }).click();
  await expect(page.locator("#step-list .step")).toHaveCount(9);
  await page.locator("#test-name").fill("Incremental task test");
  await page.locator("#step-list .step").nth(0).locator('input[type=checkbox]').check();
  await page.locator("#step-list .step").nth(1).locator('input[type=checkbox]').check();
  await page.getByLabel("Generate with").selectOption("groq");
  await page.locator("#step-list .step").nth(2).getByRole("button", {name:"Reinterpret with AI"}).click();
  await page.getByLabel("Scope of changes").selectOption("from");
  await page.getByLabel("New plain-English instructions for replacement steps").fill(
    "Add a task named Buy groceries and verify it is present"
  );
  await page.getByRole("button", { name: "Generate replacement" }).click();
  await expect(page.locator("#incremental-status")).toContainText("Proposal ready");
  await expect(page.locator("#step-list .step")).toHaveCount(9);
  await expect(page.locator("#review-progress")).toContainText("2 of 9");
  await page.getByRole("button", { name: "Apply proposed steps (unapproved)" }).click();
  await expect(page.locator("#step-list .step")).toHaveCount(5);
  await expect(page.locator("#review-progress")).toContainText("2 of 5");
  await expect(page.locator("#requirements")).toHaveValue(/Incremental amendment/);
  await page.getByRole("button", { name: "Save Working Draft" }).click();
  await expect(page.locator("#draft-save-status")).toContainText("2/5 approved");
  expect((await (await fetch(url + "/api/tests")).json()).tests).toHaveLength(0);
});

test("Groq intermittent JSON-mode failure is retried once without changing saved tests", async ({ page }) => {
  // The test server's mock provider cannot throw a GroqProviderError, so this
  // scenario is exercised at the module boundary with an injected provider.
  const { generateIncrementalProposal } = await import("../src/incremental-generation.js");
  const { GroqProviderError } = await import("../src/hosted-providers.js");
  let calls = 0;
  const provider = async () => {
    calls++;
    if (calls === 1) {
      throw new GroqProviderError(400, "json-generation", "json_validate_failed",
        "invalid_request_error", undefined, "Retry structured generation.");
    }
    return JSON.stringify({ steps: [newStatus] });
  };
  const proposal = await generateIncrementalProposal({
    definition: await original(),
    baseURL, stepId: "empty", mode: "step",
    instructions: "Verify that zero tasks are shown",
    approvedStepIds: ["open", "empty"], model: "test-model",
    retryMalformedOutput: true,
  }, provider, page.context().browser() ?? undefined);
  expect(calls).toBe(2);
  expect(proposal.generationAttempts).toBe(2);
  expect(proposal.preservedApprovedStepIds).toEqual(["open"]);
  expect((await (await fetch(url + "/api/tests")).json()).tests).toHaveLength(0);
});
