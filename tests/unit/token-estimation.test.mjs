import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {countHarmonyText,estimateModelTokens} from "../../dist/token-estimation.js";
import {makeGenerationPrompt} from "../../dist/generation.js";
const model="openai/gpt-oss-20b";
const snapshot={url:"http://127.0.0.1:3000/",title:"Task list",headings:["Task list"],controls:[{kind:"textbox",name:"Task",placeholder:"Task"},{kind:"button",name:"Add"}],statusText:["0 tasks, 0 completed"],sampleText:[],inspection:{mainDocumentStatus:200,blockedCrossOriginRequests:0,allowedCrossOriginRequests:0,pageErrors:0}};
test("Harmony counts known ordinary text and treats untrusted special markers as ordinary text",()=>{
 assert.equal(countHarmonyText(""),0);
 assert.equal(countHarmonyText("hello world"),2);
 assert.ok(countHarmonyText("<|start|>")>1);
 assert.ok(countHarmonyText("测试 🧪")>0);
});
test("unsupported models are explicitly approximate",()=>{
 assert.deepEqual(estimateModelTokens({model:"fixture",system:"1234",prompt:"5678"}),{estimator:"characters-v1",estimatedInputTokens:2});
});
test("offline prompt benchmark: short, multi-step and negative assertions",async()=>{
 const fixture=JSON.parse(await readFile(new URL("../../examples/add-task.json",import.meta.url),"utf8"));
 const representative=JSON.stringify({...fixture,steps:fixture.steps.map((step,i)=>({...step,requirementIds:i===0?[]:["R1"],action:{...step.action,...(step.action.provenance?{provenance:"requirements"}:{})}}))});
 for(const [name,requirements] of [
  ["short","Add a task called Review report. Verify it is visible."],
  ["experiment","Add test1 task then verify\nAdd test2 task then verify\nDelete test1 task then verify"],
  ["negative","Add a task called Review report. Add a task called Prepare presentation. Verify both tasks are visible. Delete Review report. Verify Review report is no longer visible. Delete Prepare presentation. Verify Prepare presentation is no longer visible."]
 ]){
  const request={model,...makeGenerationPrompt(requirements,snapshot,[],true)};
  const estimate=estimateModelTokens(request,representative);
  console.log(name,JSON.stringify(estimate));
  assert.equal(estimate.estimatedInputTokens,estimate.systemTokens+estimate.promptTokens);
  assert.ok(estimate.estimatedInputTokens<=1800,"Offline fixture input budget exceeded; review prompt growth");
  assert.ok(estimate.representativeOutputTokens<=1000,"Representative nine-step output budget exceeded");
  assert.deepEqual(estimateModelTokens(request,representative),estimate);
 }
});

test("provisional GroqCloud calibration is scoped to GPT-OSS 20B and effective response mode",()=>{
 const req={model,system:"hello world",prompt:"hello world"};
 const base=estimateModelTokens(req).estimatedInputTokens;
 for(const [responseMode,overhead] of [["json",102],["text",74]]){
  const input={...req,responseMode};
  const calibrated=estimateModelTokens(input,undefined,"groqcloud");
  assert.equal(calibrated.estimatedInputTokens,base+overhead);
  assert.equal(calibrated.providerOverheadTokens,overhead);
  assert.equal(estimateModelTokens(input).estimatedInputTokens,base);
  assert.equal(estimateModelTokens({...input,model:"openai/gpt-oss-120b"},undefined,"groqcloud").estimatedInputTokens,base);
 }
 assert.equal(estimateModelTokens(req,undefined,"groqcloud").estimatedInputTokens,base);
});
