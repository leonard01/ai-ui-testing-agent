import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceRequirements, proposedCoverage, generationExceptions, instructionCoverageProblems, assertInstructionCoverageReviewed } from "../../dist/requirement-preservation.js";
const navigate={id:"open",description:"Open",action:{kind:"navigate",url:"/"}};
const action={id:"act",description:"Perform action",action:{kind:"click",target:{by:"role",role:"button",name:"Submit"}}};
const verify={id:"verify",description:"Verify",action:{kind:"assert-text",target:{by:"role",role:"status"},expected:"Ready",provenance:"requirements"}};
const definition=()=>({schemaVersion:1,id:"case",title:"Case",version:1,steps:structuredClone([navigate,action,verify])});
const map=(id,stepIds,issue)=>({id,interpretation:"Model interpretation",stepIds,...(issue?{issue}:{})});
test("source statements are retained verbatim, including negative constraints",()=>{
 assert.deepEqual(sourceRequirements("Register an account.\n\nDo not send an email. Verify success."),[
 {id:"R1",text:"Register an account."},{id:"R2",text:"Do not send an email."},{id:"R3",text:"Verify success."}]);
});
for(const instruction of ["Log in.","Add a product to the cart.","Search for an item.","Submit the registration form.","Never delete the record."]){
 test("unmapped requirement stays unresolved: "+instruction,()=>{
  const d=definition(); d.instructionCoverage=proposedCoverage(instruction,d,undefined,false);
  assert.equal(d.instructionCoverage.entries[0].text,instruction);
  assert.equal(instructionCoverageProblems(d).length,1);
  assert.throws(()=>assertInstructionCoverageReviewed(d),/Unresolved instruction coverage/);
 });
}
test("valid mappings do not require a separate confirmation workflow",()=>{
 const d=definition(); d.instructionCoverage=proposedCoverage("Submit. Verify success.",d,{entries:[map("R1",["act"]),map("R2",["verify"])]},false);
 assert.deepEqual(generationExceptions(d),[]);
 assert.ok(d.instructionCoverage.entries.every(row=>!row.confirmed));
 assert.deepEqual(instructionCoverageProblems(d),[]);
});
test("missing, duplicate and unknown source IDs cannot disappear",()=>{
 for(const entries of [[map("R1",["act"])],[map("R1",["act"]),map("R1",["act"])],[map("R1",["act"]),map("R9",["verify"])] ]){
 const d=definition();d.instructionCoverage=proposedCoverage("Submit. Verify success.",d,{entries},false);
 assert.equal(d.instructionCoverage.entries.length,2);
 assert.ok(d.instructionCoverage.entries.some(row=>row.issue));
 }
});
test("invented step ID, duplicate link and explicit unresolved issue block coverage",()=>{
 for(const entry of [map("R1",["missing"]),map("R1",["act","act"]),map("R1",["act"],"Cannot identify target")]){
 const d=definition();d.instructionCoverage=proposedCoverage("Submit.",d,{entries:[entry]},false);
 d.instructionCoverage.entries[0].confirmed=true;
 assert.equal(instructionCoverageProblems(d).length,1);
 }
});
test("deleting a linked step invalidates coverage",()=>{
 const d=definition();d.instructionCoverage=proposedCoverage("Submit.",d,{entries:[map("R1",["act"])]},false);
 d.instructionCoverage.entries[0].confirmed=true;d.steps=d.steps.filter(step=>step.id!=="act");
 assert.equal(instructionCoverageProblems(d).length,1);
});
test("changing or removing a source row cannot be confirmed",()=>{
 const d=definition();d.instructionCoverage=proposedCoverage("Submit. Verify success.",d,{entries:[map("R1",["act"]),map("R2",["verify"])]},false);
 d.instructionCoverage.entries.pop();
 assert.match(instructionCoverageProblems(d)[0],/Original instruction statements/);
});
test("memory-suggested steps are separate from explicit mappings and ignored when off",()=>{
 for(const enabled of [true,false]){
 const d=definition();d.instructionCoverage=proposedCoverage("Verify success.",d,{entries:[map("R1",["verify"])],prerequisiteStepIds:["act","verify","missing"]},enabled);
 assert.deepEqual(d.instructionCoverage.prerequisiteStepIds,enabled?["act"]:[]);
 assert.equal(d.steps[1].description.startsWith("[Suggested prerequisite]"),enabled);
 assert.equal(d.steps[2].description,"Verify");
 }
});
test("legacy and fixture definitions are unchanged",()=>assert.deepEqual(instructionCoverageProblems(definition()),[]));

