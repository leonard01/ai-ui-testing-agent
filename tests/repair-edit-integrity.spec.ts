import { test, expect } from "@playwright/test";
import { createReviewServer } from "../src/review-server.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

test.use({trace:"off"});
const baseURL="http://127.0.0.1:3000";
let server: Server, directory: string, url: string;
test.beforeEach(async ({browser})=>{
  directory=await mkdtemp(join(tmpdir(),"repair-integrity-"));
  server=await createReviewServer(directory,browser);
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  url="http://127.0.0.1:"+(server.address() as AddressInfo).port;
});
test.afterEach(async()=>{
  server.closeAllConnections();
  await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  await rm(directory,{recursive:true,force:true});
});
async function post(path:string,data:unknown){
  const r=await fetch(url+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});
  return {status:r.status,body:await r.json()};
}
async function saved(){
  const definition=JSON.parse(await readFile("examples/add-task.json","utf8"));
  definition.sourceInstructions="Original instructions";
  definition.workingInstructions="Original instructions";
  const response=await post("/api/save",{baseURL,definition,testName:"Original"});
  expect(response.status).toBe(200);
  return response.body.id as string;
}
async function load(id:string){
  const response=await fetch(url+"/api/tests/"+id);
  expect(response.status).toBe(200);
  return (await response.json()).definition;
}
async function count(){
  return (await (await fetch(url+"/api/tests")).json()).tests.length;
}
async function run(id:string){
  const started=await post("/api/run",{baseURL,id,timeoutMs:500});
  expect(started.status).toBe(202);
  let result:any;
  await expect.poll(async()=>{
    result=await (await fetch(url+"/api/runs/"+started.body.id)).json();
    return result.state;
  },{timeout:20000}).toBe("finished");
  return result;
}
test("invalid edit cannot overwrite the approved script",async()=>{
  const id=await saved();
  const original=await load(id);
  const invalid=structuredClone(original);
  invalid.steps=[];
  const response=await post("/api/save",{baseURL,definition:invalid,testName:"Invalid",replaceId:id});
  expect(response.status).toBe(400);
  expect(await load(id)).toEqual(original);
  expect(await count()).toBe(1);
});
test("save as new preserves original and creates an independent copy",async()=>{
  const id=await saved();
  const original=await load(id);
  const edited=structuredClone(original);
  edited.workingInstructions="Changed";
  const response=await post("/api/save",{baseURL,definition:edited,testName:"Copy"});
  expect(response.status).toBe(200);
  expect(response.body.id).not.toBe(id);
  expect(await load(id)).toEqual(original);
  expect(await load(response.body.id)).toMatchObject({title:"Copy",workingInstructions:"Changed"});
  expect(await count()).toBe(2);
});
test("replacement preserves original instructions despite attempted overwrite",async()=>{
  const id=await saved();
  const edited=await load(id);
  edited.sourceInstructions="Attempted overwrite";
  edited.workingInstructions="Revised instructions";
  const response=await post("/api/save",{baseURL,definition:edited,testName:"Amended",replaceId:id});
  expect(response.status).toBe(200);
  expect(response.body.replacedId).toBe(id);
  expect(await load(response.body.id)).toMatchObject({sourceInstructions:"Original instructions",workingInstructions:"Revised instructions"});
  expect((await fetch(url+"/api/tests/"+id)).status).toBe(404);
  expect(await count()).toBe(1);
});
for(const endpoint of ["repair","repair-target","repair-assertion-target","repair-submit","repair-assertion"]){
  test(endpoint+" rejects nonexistent run evidence without modifying approved scripts",async()=>{
    const id=await saved();
    const original=await load(id);
    const result=await post("/api/"+endpoint,{runId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",stepId:"empty",candidateIndex:0,confirmed:true,expected:"New"});
    expect(result.status).toBe(400);
    expect(await load(id)).toEqual(original);
    expect(await count()).toBe(1);
  });
}
test("passing execution cannot be used as evidence to rewrite an assertion",async()=>{
  const id=await saved();
  const original=await load(id);
  const completed=await run(id);
  expect(completed.report.status).toBe("passed");
  const response=await post("/api/repair-assertion",{runId:completed.id,stepId:"empty",expected:"Changed",confirmed:true});
  expect(response.status).toBe(400);
  expect(await load(id)).toEqual(original);
});
test("failed assertion repair requires confirmation and rejects invalid or unchanged expectations",async()=>{
  const definition=JSON.parse(await readFile("examples/add-task.json","utf8"));
  definition.steps[1].action.expected="Wrong count";
  const response=await post("/api/save",{baseURL,definition,testName:"Failure"});
  expect(response.status).toBe(200);
  const id=response.body.id;
  const original=await load(id);
  const completed=await run(id);
  expect(completed.report.status).toBe("assertion-failed");
  for(const override of [{confirmed:false},{expected:"x".repeat(10001)},{expected:"Wrong count"},{match:"invalid"}]){
    const result=await post("/api/repair-assertion",{runId:completed.id,stepId:"empty",expected:"0 tasks, 0 completed",confirmed:true,...override});
    expect(result.status).toBe(400);
    expect(await load(id)).toEqual(original);
    expect(await count()).toBe(1);
  }
  const repaired=await post("/api/repair-assertion",{runId:completed.id,stepId:"empty",expected:"0 tasks, 0 completed",confirmed:true});
  expect(repaired.status).toBe(201);
  const updated=await load(repaired.body.id);
  expect(updated.steps[1].action).toMatchObject({expected:"0 tasks, 0 completed",provenance:"human-confirmed"});
  expect(updated.steps.slice(2)).toEqual(original.steps.slice(2));
  expect(await count()).toBe(1);
});
