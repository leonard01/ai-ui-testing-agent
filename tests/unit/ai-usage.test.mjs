import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUsageStore, readTokenUsage, summarizeUsage } from "../../dist/ai-usage.js";
import { requestGroq, groqCompletionBudget } from "../../dist/hosted-providers.js";

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

test("completion budget validation and safe 429 quota extraction",async()=>{
 const key=process.env.GROQ_API_KEY, budget=process.env.GROQ_MAX_COMPLETION_TOKENS;
 process.env.GROQ_API_KEY="fixture-secret";
 delete process.env.GROQ_MAX_COMPLETION_TOKENS;
 try {
  assert.equal(groqCompletionBudget(),2500);
  assert.equal(groqCompletionBudget("1800"),1800);
  assert.throws(()=>groqCompletionBudget("0"));
  assert.throws(()=>groqCompletionBudget("5001"));
  assert.throws(()=>groqCompletionBudget("2.5"));
  const records=[];
  const req={model:"fixture",system:"a".repeat(400),prompt:"b".repeat(80)};
  let calls=0;
  await assert.rejects(requestGroq(req,async(_url,options)=>{
    calls++;
    assert.equal(JSON.parse(options.body).max_completion_tokens,2500);
    return new Response(JSON.stringify({error:{code:"rate_limit_exceeded",message:"Rate limit reached on tokens per minute (TPM): Limit 8,000, Used 0, Requested 8,250. Private payload."}}),{status:429,headers:{"retry-after":"2.5","x-ratelimit-remaining-tokens":"8000"}});
  },r=>records.push(r)));
  assert.equal(calls,1);
  assert.equal(records[0].estimatedInputTokens,120);
  assert.equal(records[0].completionBudget,2500);
  assert.equal(records[0].providerTokenLimit,8000);
  assert.equal(records[0].providerRequestedTokens,8250);
  assert.equal(records[0].providerUsedTokens,0);
  assert.equal(records[0].retryAfter,"2.5");
  assert.equal(records[0].totalTokens,undefined);
  assert.doesNotMatch(JSON.stringify(records),/Private payload/);
  process.env.GROQ_MAX_COMPLETION_TOKENS="1800";
  await requestGroq(req,async(_url,options)=>{
    assert.equal(JSON.parse(options.body).max_completion_tokens,1800);
    return new Response(JSON.stringify({choices:[{message:{content:"{}"}}],usage:{prompt_tokens:120,completion_tokens:80,total_tokens:200}}));
  },r=>records.push(r));
  assert.equal(records[1].completionBudget,1800);
  assert.equal(records[1].totalTokens,200);
 } finally {
  if(key===undefined)delete process.env.GROQ_API_KEY;else process.env.GROQ_API_KEY=key;
  if(budget===undefined)delete process.env.GROQ_MAX_COMPLETION_TOKENS;else process.env.GROQ_MAX_COMPLETION_TOKENS=budget;
 }
});
