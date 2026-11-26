import { test } from "node:test";
import assert from "node:assert/strict";
import { createResponseCapture } from "../../dist/response-diagnostics.js";
import { requestGroq } from "../../dist/hosted-providers.js";

test("diagnostics are disabled by default, including when success alone is requested",()=>{
  for(const body of [undefined,{}, {responseDiagnostics:{includeSuccess:true}}, {responseDiagnostics:{capture:"true"}}]){
    const c=createResponseCapture(body); c.start(1,"json"); c.raw(1,"private"); c.observe(1,{accepted:true});
    assert.equal(c.snapshot(),undefined);
  }
});
test("failure-only capture excludes accepted attempts, including after recovery",()=>{
  const c=createResponseCapture({responseDiagnostics:{capture:true}});
  c.start(1,"json"); c.providerError(1,'{"error":{"failed_generation":"bad"}}');
  c.start(2,"text"); c.raw(2,"{}"); c.observe(2,{accepted:true});
  assert.equal(c.snapshot().length,1);
  assert.match(c.snapshot()[0].providerError,/failed_generation/);
});
test("success capture includes raw and repaired JSON but redacts configured key and bounds display",()=>{
  const old=process.env.GROQ_API_KEY; process.env.GROQ_API_KEY="fixture-secret";
  try{
    const c=createResponseCapture({responseDiagnostics:{capture:true,includeSuccess:true}});
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
    const c=createResponseCapture({responseDiagnostics:{capture:true,includeSuccess:true}});
    c.start(1,"json");
    const usage=[];
    const errorBody=JSON.stringify({error:{code:"json_validate_failed",message:"Failed to generate valid JSON",failed_generation:"private rejected model response"}});
    await assert.rejects(requestGroq({model:"fixture",system:"system",prompt:"prompt"},async()=>new Response(errorBody,{status:400}),row=>usage.push(row),raw=>c.providerError(1,raw)));
    assert.equal(c.snapshot()[0].providerError,errorBody);
    assert.doesNotMatch(JSON.stringify(usage),/private rejected model response/);
  }finally{if(old===undefined)delete process.env.GROQ_API_KEY;else process.env.GROQ_API_KEY=old;}
});
