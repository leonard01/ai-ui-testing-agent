import { test } from "node:test";
import assert from "node:assert/strict";
import { explicitAuthenticationIntent, authenticationRequirementProblems, markSuggestedAuthentication } from "../../dist/requirement-preservation.js";
const navigate={id:"open",description:"Open",action:{kind:"navigate",url:"/"}};
const verify={id:"verify",description:"Verify",action:{kind:"assert-text",target:{by:"role",role:"status"},expected:"Ready",provenance:"requirements"}};
const fill=(id,label)=>({id,description:"Enter "+label,action:{kind:"fill",target:{by:"label",value:label},value:"demo"}});
const login={id:"login",description:"Click Login",action:{kind:"click",target:{by:"role",role:"button",name:"Login"}}};
const definition=(...steps)=>({schemaVersion:1,id:"case",title:"Case",version:1,steps:[navigate,...steps,verify]});
for(const instruction of ["Log in using the standard user account.","Open the page. Then sign in.","Authenticate before shopping."]){
 test("explicit command requires authentication: "+instruction,()=>{
  assert.equal(explicitAuthenticationIntent(instruction),"required");
  assert.equal(authenticationRequirementProblems(instruction,definition()).length,1);
  assert.deepEqual(authenticationRequirementProblems(instruction,definition(login)),[]);
 });
}
for(const instruction of ["Do not log in.","Shop without logging in.","Never sign in.","Skip authentication."]){
 test("negative authentication instruction: "+instruction,()=>{
  assert.equal(explicitAuthenticationIntent(instruction),"forbidden");
  assert.deepEqual(authenticationRequirementProblems(instruction,definition()),[]);
  assert.equal(authenticationRequirementProblems(instruction,definition(login)).length,1);
 });
}
test("conflicting authentication instructions are not silently resolved",()=>{
 assert.equal(explicitAuthenticationIntent("Log in. Do not log in."),"conflict");
 assert.equal(authenticationRequirementProblems("Log in. Do not log in.",definition(login)).length,1);
});
test("login page assertion is not an instruction to authenticate",()=>{
 assert.equal(explicitAuthenticationIntent("Verify the login button is visible."),"unspecified");
 assert.deepEqual(authenticationRequirementProblems("Verify the login button is visible.",definition()),[]);
});
test("ordinary task instructions are unaffected",()=>{
 assert.deepEqual(authenticationRequirementProblems("Add a task and verify the status.",definition()),[]);
});
test("a login claim in a description cannot mask unrelated executable target",()=>{
 const unrelated={...login,action:{kind:"click",target:{by:"role",role:"button",name:"Add"}}};
 assert.equal(authenticationRequirementProblems("Log in.",definition(unrelated)).length,1);
});
test("keyboard submission from password input can represent login",()=>{
 const enter={id:"submit",description:"Submit",action:{kind:"press",target:{by:"label",value:"Password"},key:"Enter"}};
 assert.deepEqual(authenticationRequirementProblems("Log in.",definition(fill("password","Password"),enter)),[]);
});
test("suggested authentication steps visibly labelled without changing actions or unrelated steps",()=>{
 const d=definition(fill("username","Username"),fill("password","Password"),structuredClone(login));
 const before=structuredClone(d);
 markSuggestedAuthentication(d); markSuggestedAuthentication(d);
 assert.deepEqual(d.steps.map(s=>s.action),before.steps.map(s=>s.action));
 assert.deepEqual(d.steps.map(s=>s.description.startsWith("[Suggested prerequisite] ")),[false,true,true,true,false]);
});
