import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveProfile } from "../../scripts/test-profile.mjs";
const G=1024**3;
const pick=(cores,total,free,extra={})=>resolveProfile({cores,totalBytes:total*G,freeBytes:free*G,...extra});
test("low CPU or low total or free RAM uses one worker",()=>{
  for(const [c,t,f] of [[2,16,10],[8,4,4],[8,16,3.99]]) {
    const p=pick(c,t,f); assert.equal(p.workers,1); assert.equal(p.globalTimeout,1800000);
  }
});
test("standard and performance thresholds",()=>{
  assert.equal(pick(4,8,4).workers,2);
  assert.equal(pick(8,16,7.99).workers,2);
  assert.equal(pick(8,16,8).workers,4);
});
test("CI is fixed and overrides are explicit",()=>{
  assert.equal(pick(1,2,1,{ci:true}).profile,"ci");
  assert.equal(pick(16,32,20,{override:"low-spec"}).workers,1);
  assert.equal(pick(1,2,1,{ci:true,override:"performance"}).workers,4);
  assert.throws(()=>pick(4,8,4,{override:"unknown"}),/Invalid TEST_PROFILE/);
});
