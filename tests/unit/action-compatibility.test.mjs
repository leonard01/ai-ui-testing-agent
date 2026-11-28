import { test } from "node:test";
import assert from "node:assert/strict";
import { draftQualityWarnings } from "../../dist/draft-diagnostics.js";

const snapshot={title:"Form",headings:[],statusText:[],sampleText:[],controls:[]};
const definition=action=>({schemaVersion:1,id:"compat",title:"Form",version:1,steps:[
  {id:"open",description:"Open",action:{kind:"navigate",url:"/"}},
  {id:"choice",description:"Choose option",action},
  {id:"verify",description:"Verify",action:{kind:"assert-visible",target:{by:"text",value:"Ready"},provenance:"requirements"}}
]});
for(const [kind,role] of [["select-option","radio"],["fill","checkbox"],["check","textbox"],["uncheck","radio"]]){
  test("draft warns for "+kind+" on "+role,()=>{
    const action={kind,target:{by:"role",role,name:"Choice"},...(["fill","select-option"].includes(kind)?{value:"yes"}:{})};
    const draft=definition(action);
    const original=structuredClone(draft);
    const warnings=draftQualityWarnings("",draft,snapshot);
    assert.ok(warnings.some(w=>w.includes("Step 2")&&w.includes(kind)&&w.includes(role)));
    assert.deepEqual(draft,original);
  });
}
test("compatible or unspecified targets receive no action mismatch warning",()=>{
  for(const action of [
    {kind:"select-option",target:{by:"role",role:"combobox"},value:"yes"},
    {kind:"check",target:{by:"role",role:"radio"}},
    {kind:"fill",target:{by:"intent",role:"textbox",value:"Comments"},value:"yes"},
    {kind:"fill",target:{by:"label",value:"Comments"},value:"yes"},
    {kind:"click",target:{by:"role",role:"heading",name:"Expandable section"}},
  ]) assert.deepEqual(draftQualityWarnings("",definition(action),snapshot),[]);
});