test("later-state and selector uncertainty with executable mappings do not interrupt generation",()=>{
 for(const availability of ["later-state","selector-uncertain"]){
 const d=definition();d.instructionCoverage=proposedCoverage("Submit.",d,{entries:[{...map("R1",["act"],"Target not yet observed"),availability}]},false);
 assert.deepEqual(generationExceptions(d),[]);
 assert.deepEqual(instructionCoverageProblems(d),[]);
 }
});
test("functional mismatch requires a decision even if an executable mapping exists",()=>{
 const d=definition();d.instructionCoverage=proposedCoverage("Submit.",d,{entries:[{...map("R1",["act"]),availability:"functional-mismatch"}]},false);
 assert.equal(generationExceptions(d).length,1);
 assert.equal(instructionCoverageProblems(d).length,1);
 d.instructionCoverage.proceedAccepted=true;
 assert.deepEqual(instructionCoverageProblems(d),[]);
 d.instructionCoverage.entries[0].stepIds=[];
 assert.equal(instructionCoverageProblems(d).length,0);
 assert.equal(generationExceptions(d).length,1);
});

test("mapping diagnostics distinguish missing, duplicate, unknown and malformed references",()=>{
 const cases=[
  [undefined,/did not return requirement mapping data/],
  [{entries:[]},/did not return a mapping for this requirement/],
  [{entries:[map("R1",[])]},/did not associate any executable steps/],
  [{entries:[map("R1",["act"]),map("R1",["verify"])]},/multiple mappings/],
  [{entries:[map("R1",["act","act"])]},/same executable step more than once/],
  [{entries:[map("R1",["missing"])]},/step IDs not present in the current draft: missing/],
  [{entries:[map("R2",["act"])]},/unknown requirement IDs: R2/],
  [{entries:[{id:"R1",stepIds:"act"}]},/unsupported mapping structure/],
 ];
 for(const [proposal,expected] of cases){
  const d=definition();
  d.instructionCoverage=proposedCoverage("Submit.",d,proposal,false);
  const row=d.instructionCoverage.entries[0];
  assert.match(row.issue,expected);
  assert.match(row.issue,/does not establish whether the draft fulfils the requirement/);
  assert.ok(row.stepIds.every(id=>d.steps.some(step=>step.id===id)));
  assert.equal(instructionCoverageProblems(d).length,1);
  assert.throws(()=>assertInstructionCoverageReviewed(d),/Unresolved instruction coverage/);
 }
});

test("invalid mapping reason is retained even when AI supplies an advisory note",()=>{
 const d=definition();
 d.instructionCoverage=proposedCoverage("Submit.",d,{entries:[{
  ...map("R1",["missing"],"Target appears later"),availability:"later-state"
 }]},false);
 const row=d.instructionCoverage.entries[0];
 assert.match(row.issue,/step IDs not present in the current draft: missing/);
 assert.match(row.issue,/AI note: Target appears later/);
 assert.equal(instructionCoverageProblems(d).length,1);
 assert.equal(generationExceptions(d).length,1);
});

test("mixed mapping references preserve valid links and require explicit acknowledgement",()=>{
 const d=definition();d.instructionCoverage=proposedCoverage("Submit.",d,{entries:[map("R1",["act","missing","act"])]},false);
 assert.deepEqual(d.instructionCoverage.entries[0].stepIds,["act"]);
 assert.equal(d.instructionCoverage.entries[0].confirmed,false);
 assert.match(d.instructionCoverage.entries[0].issue,/missing/);
 assert.throws(()=>assertInstructionCoverageReviewed(d),/Unresolved instruction coverage/);
 d.instructionCoverage.proceedAccepted=true;
 assert.doesNotThrow(()=>assertInstructionCoverageReviewed(d));
 assert.equal(generationExceptions(d).length,1);
 d.instructionCoverage.entries[0].stepIds.push("invalid");
 assert.throws(()=>assertInstructionCoverageReviewed(d),/Unresolved instruction coverage/);
});
