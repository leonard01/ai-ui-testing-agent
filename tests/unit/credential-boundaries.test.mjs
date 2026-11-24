import { test } from "node:test";
import assert from "node:assert/strict";
import { requireHumanCredentialValues, unresolvedCredentialSteps, assertCredentialsReviewed, USERNAME_REVIEW_PLACEHOLDER, PASSWORD_REVIEW_PLACEHOLDER } from "../../dist/credential-guard.js";

function definition(label,value,login=false){
  return {schemaVersion:1,id:"credential",title:"Credential review",version:1,steps:[
    {id:"open",description:"Open page",action:{kind:"navigate",url:"/"}},
    {id:"fill",description:"Fill field",action:{kind:"fill",target:{by:"label",value:label},value}},
    ...(login?[{id:"login",description:"Sign in",action:{kind:"click",target:{by:"role",role:"button",name:"Sign in"}}}]:[]),
    {id:"verify",description:"Verify",action:{kind:"assert-visible",target:{by:"text",value:"Done"},provenance:"requirements"}}
  ]};
}
for(const label of ["Password","pass_code","PWD","OTP","Verification code","Auth token","One-time password"]){
  test("redacts model-authored "+label,()=>{
    const d=definition(label,"invented-secret");
    assert.equal(requireHumanCredentialValues(d),1);
    assert.equal(d.steps[1].action.value,PASSWORD_REVIEW_PLACEHOLDER);
    assert.deepEqual(unresolvedCredentialSteps(d),[2]);
    assert.equal(requireHumanCredentialValues(d),0);
  });
}
for(const label of ["User name","Login ID","Account name"]){
  test("redacts model-authored "+label,()=>{
    const d=definition(label,"invented-user");
    assert.equal(requireHumanCredentialValues(d),1);
    assert.equal(d.steps[1].action.value,USERNAME_REVIEW_PLACEHOLDER);
  });
}
for(const label of ["Email","User"]){
  test(label+" is treated as credential only with login context",()=>{
    const ordinary=definition(label,"ordinary-data");
    assert.equal(requireHumanCredentialValues(ordinary),0);
    assert.equal(ordinary.steps[1].action.value,"ordinary-data");
    const login=definition(label,"invented-user",true);
    assert.equal(requireHumanCredentialValues(login),1);
    assert.equal(login.steps[1].action.value,USERNAME_REVIEW_PLACEHOLDER);
  });
}
for(const value of ["replace_with_your_password"," YOUR_USERNAME ","ENTER_PASSWORD","<password>"]){
  test("placeholder cannot bypass review by changing locator: "+value,()=>{
    const d=definition("Unrelated input",value);
    assert.deepEqual(unresolvedCredentialSteps(d),[2]);
    assert.throws(()=>assertCredentialsReviewed(d),/step\(s\) 2/);
  });
}
test("blank credential is blocked but clearing an ordinary input is permitted",()=>{
  assert.deepEqual(unresolvedCredentialSteps(definition("Password","  ")),[2]);
  assert.deepEqual(unresolvedCredentialSteps(definition("Search","")),[]);
});
test("reviewed credential values are accepted without mutation or exposure in diagnostics",()=>{
  const d=definition("Password","test-secret");
  assert.doesNotThrow(()=>assertCredentialsReviewed(d));
  assert.equal(d.steps[1].action.value,"test-secret");
  const invalid=definition("Username",USERNAME_REVIEW_PLACEHOLDER);
  try{assertCredentialsReviewed(invalid);assert.fail("expected rejection");}
  catch(error){assert.match(error.message,/Credential values require tester review/);assert.ok(!error.message.includes(USERNAME_REVIEW_PLACEHOLDER));}
});
