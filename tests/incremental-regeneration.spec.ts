import { test, expect } from "@playwright/test";

// Legacy recovery tests explicitly opt in; every other case exercises JSON-only.
let previousResponsePolicy: string | undefined;
test.beforeEach(async ({}, info) => {
  previousResponsePolicy = process.env.GROQ_RESPONSE_POLICY;
  const legacy = ["failed initial generation displays both","automatic capture retains","Groq intermittent JSON-mode failure","malformed click action","single-step mode rejects multiple","invalid reconciliation availability reports"].some(prefix => info.title.startsWith(prefix));
  process.env.GROQ_RESPONSE_POLICY = legacy ? "hybrid" : "json";
});
test.afterEach(() => {
  if (previousResponsePolicy === undefined) delete process.env.GROQ_RESPONSE_POLICY;
  else process.env.GROQ_RESPONSE_POLICY = previousResponsePolicy;
});
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
let mockRawResponses: string[] = [];
let mockReconciliation: unknown;
let prompts: string[] = [];

test.beforeEach(async ({ browser }) => {
  dir = await mkdtemp(join(tmpdir(), "incremental-regeneration-"));
  mockCalls = 0;
  mockRawResponses = [];
  mockReconciliation = undefined;
  prompts = [];
  mockSteps = [newStatus];
  const mock = async ({ prompt }: { prompt: string }) => {
    mockCalls++;
    prompts.push(prompt);
    if (mockRawResponses.length) return mockRawResponses.shift()!;
    return JSON.stringify({ steps: mockSteps, reconciliation: mockReconciliation });
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

test("response diagnostics automatically include successful output without saving raw responses", async () => {
  const on = await regenerate({});
  expect(on.status).toBe(200);
  const data = await on.json();
  expect(data.aiUsage.responseDiagnostics).toHaveLength(1);
  expect(data.aiUsage.responseDiagnostics[0]).toMatchObject({call:1,mode:"json",accepted:true});
  expect(JSON.parse(data.aiUsage.responseDiagnostics[0].raw).steps).toEqual([newStatus]);
  const history = await (await fetch(url + "/api/ai-usage?days=0")).json();
  expect(JSON.stringify(history)).not.toContain("responseDiagnostics");
  expect(JSON.stringify(history)).not.toContain("new-status");
});

test("failed initial generation displays both actual malformed responses without enabling capture @sanity", async ({page}) => {
  mockRawResponses = ['{"steps":[FIRST_INCOMPLETE', '{"steps":[SECOND_INCOMPLETE'];
  await page.goto(url);
  await page.locator("#test-name").fill("Failed response diagnostics");
  await page.getByLabel("Your test instructions").fill("Add and verify a task");
  await page.getByLabel("Generate with").selectOption("groq");
  await page.getByRole("button",{name:"Generate draft"}).click();
  await expect(page.locator("#generation-error")).toContainText("model output was not valid JSON");
  const panel = page.locator("#instructions-response-diagnostics > details");
  await expect(panel.locator(":scope > summary")).toHaveText("View model responses (2)");
  await panel.locator(":scope > summary").click();
  const attempts=panel.locator("#response-diagnostics-list > details");
  await expect(attempts).toHaveCount(2);
  for (const [i, marker] of ["FIRST_INCOMPLETE","SECOND_INCOMPLETE"].entries()) {
    const attempt=attempts.nth(i);
    await attempt.locator(":scope > summary").click();
    await attempt.getByText("Raw model response",{exact:true}).click();
    await expect(attempt.locator("pre")).toContainText(marker);
    await expect(attempt.locator("pre")).toBeVisible();
  }
  expect(mockCalls).toBe(2);
});

test("automatic capture retains failed first response and successful retry", async () => {
  mockRawResponses = ['{"steps":[INCOMPLETE', JSON.stringify({steps:[newStatus]})];
  const res=await regenerate({});
  expect(res.status).toBe(200);
  const data=await res.json();
  expect(data.aiUsage.responseDiagnostics).toHaveLength(2);
  expect(data.aiUsage.responseDiagnostics[0].raw).toContain("INCOMPLETE");
  expect(data.aiUsage.responseDiagnostics[0].accepted).not.toBe(true);
  expect(data.aiUsage.responseDiagnostics[1].accepted).toBe(true);
  expect(JSON.parse(data.aiUsage.responseDiagnostics[1].raw).steps).toEqual([newStatus]);
});

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

test("AI replacement automatically reconciles affected instruction links", async () => {
  const definition = await original();
  definition.instructionCoverage = {
    source: "Verify task count is zero.",
    entries: [{id:"R1",text:"Verify task count is zero.",interpretation:"Check count",
      stepIds:["empty"],issue:"",availability:"identified",confirmed:false}],
    prerequisiteStepIds: [],
  };
  mockReconciliation = {
    changes: [{id:"R1",operation:"keep"}], additions: [],
    coverage: {entries:[{id:"R1",interpretation:"Verify count",stepIds:[newStatus.id],availability:"identified"}]},
  };
  const res = await regenerate({definition, instructions:"Verify the count includes zero"});
  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data.definition.instructionCoverage.entries).toHaveLength(1);
  expect(data.definition.instructionCoverage.entries[0].stepIds).toEqual([data.replacement[0].id]);
  expect(data.definition.instructionCoverage.entries[0].issue).toBe("");
  expect(data.definition.workingInstructions).toBe("Verify task count is zero.");
  expect(data.definition.sourceInstructions).toBe("Verify task count is zero.");
});

test("adding another task automatically maps new requirements and preserves unrelated requirements @sanity", async () => {
  const definition = await original();
  // End at the original task visibility assertion, before completion/deletion.
  definition.steps = definition.steps.slice(0, definition.steps.findIndex((step:{id:string})=>step.id==="visible")+1);
  const last = definition.steps.at(-1);
  definition.instructionCoverage = {
    source:"Verify initial count.\nVerify original task.",
    entries:[
      {id:"R1",text:"Verify initial count.",interpretation:"Initial count",stepIds:["empty"],issue:"",confirmed:true},
      {id:"R2",text:"Verify original task.",interpretation:"Original task",stepIds:[last.id],issue:"",confirmed:false}
    ],prerequisiteStepIds:[]
  };
  const originalCheck = {...last,id:"original-check",action:{...last.action,provenance:"requirements"}};
  mockSteps = [originalCheck,...remainder];
  mockReconciliation = {changes:[],additions:["Add Buy groceries.","Verify Buy groceries."],
    coverage:{entries:[
      {id:"R2",interpretation:"Original task",stepIds:["original-check"]},
      {id:"R3",interpretation:"Add task",stepIds:["new-fill","new-add"]},
      {id:"R4",interpretation:"Verify task",stepIds:["new-check"]}
    ]}};
  const res = await regenerate({definition,stepId:last.id,mode:"from",instructions:"Add Buy groceries and verify it."});
  const data=await res.json();
  expect(res.status, JSON.stringify(data)).toBe(200);
  expect(data.definition.instructionCoverage.entries.map((row:{issue:string})=>row.issue)).toEqual(["","","",""]);
  expect(data.definition.instructionCoverage.entries[0]).toEqual(definition.instructionCoverage.entries[0]);
  expect(data.definition.workingInstructions).toContain("Verify Buy groceries.");
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

test("automatic response diagnostics expose successful output and clear it on demand @sanity", async ({page}) => {
  await page.goto(url);
  const panel = page.locator("#response-diagnostics-panel");
  const heading = panel.locator(":scope > summary");
  await expect(page.locator("#instructions-response-diagnostics > details")).toHaveCount(1);
  await expect(heading).toHaveText("View model responses (0)");
  await page.locator("#test-name").fill("Response diagnostics test");
  await page.getByLabel("Your test instructions").fill("Add and verify a task");
  await page.getByLabel("Generate with").selectOption("fixture");
  await page.getByRole("button", {name:"Generate draft"}).click();
  await expect(page.locator("#step-list .step")).toHaveCount(9);
  await page.locator("#stage-instructions").click();
  await page.getByLabel("Generate with").selectOption("groq");
  await page.locator("#stage-draft").click();
  await page.locator("#step-list .step").last().getByRole("button",{name:"Reinterpret with AI"}).click();
  await page.getByLabel("New plain-English instructions for replacement steps").fill("Verify the initial count");
  await page.getByRole("button",{name:"Generate replacement"}).click();
  await expect(page.locator("#incremental-status")).toContainText("Proposal ready");
  await expect(page.locator("#draft-response-diagnostics > details")).toHaveCount(1);
  await expect(panel).not.toHaveAttribute("open","");
  await heading.click();
  const list=page.locator("#response-diagnostics-list");
  const attempt=list.locator(":scope > details");
  await expect(attempt).toHaveCount(1);
  await expect(attempt).not.toHaveAttribute("open","");
  await attempt.locator(":scope > summary").click();
  await attempt.getByText("Raw model response",{exact:true}).click();
  await expect(attempt.locator("pre")).toContainText("new-status");
  await expect(attempt.getByRole("button",{name:"Copy raw model response"})).toBeVisible();
  await page.locator("#nav-ai-usage").click();
  await expect(page.locator("#analytics-response-diagnostics > details")).toHaveCount(1);
  await heading.click();
  await expect(attempt).toHaveCount(1);
  await page.locator("#clear-response-diagnostics").click();
  await expect(list.locator(":scope > details")).toHaveCount(0);
  await expect(heading).toHaveText("View model responses (0)");
});

test("UI proposes suffix replacement, requires Apply and leaves replacement steps unapproved @sanity", async ({page}) => {
  mockSteps = remainder;
  await page.goto(url);
  await page.locator("#test-name").fill("Incremental task test");
  await page.getByLabel("Your test instructions").fill("Add and verify a task");
  await page.getByLabel("Generate with").selectOption("fixture");
  await page.getByRole("button", { name: "Generate draft" }).click();
  await expect(page.locator("#step-list .step")).toHaveCount(9);
  await page.locator("#save-test-name").fill("Incremental task test");
  await page.locator("#step-list .step").nth(0).locator('input[type=checkbox]').check();
  await page.locator("#step-list .step").nth(1).locator('input[type=checkbox]').check();
  await expect(page.locator("#step-list .step")).toHaveCount(9);
  await page.locator("#stage-instructions").click();
  await page.getByLabel("Generate with").selectOption("groq");
  await page.locator("#stage-draft").click();
  await page.locator("#step-list .step").nth(2).getByRole("button", {name:"Reinterpret with AI"}).click();
  await expect(page.getByLabel("Scope of changes")).toHaveCount(0);
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
  await page.locator("#stage-instructions").click();
  await expect(page.locator("#requirements")).toHaveValue(/Incremental amendment/);
  await expect(page.locator("#working-instructions-note")).toBeVisible();
  await expect(page.locator("#working-instructions-note")).toContainText("superseded");
  await expect(page.locator("#original-instructions")).toHaveText("Add and verify a task");
  await page.locator("#stage-draft").click();
  await page.getByRole("button", { name: "Save Draft" }).click();
  await expect(page.locator("#draft-save-status")).toContainText("2/5 approved");
  await page.getByRole("button", { name: "Choose another test" }).click();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Resume Incremental task test", exact: true }).click();
  await expect(page.locator("#review-workspace")).toBeVisible();
  await expect(page.locator("#workspace-main")).toHaveAttribute("data-workspace","draft");
  await page.locator("#stage-instructions").click();
  await expect(page.locator("#working-instructions-note")).toBeVisible();
  await expect(page.locator("#requirements")).toHaveValue(/Incremental amendment/);
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


test("delete a named task uses a valid item-specific click and preserves approved prefix", async () => {
  mockSteps = [
    { id: "remove-eggs", description: "Delete Eggs", action: {
      kind: "click", target: { by: "intent", value: "Delete Eggs", role: "button" },
    }},
    { id: "verify-eggs", description: "Verify Eggs is removed", action: {
      kind: "assert-count", target: { by: "text", value: "Eggs" },
      expected: 0, provenance: "requirements",
    }},
  ];
  const res = await regenerate({
    mode: "from", stepId: "enter", instructions: "Delete Eggs",
    approvedStepIds: ["open", "empty"],
  });
  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data.replacement[0].action).toMatchObject({
    kind: "click", target: { by: "intent", value: "Delete Eggs", role: "button" },
  });
  expect(data.preservedApprovedStepIds).toEqual(["open", "empty"]);
  expect(prompts[0]).toContain("Delete Eggs");
  // This rule lives in the system prompt, not the user prompt captured above.
  expect(data.replacement[0].action).not.toHaveProperty("expected");
});

test("malformed click action is rejected with actionable explanation, no changes saved", async () => {
  mockSteps = [{
    id: "bad-delete", description: "Delete Eggs", action: {
      kind: "click", target: { by: "intent", value: "Delete Eggs", role: "button" },
      expected: "Eggs is gone",
    },
  }];
  const res = await regenerate({ instructions: "Delete Eggs" });
  expect(res.status).toBe(422);
  const data = await res.json();
  expect(data.error).toContain("could not produce valid replacement test steps");
  expect(data.error).toContain("Your existing steps were not changed");
  expect(data.error).toContain("step 1");
  expect(mockCalls).toBe(2);
  expect((await (await fetch(url + "/api/tests")).json()).tests).toHaveLength(0);
});

test("incremental panel shows clear progress and then hides it after output", async ({page}) => {
  await page.goto(url);
  await page.locator("#test-name").fill("Incremental task test");
  await page.getByLabel("Your test instructions").fill("Add and verify a task");
  await page.getByLabel("Generate with").selectOption("fixture");
  await page.getByRole("button", { name: "Generate draft" }).click();
  await expect(page.locator("#step-list .step")).toHaveCount(9);
  await page.locator("#stage-instructions").click();
  await page.getByLabel("Generate with").selectOption("groq");
  await page.locator("#stage-draft").click();
  await page.locator("#step-list .step").nth(2)
    .getByRole("button", { name: "Reinterpret with AI" }).click();
  await page.getByLabel("New plain-English instructions for replacement steps")
    .fill("Delete Eggs");
  await page.getByRole("button", { name: "Generate replacement" }).click();
  await expect(page.locator("#incremental-progress")).toBeHidden();
  await expect(page.locator("#incremental-status")).toBeVisible();
  await expect(page.locator("#incremental-status")).toContainText("Proposal ready");
});


test("Help dialog explains the workflow and limitations without generating AI requests", async ({ page }) => {
  await page.goto(url);
  const help = page.getByRole("dialog", { name: "Using the AI UI Testing Agent" });
  await expect(help).toBeHidden();
  await page.getByRole("button", { name: "? Help" }).click();
  await expect(help).toBeVisible();
  await expect(help.locator("#help-setup-title")).toHaveText("First-time setup: GroqCloud API key");
  await expect(help).toContainText("cp .env.example .env");
  await expect(help).toContainText("future pulls can update");

  await expect(help).toContainText('GROQ_API_KEY="gsk_your-actual-key"');
  await expect(help).toContainText("GROQ_MODEL=openai/gpt-oss-20b");
  await expect(help.getByRole("link", { name: "Create or manage your GroqCloud API key" }))
    .toHaveAttribute("href", "https://console.groq.com/keys");
  await expect(help).toContainText("Quick start");
  await expect(help).toContainText("non-deterministic");
  await expect(help).toContainText("initial page snapshot");
  await expect(help).toContainText("amendment history");
  expect(mockCalls).toBe(0);
  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();
  await page.getByRole("button", { name: "? Help" }).click();
  await help.getByRole("button", { name: "Close help" }).click();
  await expect(help).toBeHidden();
});


for (const [label, overrides, message] of [
  ["initial navigation", { stepId: "open" }, "initial navigation cannot be regenerated"],
  ["unknown approval", { approvedStepIds: ["not-in-test"] }, "Approved step IDs"],
  ["blank instructions", { instructions: "  " }, "instructions"],
] as const) {
  test("regeneration rejects " + label + " without calling provider", async () => {
    const response = await regenerate(overrides);
    expect([400, 422]).toContain(response.status);
    expect((await response.json()).error).toContain(message);
    expect(mockCalls).toBe(0);
  });
}

test("replacing the final step retains all earlier steps and only their approvals", async () => {
  const definition = await original();
  const last = definition.steps.at(-1);
  const response = await regenerate({
    definition, stepId: last.id, mode: "from",
    approvedStepIds: definition.steps.map((step: {id:string}) => step.id),
  });
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.definition.steps.slice(0,-1)).toEqual(definition.steps.slice(0,-1));
  expect(result.preservedApprovedStepIds).toEqual(definition.steps.slice(0,-1).map((step:{id:string})=>step.id));
  expect(result.replacement).toHaveLength(1);
  expect(result.replacement[0].id).not.toBe(last.id);
  expect(mockCalls).toBe(1);
});

test("single-step mode rejects multiple replacements without saving a test", async () => {
  mockSteps = [newStatus, ...remainder];
  const response = await regenerate({ mode: "step" });
  expect(response.status).toBe(422);
  expect((await response.json()).error).toContain("exactly one step");
  expect(mockCalls).toBe(2);
  expect((await (await fetch(url + "/api/tests")).json()).tests).toHaveLength(0);
});

test("invalid reconciliation availability reports its actual field and allowed values", async () => {
  const definition = await original();
  definition.instructionCoverage = {
    source: "Verify task count is zero.",
    entries: [{id:"R1",text:"Verify task count is zero.",interpretation:"Check count",
      stepIds:["empty"],issue:"",availability:"identified",confirmed:false}],
    prerequisiteStepIds: [],
  };
  mockReconciliation = {
    changes: [], additions: [],
    coverage: {entries:[{id:"R1",interpretation:"Verify count",stepIds:[newStatus.id],availability:"available"}]},
  };
  const res = await regenerate({definition});
  const data = await res.json();
  expect(res.status).toBe(422);
  expect(data.error).toContain("reconciliation.coverage.entries.0.availability");
  expect(data.error).toContain("allowed: identified, later-state, selector-uncertain, functional-mismatch, uncertain");
  expect(mockCalls).toBe(2);
  expect(prompts[1]).toContain("Allowed availability: identified");
  expect(prompts[0]).toContain("CURRENT REQUIREMENTS");
});

test("reconciliation availability may be omitted without relaxing enum validation", async () => {
  const definition = await original();
  definition.instructionCoverage = {
    source: "Verify task count is zero.",
    entries: [{id:"R1",text:"Verify task count is zero.",interpretation:"Check count",
      stepIds:["empty"],issue:"",availability:"identified",confirmed:false}],
    prerequisiteStepIds: [],
  };
  mockReconciliation = {
    changes: [], additions: [],
    coverage: {entries:[{id:"R1",interpretation:"Verify count",stepIds:[newStatus.id]}]},
  };
  const res = await regenerate({definition});
  const data = await res.json();
  expect(res.status, JSON.stringify(data)).toBe(200);
  expect(data.definition.instructionCoverage.entries[0].availability).toBe("uncertain");
  expect(data.definition.instructionCoverage.entries[0].stepIds).toEqual([data.replacement[0].id]);
});

test("UI explains malformed AI response and allows retry without editing instructions @sanity", async ({page}) => {
  await page.goto(url);
  await page.locator("#test-name").fill("Malformed response review");
  await page.getByLabel("Your test instructions").fill("Add and verify a task");
  await page.getByLabel("Generate with").selectOption("fixture");
  await page.getByRole("button", {name:"Generate draft"}).click();
  await expect(page.locator("#step-list .step")).toHaveCount(9);
  await page.locator("#stage-instructions").click();
  await page.getByLabel("Generate with").selectOption("groq");
  await page.locator("#stage-draft").click();
  await page.locator("#step-list .step").nth(2).getByRole("button",{name:"Reinterpret with AI"}).click();
  const instructions = page.getByLabel("New plain-English instructions for replacement steps");
  await instructions.fill("Add another task and verify it");
  mockSteps = ["invalid step"];
  await page.getByRole("button",{name:"Generate replacement"}).click();
  const status=page.locator("#incremental-status");
  await expect(status).toContainText("unsupported response structure");
  await expect(status).toContainText("retry using the same instructions or revise them");
  await expect(status.getByText("Technical details:",{exact:false})).toBeHidden();
  await status.locator("summary").click();
  await expect(status.getByText("Technical details:",{exact:false})).toBeVisible();
  await expect(status).toContainText("non-deterministic");
  await expect(status).toContainText("persistent failures");
  await expect(page.locator("#step-list .step")).toHaveCount(9);
  mockSteps=remainder;
  await page.getByRole("button",{name:"Generate replacement"}).click();
  await expect(status).toContainText("Proposal ready");
  await expect(instructions).toHaveValue("Add another task and verify it");
  await expect(page.locator("#incremental-proposed-steps .run-step")).toHaveCount(3);
  expect(prompts.at(-1)).toContain("Replace the selected step and all following steps");
});

test("JSON-only malformed incremental response is recovered once and does not save a test",async()=>{
  mockRawResponses=['{"steps":[INCOMPLETE',JSON.stringify({steps:[newStatus]})];
  const res=await regenerate({});
  expect(res.status).toBe(200);
  expect(mockCalls).toBe(2);
  const data=await res.json();
  expect(data.aiUsage.responseDiagnostics).toHaveLength(2);
  expect(data.aiUsage.responseDiagnostics[0].raw).toContain("INCOMPLETE");
  expect(data.aiUsage.responseDiagnostics[0].accepted).not.toBe(true);
  expect(data.aiUsage.responseDiagnostics[1].accepted).toBe(true);
  expect(data.replacement[0].action).toEqual(newStatus.action);
  expect((await (await fetch(url+"/api/tests")).json()).tests).toHaveLength(0);
});

test("JSON-only incremental recovery stops after two malformed responses without saving",async()=>{
  mockRawResponses=['{"steps":[INCOMPLETE','{"steps":[STILL_INCOMPLETE'];
  const res=await regenerate({});
  expect(res.status).toBe(422);
  expect(mockCalls).toBe(2);
  const data=await res.json();
  expect(data.aiUsage.responseDiagnostics).toHaveLength(2);
  expect(data.aiUsage.responseDiagnostics[0].raw).toContain("INCOMPLETE");
  expect(data.aiUsage.responseDiagnostics[1].raw).toContain("STILL_INCOMPLETE");
  expect(data.aiUsage.responseDiagnostics.every((attempt:{accepted?:boolean})=>attempt.accepted!==true)).toBe(true);
  expect((await (await fetch(url+"/api/tests")).json()).tests).toHaveLength(0);
});


test("live reinterpretation is temporarily disabled at UI and API boundary", async ({browser}) => {
  const liveDir = await mkdtemp(join(tmpdir(), "incremental-disabled-"));
  const live = await createReviewServer(liveDir, browser);
  try {
    await new Promise<void>(resolve => live.listen(0, "127.0.0.1", resolve));
    const address = "http://127.0.0.1:" + (live.address() as AddressInfo).port;
    const html = await (await fetch(address)).text();
    expect(html).toContain("const incrementalReinterpretationEnabled = false;");
    expect(html).toContain("reinterpret.disabled = !incrementalReinterpretationEnabled");
    const response = await fetch(address + "/api/regenerate-steps", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({definition: await original(), baseURL, stepId:"empty",
        mode:"from", instructions:"Verify count contains zero", approvedStepIds:[], provider:"groq"}),
    });
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain("temporarily disabled");
  } finally {
    live.closeAllConnections();
    await new Promise<void>(resolve => live.close(() => resolve()));
    await rm(liveDir, {recursive:true,force:true});
  }
});
