import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { runTest } from "../src/runner.js";
import type { TestDefinition, TestAction } from "../src/domain.js";

test.use({ trace: "off" });
let server: Server;
let baseURL: string;
test.beforeEach(async () => {
  server = createServer((req,res) => {
    res.setHeader("Content-Type","text/html; charset=utf-8");
    if(req.url === "/seed") res.setHeader("Set-Cookie","test_session=present; Path=/");
    const cookie = req.headers.cookie?.includes("test_session=present") ? "present" : "absent";
    res.end(`<!doctype html><html><body>
      <p id="cookie">${cookie}</p><p id="storage"></p>
      <p id="hidden" hidden>Invisible match</p>
      <p id="visible">Visible match</p>
      <button onclick="document.querySelector('#clicked').textContent='first'">Choose</button>
      <button onclick="document.querySelector('#clicked').textContent='second'">Choose</button>
      <p id="clicked">neither</p>
      <div class="item">One</div><div class="item">Two</div>
      <div id="dynamic"></div>
      <script>
      if(location.pathname==='/seed') {localStorage.setItem('test','stored');sessionStorage.setItem('test','stored');}
      document.querySelector('#storage').textContent=(localStorage.getItem('test')||'absent')+'/'+(sessionStorage.getItem('test')||'absent');
      setTimeout(()=>document.querySelector('#dynamic').textContent='Ready',150);
      </script></body></html>`);
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  baseURL="http://127.0.0.1:"+(server.address() as AddressInfo).port;
});
test.afterEach(async()=>{
  server.closeAllConnections();
  await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
});
function definition(actions: TestAction[], path="/"): TestDefinition {
  return {schemaVersion:1,id:"assertions",title:"Assertions",version:1,
    steps:[{id:"open",description:"Open",action:{kind:"navigate",url:path}},
      ...actions.map((action,i)=>({id:"step-"+i,description:action.kind,action}))]};
}
const visible=(value:string): TestAction=>({kind:"assert-visible",target:{by:"id",value},provenance:"requirements"});
const text=(value:string,expected:string): TestAction=>({kind:"assert-text",target:{by:"id",value},expected,provenance:"requirements"});
const count=(expected:number): TestAction=>({kind:"assert-count",target:{by:"css",value:".item"},expected,provenance:"requirements"});

for(const [label,action,status] of [
  ["visible element",visible("visible"),"passed"],
  ["hidden element",visible("hidden"),"assertion-failed"],
  ["missing element",visible("missing"),"execution-error"],
  ["two matching elements",count(2),"passed"],
  ["incorrect count",count(1),"assertion-failed"],
  ["delayed text",text("dynamic","Ready"),"passed"],
  ["URL query mismatch",{kind:"assert-url",expected:"/?q=missing",provenance:"requirements"},"assertion-failed"],
] as const){
  test("assertion verdict: "+label,async({browser},info)=>{
    const report=await runTest(definition([action]),{baseURL,outputDir:info.outputPath("run"),timeoutMs:1000},browser);
    expect(report.status,JSON.stringify(report.steps)).toBe(status);
    expect(report.steps[1].status).toBe(status);
  });
}
test("ambiguous action never clicks either candidate and skips later assertions",async({browser},info)=>{
  const report=await runTest(definition([
    {kind:"click",target:{by:"role",role:"button",name:"Choose"}},
    text("clicked","neither"),
  ]),{baseURL,outputDir:info.outputPath("ambiguous"),timeoutMs:500},browser);
  expect(report.status).toBe("execution-error");
  expect(report.steps[1].status).toBe("execution-error");
  expect(report.steps[2].status).toBe("skipped");
});
test("explicit indexed action selects the second candidate",async({browser},info)=>{
  const report=await runTest(definition([
    {kind:"click",target:{by:"role",role:"button",name:"Choose",nth:1}},
    text("clicked","second"),
  ]),{baseURL,outputDir:info.outputPath("indexed"),timeoutMs:1000},browser);
  expect(report.status,JSON.stringify(report.steps)).toBe("passed");
});
test("cookies and browser storage do not leak between independent runs",async({browser},info)=>{
  const first=await runTest(definition([text("storage","stored/stored")],"/seed"),{baseURL,outputDir:info.outputPath("seed"),timeoutMs:1000},browser);
  expect(first.status).toBe("passed");
  const second=await runTest(definition([text("cookie","absent"),text("storage","absent/absent")]),{baseURL,outputDir:info.outputPath("fresh"),timeoutMs:1000},browser);
  expect(second.status,JSON.stringify(second.steps)).toBe("passed");
});
