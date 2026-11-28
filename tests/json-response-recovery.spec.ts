import { test, expect } from "@playwright/test";

// Legacy recovery tests explicitly opt in; every other case exercises JSON-only.
let previousResponsePolicy: string | undefined;
test.beforeEach(async ({}, info) => {
  previousResponsePolicy = process.env.GROQ_RESPONSE_POLICY;
  const legacy = ["initial generation falls back","incremental text fallback","unrecoverable fallback","initial generation never falls back"].some(prefix => info.title.startsWith(prefix));
  process.env.GROQ_RESPONSE_POLICY = legacy ? "hybrid" : "json";
});
test.afterEach(() => {
  if (previousResponsePolicy === undefined) delete process.env.GROQ_RESPONSE_POLICY;
  else process.env.GROQ_RESPONSE_POLICY = previousResponsePolicy;
});
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

test("JSON-only initial generation rejects provider JSON failure without text retry", async ({browser}) => {
  const calls: ModelRequest[] = [];
  const failure=error();
  await expect(generateDraft({baseURL,model:"fixture",requirements:"Verify status",retryMalformedOutput:true}, async req=>{calls.push(req);throw failure;},browser)).rejects.toBe(failure);
  expect(calls).toHaveLength(1);
  expect(calls[0].responseMode ?? "json").toBe("json");
});
test("JSON-only incremental failure retries once in JSON and leaves definition unchanged", async ({browser}) => {
  const definition=await original();
  const snapshot=JSON.stringify(definition);
  const calls: ModelRequest[]=[];
  const failure=error();
  await expect(generateIncrementalProposal({definition,baseURL,stepId:"empty",mode:"step",instructions:"Verify zero tasks",approvedStepIds:["open","empty"],model:"fixture",retryMalformedOutput:true},async req=>{calls.push(req);throw failure;},browser)).rejects.toBe(failure);
  expect(calls).toHaveLength(2);
  expect(calls.every(call => (call.responseMode ?? "json") === "json")).toBe(true);
  expect(JSON.stringify(definition)).toBe(snapshot);
});


// Captured mixed role/intent shape, with synthetic data and no live provider.
const mixedTarget = (name: string, intent: string) => ({by:"role",role:"button",name,intent});
function mixedDefinition(targets: unknown[]) {
  return {schemaVersion:1,id:"mixed-locator",title:"Mixed locator",version:1,steps:[
    {id:"open",description:"Open",action:{kind:"navigate",url:baseURL}},
    ...targets.map((target,i)=>({id:"click-"+i,description:"Interact",action:{kind:"click",target}})),
    {id:"verify",description:"Verify",action:{kind:"assert-visible",target:{by:"text",value:"Example"},provenance:"requirements"}},
  ]};
}
test("mixed locator recovery preserves contextual intent across captured cart workflows", async ({browser}) => {
  for (const targets of [
    [mixedTarget("Add to cart","Add Sauce Labs Backpack to the cart"),mixedTarget("Add to cart","Add Sauce Labs Bike Light to the cart"),mixedTarget("Open the cart","Open the cart")],
    [mixedTarget("Add to cart","Add Sauce Labs Backpack to the cart"),mixedTarget("Add to cart","Add Sauce Labs Bike Light to the cart"),mixedTarget("Cart","Open the cart"),mixedTarget("Remove","Remove Sauce Labs Backpack from the cart")],
    [mixedTarget("Edit","Edit Quarterly report"),mixedTarget("Delete","Delete Draft report")],
  ]) {
    const source=mixedDefinition(targets);
    let calls=0;
    const events: any[]=[];
    const draft=await generateDraft({baseURL,model:"fixture",requirements:"Perform specified interactions",observeResponse:(_attempt,event)=>events.push(event)},async()=>{calls++;return JSON.stringify(source);},browser);
    expect(calls).toBe(1);
    expect(draft.needsReview).toBe(true);
    expect(draft.definition.steps.slice(1,-1).map(step=>step.action)).toEqual(targets.map(t=>({kind:"click",target:{by:"intent",role:"button",value:t.intent}})));
    expect(events.some(e=>e.repairs?.some((repair:string)=>repair.includes("mixed")))).toBe(true);
  }
});
test("mixed locator recovery rejects conflicting and unsupported fields", async ({browser}) => {
  for (const target of [
    mixedTarget("Delete","Open settings"),
    {...mixedTarget("Edit","Edit Quarterly report"),nth:1},
    {...mixedTarget("Edit","Edit Quarterly report"),value:"Other"},
    {...mixedTarget("Edit","Edit Quarterly report"),intent:""},
    {...mixedTarget("Edit","Edit Quarterly report"),role:"checkbox"},
    {...mixedTarget("Edit","Edit Quarterly report"),rolePolicy:"hint"},
  ]) {
    await expect(generateDraft({baseURL,model:"fixture",requirements:"Perform specified interactions"},async()=>JSON.stringify(mixedDefinition([target])),browser)).rejects.toThrow(/invalid test definition/);
  }
});


test("JSON-only incremental retry repairs captured mixed locator shape and preserves prefix @sanity", async ({browser}) => {
  const definition = await original();
  const calls: ModelRequest[] = [];
  const proposal = await generateIncrementalProposal({definition,baseURL,stepId:"empty",mode:"step",instructions:"Delete Draft report",approvedStepIds:["open"],model:"fixture",retryMalformedOutput:true},async req=>{
    calls.push(req);
    if(calls.length===1) return '{"steps":[';
    return JSON.stringify({steps:[{id:"delete-report",description:"Delete Draft report",action:{kind:"click",target:{by:"role",role:"button",name:"Delete",intent:"Delete Draft report"}}}]});
  },browser);
  expect(calls).toHaveLength(2);
  expect(calls.every(call=>(call.responseMode ?? "json")==="json")).toBe(true);
  expect(proposal.definition.steps[0]).toEqual(definition.steps[0]);
  expect(proposal.definition.steps.slice(2)).toEqual(definition.steps.slice(2));
  expect(proposal.replacement[0].action).toEqual({kind:"click",target:{by:"intent",role:"button",value:"Delete Draft report"}});
});
