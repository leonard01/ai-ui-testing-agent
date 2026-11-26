import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { generateDraft, type ModelRequest } from "../src/generation.js";
import { generateIncrementalProposal } from "../src/incremental-generation.js";
import { GroqProviderError } from "../src/hosted-providers.js";

const baseURL = "http://127.0.0.1:3000/";
const error = (status = 400, category: "json-generation" | "rate-limit" | "authentication" | "bad-request" = "json-generation") =>
  new GroqProviderError(status, category, undefined, undefined, undefined, "Mocked provider error");
async function original() { return JSON.parse(await readFile("examples/add-task.json", "utf8")); }
const replacement = { id: "new-verify", description: "Verify initial count", action: {
  kind: "assert-text", target: {by: "role", role: "status"}, expected: "0 tasks",
  match: "contains", provenance: "requirements",
} };
const fence = (json: string) => "```json\n" + json + "\n```";

test("initial generation falls back to text after explicit HTTP 400 JSON failure @sanity", async ({browser}) => {
  const source = await original();
  for (const step of source.steps) if ("provenance" in step.action) step.action.provenance = "requirements";
  const calls: ModelRequest[] = [];
  const draft = await generateDraft({baseURL,model:"fixture",requirements:"Add and verify a task",retryMalformedOutput:true}, async req => {
    calls.push(req);
    if (calls.length === 1) throw error();
    return fence(JSON.stringify(source));
  }, browser);
  expect(calls).toHaveLength(2);
  expect(calls[0].responseMode).toBeUndefined();
  expect(calls[1].responseMode).toBe("text");
  expect(calls[1].system).toBe(calls[0].system);
  expect(calls[1].prompt).toBe(calls[0].prompt);
  expect(draft.generationAttempts).toBe(2);
  expect(draft.needsReview).toBe(true);
  expect(draft.definition.steps).toEqual(source.steps);
});

test("incremental text fallback preserves earlier and later steps and review gates @sanity", async ({browser}) => {
  const definition = await original();
  const calls: ModelRequest[] = [];
  const options = {definition,baseURL,stepId:"empty",mode:"step" as const,instructions:"Verify zero tasks",
    approvedStepIds:["open","empty","enter"],model:"fixture",retryMalformedOutput:true};
  const proposal = await generateIncrementalProposal(options, async req => {
    calls.push(req);
    if (calls.length === 1) throw error();
    return '{steps:[' + JSON.stringify(replacement) + ',],}';
  }, browser);
  expect(calls).toHaveLength(2);
  expect(calls[1].responseMode).toBe("text");
  expect(calls[1].prompt).toBe(calls[0].prompt);
  expect(proposal.definition.steps[0]).toEqual(definition.steps[0]);
  expect(proposal.definition.steps.slice(2)).toEqual(definition.steps.slice(2));
  expect(proposal.preservedApprovedStepIds).toEqual(["open","enter"]);
  expect(proposal.replacement[0].action).toEqual(replacement.action);
  expect(proposal.generationAttempts).toBe(2);
});

test("unrecoverable fallback never requests a third completion or approves partial output", async ({browser}) => {
  const calls: ModelRequest[] = [];
  const definition = await original();
  const snapshot = JSON.stringify(definition);
  const options = {definition,baseURL,stepId:"empty",mode:"step" as const,instructions:"Verify zero tasks",
    approvedStepIds:["open","empty"],model:"fixture",retryMalformedOutput:true};
  await expect(generateIncrementalProposal(options, async req => {
    calls.push(req);
    if (calls.length === 1) throw error();
    return '{"steps":[{"id":"incomplete"';
  }, browser)).rejects.toThrow(/existing steps were not changed/);
  expect(calls).toHaveLength(2);
  expect(JSON.stringify(definition)).toBe(snapshot);
});

test("initial generation never falls back on quota, authentication or unrelated 400", async ({browser}) => {
  for (const failure of [error(429,"rate-limit"),error(401,"authentication"),error(400,"bad-request")]) {
    let calls=0;
    await expect(generateDraft({baseURL,model:"fixture",requirements:"Verify status",retryMalformedOutput:true},
      async () => {calls++; throw failure;},browser)).rejects.toBe(failure);
    expect(calls).toBe(1);
  }
});
