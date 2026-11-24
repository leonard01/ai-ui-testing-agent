import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeSuccessfulRun, getApplicationMemory, getMemorySuggestions } from "../../dist/application-memory.js";

const origin="https://shop.example.test";
const steps=()=>[
  {id:"open",description:"Open",action:{kind:"navigate",url:origin}},
  {id:"pass",description:"Password",action:{kind:"fill",target:{by:"label",value:"Password"},value:"secret"}},
  {id:"login",description:"Sign in",action:{kind:"click",target:{by:"role",role:"button",name:"Sign in"}}},
  {id:"shop",description:"Add to cart",action:{kind:"click",target:{by:"role",role:"button",name:"Add to cart"}}},
  {id:"check",description:"Verify basket",action:{kind:"assert-visible",target:{by:"text",value:"Basket"},provenance:"requirements"}},
];
const definition=(s=steps())=>({schemaVersion:1,id:"shop",title:"Shop",version:1,steps:s});
const report=(s=steps())=>({schemaVersion:1,testId:null,title:"Shop",status:"passed",startedAt:new Date().toISOString(),durationMs:10,steps:s.map(x=>({id:x.id,description:x.description,status:"passed",durationMs:1})),artifacts:{},evidenceErrors:[]});
const stored=(count=1,siteOrigin=origin)=>({schemaVersion:1,siteOrigin,observations:{authenticationBeforeShopping:{successfulRuns:count,lastObservedAt:"2026-01-01T00:00:00.000Z"}}});
async function isolated(fn){
  const dir=await mkdtemp(join(tmpdir(),"memory-integrity-"));
  try {await fn(dir);} finally {await rm(dir,{recursive:true,force:true});}
}
async function seed(dir,value){
  await mkdir(join(dir,"application-memory"),{recursive:true});
  await writeFile(join(dir,"application-memory",createHash("sha256").update(origin).digest("hex")+".json"),value);
}
for(const [label,value] of [
  ["broken JSON","{broken"],
  ["wrong schema",JSON.stringify({...stored(),schemaVersion:2})],
  ["wrong origin",JSON.stringify(stored(1,"https://other.example.test"))],
  ["zero count",JSON.stringify(stored(0))],
  ["negative count",JSON.stringify(stored(-1))],
  ["fractional count",JSON.stringify(stored(1.5))],
  ["excessive count",JSON.stringify(stored(1000001))],
  ["missing observation",JSON.stringify({...stored(),observations:{}})],
  ["invalid date",JSON.stringify({...stored(),observations:{authenticationBeforeShopping:{successfulRuns:1,lastObservedAt:"invalid"}}})],
]){
  test("memory ignores "+label,()=>isolated(async dir=>{
    await seed(dir,value);
    assert.equal(await getApplicationMemory(dir,origin),null);
    assert.deepEqual(getMemorySuggestions(await getApplicationMemory(dir,origin),"Add to cart"),[]);
  }));
}
test("corrupt memory recovers on a subsequent successful run",()=>isolated(async dir=>{
  await seed(dir,"invalid");
  assert.equal(await observeSuccessfulRun(dir,origin,definition(),report()),true);
  assert.equal((await getApplicationMemory(dir,origin)).observations.authenticationBeforeShopping.successfulRuns,1);
}));
test("successful observation count saturates at maximum",()=>isolated(async dir=>{
  await seed(dir,JSON.stringify(stored(1000000)));
  assert.equal(await observeSuccessfulRun(dir,origin,definition(),report()),true);
  assert.equal((await getApplicationMemory(dir,origin)).observations.authenticationBeforeShopping.successfulRuns,1000000);
}));
test("failed later run never increments existing evidence",()=>isolated(async dir=>{
  await observeSuccessfulRun(dir,origin,definition(),report());
  const failed=report();failed.status="execution-error";
  assert.equal(await observeSuccessfulRun(dir,origin,definition(),failed),false);
  assert.equal((await getApplicationMemory(dir,origin)).observations.authenticationBeforeShopping.successfulRuns,1);
}));
test("truncated report cannot establish memory",()=>isolated(async dir=>{
  const partial=report();partial.steps.pop();
  assert.equal(await observeSuccessfulRun(dir,origin,definition(),partial),false);
  assert.equal(await getApplicationMemory(dir,origin),null);
}));
test("same hostname with a different port or scheme has independent memory",()=>isolated(async dir=>{
  await observeSuccessfulRun(dir,origin,definition(),report());
  assert.equal(await getApplicationMemory(dir,"https://shop.example.test:444"),null);
  assert.equal(await getApplicationMemory(dir,"http://shop.example.test"),null);
  assert.equal((await getApplicationMemory(dir,origin+"/other?x=1")).siteOrigin,origin);
}));
test("shopping before authentication is not sufficient evidence",()=>isolated(async dir=>{
  const s=steps();const reordered=[s[0],s[3],s[4],s[1],s[2]];
  assert.equal(await observeSuccessfulRun(dir,origin,definition(reordered),report(reordered)),false);
}));
test("password filled after login does not establish authentication evidence",()=>isolated(async dir=>{
  const s=steps();const reordered=[s[0],s[2],s[1],s[3],s[4]];
  assert.equal(await observeSuccessfulRun(dir,origin,definition(reordered),report(reordered)),false);
}));
test("explicit login instructions suppress remembered prerequisite suggestions",()=>{
  for(const instructions of ["Sign in then checkout","LOGIN and add a product","Authenticate before shopping"])
    assert.deepEqual(getMemorySuggestions(stored(),instructions),[]);
});
test("null observation produces no prerequisite suggestions",()=>{
  assert.deepEqual(getMemorySuggestions({...stored(),observations:{authenticationBeforeShopping:null}},"Add to cart"),[]);
});
