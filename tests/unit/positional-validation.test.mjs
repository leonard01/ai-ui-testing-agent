import { test } from "node:test";
import assert from "node:assert/strict";
import { draftQualityWarnings } from "../../dist/draft-diagnostics.js";

const snapshot={title:"Controls",headings:[],statusText:[],sampleText:[],controls:[]};
const cases=[
  {instructions:"Click the second Delete button.",name:"Delete",nth:1,warn:false},
  {instructions:"Click the second Delete button.",name:"Delete",nth:0,warn:true},
  {instructions:"Click the Delete button.",name:"Delete",nth:2,warn:true},
  {instructions:"Click the third Edit button.",name:"Edit",nth:2,warn:false},
  {instructions:"Click the third Edit button.",name:"Edit",warn:true},
  {instructions:"Click the second Edit button.",name:"Delete",nth:1,warn:true},
  {instructions:"Click the Delete button. Verify the second row.",name:"Delete",nth:1,warn:true},
  {instructions:"Click the Delete button.",name:"Delete",warn:false},
];
for(const scenario of cases){
  test("positional review: "+scenario.instructions+" / "+scenario.name+" / "+scenario.nth,()=>{
    const definition={schemaVersion:1,id:"position",title:"Position",version:1,steps:[
      {id:"open",description:"Open",action:{kind:"navigate",url:"/"}},
      {id:"choose",description:"Click "+scenario.name,action:{kind:"click",target:{by:"role",role:"button",name:scenario.name,...(scenario.nth===undefined?{}:{nth:scenario.nth})}}},
      {id:"verify",description:"Verify",action:{kind:"assert-visible",target:{by:"text",value:"Ready"},provenance:"requirements"}}
    ]};
    const before=structuredClone(definition);
    const warnings=draftQualityWarnings(scenario.instructions,definition,snapshot);
    assert.equal(warnings.some(w=>/Step 2:.*position/i.test(w)),scenario.warn);
    assert.deepEqual(definition,before);
  });
}
