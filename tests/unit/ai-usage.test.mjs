import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUsageStore, readTokenUsage, summarizeUsage } from "../../dist/ai-usage.js";
import { requestGroq } from "../../dist/hosted-providers.js";

test("usage metadata survives restart; unknown counts are not zero",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"ai-usage-"));
 try{
  const store=createUsageStore(dir);
  const base={provider:"groqcloud",model:"fixture",startedAt:new Date().toISOString(),durationMs:10,completionBudget:5000,systemCharacters:10,promptCharacters:20,transportAttempt:1};
  await store.record("op","generate",1,{...base,status:"response-received",...readTokenUsage({prompt_tokens:100,completion_tokens:50,total_tokens:150})});
  await store.record("op","generate",2,{...base,status:"rate-limit",httpStatus:429});
  const rows=await createUsageStore(dir).list();
  assert.equal(rows.length,2);
  assert.equal(rows[1].totalTokens,undefined);
  assert.deepEqual(summarizeUsage(rows),{requests:2,knownRequests:1,totalTokens:150,inputTokens:100,outputTokens:50,unknownRequests:1,rateLimits:1});
 }finally{await rm(dir,{recursive:true,force:true});}
});
test("mocked provider records success and 429 without storing prompts or retrying HTTP",async()=>{
 const old=process.env.GROQ_API_KEY;
 process.env.GROQ_API_KEY="fixture-secret";
 const records=[];
 const request={model:"fixture",system:"private system",prompt:"private prompt"};
 try{
  const result=await requestGroq(request,async()=>new Response(JSON.stringify({choices:[{message:{content:"{}"}}],usage:{prompt_tokens:12,completion_tokens:8,total_tokens:20}}),{status:200,headers:{"x-ratelimit-remaining-tokens":"800","x-ratelimit-reset-tokens":"1.5s"}}),r=>{records.push(r)});
  assert.equal(result,"{}");
  assert.equal(records[0].totalTokens,20);
  assert.equal(records[0].remainingTokens,800);
  let calls=0;
  await assert.rejects(requestGroq(request,async()=>{calls++;return new Response("{}",{status:429})},r=>{records.push(r)}));
  assert.equal(calls,1);
  assert.equal(records[1].httpStatus,429);
  assert.equal(records[1].totalTokens,undefined);
  assert.doesNotMatch(JSON.stringify(records),/private prompt|private system|fixture-secret/);
 }finally{if(old===undefined)delete process.env.GROQ_API_KEY;else process.env.GROQ_API_KEY=old;}
});
