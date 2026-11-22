import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  observeSuccessfulRun, getApplicationMemory, getMemorySuggestions,
} from "../../dist/application-memory.js";
import { makeGenerationPrompt } from "../../dist/generation.js";

const origin = "https://shop.example.test";
const steps = [
  { id:"open", description:"Open website", action:{kind:"navigate",url:origin} },
  { id:"user", description:"Enter username", action:{kind:"fill",target:{by:"label",value:"Username"},value:"user@example.test"} },
  { id:"pass", description:"Enter password", action:{kind:"fill",target:{by:"label",value:"Password"},value:"super-secret-password"} },
  { id:"login", description:"Click Log in", action:{kind:"click",target:{by:"role",role:"button",name:"Login"}} },
  { id:"add", description:"Add items to basket", action:{kind:"click",target:{by:"role",role:"button",name:"Add to cart"}} },
  { id:"verify", description:"Verify cart item visible",action:{kind:"assert-visible",target:{by:"text",value:"Basket"},provenance:"requirements"} },
];
const definition = {schemaVersion:1,id:"login-cart",title:"Shop test",version:1,steps};
const report = (status = "passed") => ({
  schemaVersion:1,testId:null,title:"Shop test",status,
  startedAt:new Date().toISOString(),durationMs:1250,
  steps:steps.map(step=>({
    id:step.id,description:step.description,status:"passed",durationMs:30,
  })),
  artifacts:{},evidenceErrors:[],
});
async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(),"site-memory-test-"));
  try { await run(dir); }
  finally { await rm(dir,{recursive:true,force:true}); }
}

test("only successful authenticated shopping workflows produce per-site abstract memory",async()=>{
  await withDir(async dir=>{
    const failed=report("assertion-failed");
    assert.equal(await observeSuccessfulRun(dir,origin,definition,failed),false);
    assert.equal(await getApplicationMemory(dir,origin),null);
    const partial=report();
    partial.steps.at(-1).status="skipped";
    assert.equal(await observeSuccessfulRun(dir,origin,definition,partial),false);
    assert.equal(await observeSuccessfulRun(dir,origin,definition,report()),true);
    assert.equal(await observeSuccessfulRun(dir,origin,definition,report()),true);
    const saved=await getApplicationMemory(dir,origin+"/shop?private=secret");
    assert.equal(saved.siteOrigin,origin);
    assert.equal(saved.observations.authenticationBeforeShopping.successfulRuns,2);
    assert.equal(await getApplicationMemory(dir,"https://other.example.test"),null);
    const entries=await readdir(join(dir,"application-memory"));
    assert.equal(entries.length,1);
    const content=await readFile(join(dir,"application-memory",entries[0]),"utf8");
    assert.ok(!content.includes("super-secret-password"));
    assert.ok(!content.includes("user@example.test"));
    assert.ok(!content.includes("?private=secret"));
    assert.ok(!content.includes("Shop test"));
    const recommendations=getMemorySuggestions(saved,"add multiple items to basket");
    assert.equal(recommendations.length,1);
    assert.equal(recommendations[0].evidence,"successful-execution");
    assert.equal(recommendations[0].successfulRuns,2);
    assert.match(recommendations[0].text,/logged in first/);
    assert.deepEqual(getMemorySuggestions(saved,"log in and add items to basket"),[]);
    assert.deepEqual(getMemorySuggestions(saved,"search for a price"),[]);
  });
});

test("passing invalid-login or login-only tests do not imply authenticated shopping",async()=>{
  await withDir(async dir=>{
    const loginOnly={...definition,steps:steps.slice(0,4)};
    const loginOnlyReport={...report(),steps:report().steps.slice(0,4)};
    assert.equal(await observeSuccessfulRun(dir,origin,loginOnly,loginOnlyReport),false);
    const noPassword={...definition,steps:steps.filter(step=>step.id!=="pass")};
    const noPasswordReport={...report(),steps:report().steps.filter(step=>step.id!=="pass")};
    assert.equal(await observeSuccessfulRun(dir,origin,noPassword,noPasswordReport),false);
    assert.equal(await getApplicationMemory(dir,origin),null);
  });
});

test("memory hints enter model prompt only when explicitly provided, and remain unverified",()=>{
  const snapshot={url:origin,title:"Shop",headings:[],controls:[],statusText:[],sampleText:[]};
  const plain=makeGenerationPrompt("add to basket",snapshot);
  assert.ok(!plain.prompt.includes("HISTORICAL WEBSITE"));
  const contextual=makeGenerationPrompt("add to basket",snapshot,[
    "Previous passing shopping test logged in before adding items.",
  ]);
  assert.match(contextual.prompt,/HISTORICAL WEBSITE PREREQUISITE SUGGESTIONS/);
  assert.match(contextual.prompt,/not proof of a necessary prerequisite/);
  assert.match(contextual.prompt,/human approval/);
});
