import {test} from "node:test";
import assert from "node:assert/strict";
import {normaliseMixedLocators} from "../../dist/locator-normalisation.js";

const cases=[
  {instruction:"Click Logout.",target:{by:"intent",role:"button",value:"Logout"},hint:true},
  {instruction:"Click the Logout button.",target:{by:"intent",role:"button",value:"Logout"},hint:false},
  {instruction:"Click the Logout link.",target:{by:"intent",role:"button",value:"Logout"},hint:false},
  {instruction:"Click Logout. Verify the Logout button is visible.",target:{by:"intent",role:"button",value:"Logout"},hint:false},
  {instruction:"Click Logout.",target:{by:"intent",role:"button",value:"Logout",rolePolicy:"strict"},hint:false},
  {instruction:"Click Logout.",target:{by:"role",role:"button",name:"Logout"},hint:false},
  {instruction:"Click Logout.",target:{by:"intent",role:"checkbox",value:"Logout"},hint:false},
  {instruction:"Click Continue.",target:{by:"intent",role:"button",value:"Logout"},hint:false},
  {instruction:"Do not click Logout.",target:{by:"intent",role:"button",value:"Logout"},hint:false},
];
for(const scenario of cases){
  test("inferred role classification: "+JSON.stringify(scenario),()=>{
    const original={steps:[{id:"click",description:"Click Logout",action:{kind:"click",target:scenario.target}}]};
    const before=structuredClone(original);
    const result=normaliseMixedLocators(original,scenario.instruction);
    const expected=structuredClone(original);
    if(scenario.hint)expected.steps[0].action.target.rolePolicy="hint";
    assert.deepEqual(result.value,expected);
    assert.equal(result.repairs.length,scenario.hint?1:0);
    assert.deepEqual(original,before);
  });
}
