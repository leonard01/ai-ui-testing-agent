import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseMixedLocators } from "../../dist/locator-normalisation.js";
import { parseTestDefinition } from "../../dist/schema.js";

const draft = target => ({
  schemaVersion: 1, id: "textarea-case", title: "Enter comments", version: 1,
  steps: [
    {id:"open",description:"Open form",action:{kind:"navigate",url:"/"}},
    {id:"fill",description:"Enter comments",action:{kind:"fill",target,value:"Keep this text"}},
    {id:"verify",description:"Verify form",action:{kind:"assert-visible",target:{by:"text",value:"Form ready"},provenance:"requirements"}}
  ]
});

for (const target of [
  {by:"role",role:"textarea",name:"Comments"},
  {by:"intent",role:"textarea",value:"Comments"},
  {by:"role",role:"textarea",name:"Comments",nth:1},
]) {
  test("model-only textarea alias normalisation: "+JSON.stringify(target), () => {
    const original = draft(target);
    assert.throws(() => parseTestDefinition(original));
    const {value,repairs} = normaliseMixedLocators(original);
    const expected = draft({...target,role:"textbox"});
    assert.deepEqual(value,expected);
    assert.equal(repairs.length,1);
    assert.match(repairs[0],/steps\[1\]\.action\.target/);
    assert.deepEqual(parseTestDefinition(value),expected);
    assert.equal(original.steps[1].action.target.role,"textarea");
  });
}

test("textarea alias does not modify unrelated actions or discard unrecognised locator fields", () => {
  const extra = draft({by:"role",role:"textarea",name:"Comments",unknown:true});
  const unrelated = draft({by:"role",role:"textarea",name:"Comments"});
  unrelated.steps[1].action = {kind:"click",target:unrelated.steps[1].action.target};
  for(const original of [extra,unrelated]){
    const result=normaliseMixedLocators(original);
    assert.deepEqual(result.value,original);
    assert.deepEqual(result.repairs,[]);
    assert.throws(()=>parseTestDefinition(result.value));
  }
});
