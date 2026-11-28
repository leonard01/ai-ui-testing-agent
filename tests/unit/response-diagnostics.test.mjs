import { test } from "node:test";
import assert from "node:assert/strict";
import { createResponseCapture } from "../../dist/response-diagnostics.js";
import { requestGroq } from "../../dist/hosted-providers.js";

test("automatic capture retains both rejected and successful attempts",()=>{
  const c=createResponseCapture();
  assert.deepEqual(c.snapshot(),[]);
  c.start(1,"json"); c.providerError(1,'{"error":{"failed_generation":"bad"}}');
  c.start(2,"text"); c.raw(2,"{}"); c.observe(2,{accepted:true});
  assert.equal(c.snapshot().length,2);
  assert.match(c.snapshot()[0].providerError,/failed_generation/);
  assert.equal(c.snapshot()[1].raw,"{}");
  assert.equal(c.snapshot()[1].accepted,true);
});
test("success capture includes raw and repaired JSON but redacts configured key and bounds display",()=>{
  const old=process.env.GROQ_API_KEY; process.env.GROQ_API_KEY="fixture-secret";
  try{
    const c=createResponseCapture();
    c.start(1,"json"); c.raw(1,'{value:"fixture-secret",}');
    c.observe(1,{parsed:{value:"fixture-secret"},repairs:["unquoted-key","trailing-comma"],accepted:true,validation:"Passed"});
    c.start(2,"text"); c.raw(2,"x".repeat(128001));
    const rows=c.snapshot();
    assert.equal(rows.length,2);
    assert.equal(rows[0].accepted,true);
    assert.deepEqual(rows[0].repairs,["unquoted-key","trailing-comma"]);
    assert.doesNotMatch(JSON.stringify(rows),/fixture-secret/);
    assert.match(rows[0].repairedJSON,/REDACTED API KEY/);
    assert.equal(rows[1].raw.length,128000);
    assert.equal(rows[1].rawTruncated,true);
  }finally{if(old===undefined)delete process.env.GROQ_API_KEY;else process.env.GROQ_API_KEY=old;}
});
test("Groq rejected response can be captured separately from usage telemetry",async()=>{
  const old=process.env.GROQ_API_KEY;process.env.GROQ_API_KEY="fixture-secret";
  try{
    const c=createResponseCapture();
    c.start(1,"json");
    const usage=[];
    const errorBody=JSON.stringify({error:{code:"json_validate_failed",message:"Failed to generate valid JSON",failed_generation:"private rejected model response"}});
    await assert.rejects(requestGroq({model:"fixture",system:"system",prompt:"prompt"},async()=>new Response(errorBody,{status:400}),row=>usage.push(row),raw=>c.providerError(1,raw)));
    assert.equal(c.snapshot()[0].providerError,errorBody);
    assert.doesNotMatch(JSON.stringify(usage),/private rejected model response/);
  }finally{if(old===undefined)delete process.env.GROQ_API_KEY;else process.env.GROQ_API_KEY=old;}
});

test("provider evidence preserves complete HTTP body and short length-limited completion",async()=>{
  const old=process.env.GROQ_API_KEY;process.env.GROQ_API_KEY="fixture-secret";
  try {
    const c=createResponseCapture();c.start(1,"text");
    const content='{"schemaVersion":1,"id":"test';
    const body=JSON.stringify({choices:[{message:{content},finish_reason:"length"}],usage:{prompt_tokens:1200,completion_tokens:2500,completion_tokens_details:{reasoning_tokens:2490}}});
    const result=await requestGroq({model:"fixture",system:"system",prompt:"prompt",responseMode:"text"},async()=>new Response(body),undefined,undefined,event=>c.evidence(1,event));
    assert.equal(result,content);
    const row=c.snapshot()[0];
    assert.equal(row.httpBody,body);
    assert.equal(row.httpBodyCharacters,body.length);
    assert.equal(row.raw,content);
    assert.equal(row.contentCharacters,content.length);
    assert.equal(row.finishReason,"length");
    assert.equal(row.httpStatus,200);
    assert.equal(row.completionTokens,2500);
    assert.equal(row.reasoningTokens,2490);
  }finally{if(old===undefined)delete process.env.GROQ_API_KEY;else process.env.GROQ_API_KEY=old;}
});
test("empty content and unreadable HTTP bodies remain inspectable after provider throws",async()=>{
  const old=process.env.GROQ_API_KEY;process.env.GROQ_API_KEY="fixture-secret";
  try {
    const req={model:"fixture",system:"system",prompt:"prompt",responseMode:"text"};
    for (const [body,status] of [[JSON.stringify({choices:[{message:{content:""},finish_reason:"length"}]}),"empty-response"],["not JSON","unreadable-response"]]){
      const c=createResponseCapture();c.start(1,"text");
      await assert.rejects(requestGroq(req,async()=>new Response(body),undefined,undefined,event=>c.evidence(1,event)));
      const row=c.snapshot()[0];
      assert.equal(row.httpBody,body);
      assert.equal(row.status,status);
      assert.equal(row.httpStatus,200);
      if(status==="empty-response"){assert.equal(row.raw,"");assert.equal(row.contentCharacters,0);assert.equal(row.finishReason,"length");}
    }
    const c=createResponseCapture();c.start(1,"text");
    await assert.rejects(requestGroq(req,async()=>{throw new TypeError("network")},undefined,undefined,event=>c.evidence(1,event)));
    assert.equal(c.snapshot()[0].status,"network");
    assert.equal(c.snapshot()[0].httpStatus,undefined);
  }finally{if(old===undefined)delete process.env.GROQ_API_KEY;else process.env.GROQ_API_KEY=old;}
});
