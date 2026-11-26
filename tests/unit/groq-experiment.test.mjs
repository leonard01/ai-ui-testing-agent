import { test } from "node:test";
import assert from "node:assert/strict";
import { requestGroq, groqResponsePolicy, groqReasoningEffort, effectiveGroqMode } from "../../dist/hosted-providers.js";

test("experiment settings preserve hybrid defaults and reject unsupported settings",()=>{
 assert.equal(groqResponsePolicy(""),"hybrid");
 assert.equal(effectiveGroqMode("json","hybrid"),"json");
 assert.equal(effectiveGroqMode("text","hybrid"),"text");
 assert.equal(effectiveGroqMode("text","json"),"json");
 assert.equal(effectiveGroqMode("json","text"),"text");
 assert.throws(()=>groqResponsePolicy("other"),/GROQ_RESPONSE_POLICY/);
 assert.equal(groqReasoningEffort("openai/gpt-oss-20b",""),undefined);
 assert.equal(groqReasoningEffort("openai/gpt-oss-20b","low"),"low");
 assert.throws(()=>groqReasoningEffort("openai/gpt-oss-20b","none"),/GROQ_REASONING_EFFORT/);
 assert.throws(()=>groqReasoningEffort("unsupported","low"),/GPT-OSS/);
});

test("fixed JSON and text policies vary only response format with constant reasoning and budget",async()=>{
 const keys=["GROQ_API_KEY","GROQ_RESPONSE_POLICY","GROQ_REASONING_EFFORT","GROQ_MAX_COMPLETION_TOKENS"];
 const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 try {
  process.env.GROQ_API_KEY="fixture-secret";
  process.env.GROQ_REASONING_EFFORT="low";
  process.env.GROQ_MAX_COMPLETION_TOKENS="2500";
  const req={model:"openai/gpt-oss-20b",system:"same system",prompt:"same prompt"};
  const requests=[], usage=[], evidence=[];
  for(const policy of ["json","text"]){
   process.env.GROQ_RESPONSE_POLICY=policy;
   await requestGroq(req,async(_url,options)=>{
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({choices:[{message:{content:"{}"},finish_reason:"stop"}]}));
   },row=>usage.push(row),undefined,event=>evidence.push(event));
  }
  assert.deepEqual(requests[0].response_format,{type:"json_object"});
  assert.equal(requests[1].response_format,undefined);
  const {response_format,...rest}=requests[0];
  assert.deepEqual(rest,requests[1]);
  assert.equal(rest.reasoning_effort,"low");
  assert.equal(rest.max_completion_tokens,2500);
  assert.deepEqual(usage.map(r=>[r.responsePolicy,r.responseMode,r.reasoningEffort]),[["json","json","low"],["text","text","low"]]);
  assert.equal(evidence.at(-1).reasoningEffort,"low");
 }finally{for(const k of keys){if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}}
});
