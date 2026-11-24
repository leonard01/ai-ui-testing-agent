import { test } from "node:test";
import assert from "node:assert/strict";
import { requestGroq, GroqProviderError } from "../../dist/hosted-providers.js";

const request={model:"mock-model",system:"Return JSON",prompt:"Test"};
async function withKey(fn){
  const previous=process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY="gsk_fake_test_key";
  try {await fn();} finally {
    if(previous===undefined)delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY=previous;
  }
}
for(const [status,category] of [[403,"authentication"],[429,"rate-limit"],[500,"provider-error"],[502,"provider-error"],[503,"provider-error"]]){
  test("HTTP "+status+" classified without automatic retry",()=>withKey(async()=>{
    let calls=0;
    await assert.rejects(requestGroq(request,async()=>{
      calls++;
      return new Response("private upstream content",{status});
    }),error=>{
      assert.ok(error instanceof GroqProviderError);
      assert.equal(error.httpStatus,status);
      assert.equal(error.category,category);
      assert.ok(!error.message.includes("private upstream content"));
      return true;
    });
    assert.equal(calls,1);
  }));
}
test("unsupported model parameter classified safely",()=>withKey(async()=>{
  await assert.rejects(requestGroq(request,async()=>new Response(JSON.stringify({
    error:{code:"unsupported_value",param:"temperature",message:"Unsupported parameter"}
  }),{status:400})),error=>{
    assert.equal(error.category,"invalid-parameter");
    assert.equal(error.providerParam,"temperature");
    return true;
  });
}));
test("unsafe provider metadata does not enter diagnostics",()=>withKey(async()=>{
  await assert.rejects(requestGroq(request,async()=>new Response(JSON.stringify({
    error:{code:"contains secret text",type:"x".repeat(81),param:"https://private.example/path?key=secret",message:"private user instructions"}
  }),{status:400})),error=>{
    assert.equal(error.category,"bad-request");
    assert.equal(error.providerCode,undefined);
    assert.equal(error.providerType,undefined);
    assert.equal(error.providerParam,undefined);
    assert.ok(!error.message.includes("private"));
    return true;
  });
}));
for(const [label,payload] of [
  ["null",null],["empty message",{choices:[{message:{}}]}],
  ["whitespace",{choices:[{message:{content:"  "}}]}],
  ["non-string",{choices:[{message:{content:42}}]}],
]){
  test("successful HTTP response rejects "+label+" completion",()=>withKey(async()=>{
    let calls=0;
    await assert.rejects(requestGroq(request,async()=>{
      calls++;
      return new Response(JSON.stringify(payload),{status:200});
    }),/no generated JSON text/);
    assert.equal(calls,1);
  }));
}
test("successful completion following HTTP failure is a fresh independent request",()=>withKey(async()=>{
  await assert.rejects(requestGroq(request,async()=>new Response("limited",{status:429})),error=>error.category==="rate-limit");
  const result=await requestGroq(request,async()=>new Response(JSON.stringify({choices:[{message:{content:'{"ok":true}'}}]})));
  assert.equal(result,'{"ok":true}');
}));
