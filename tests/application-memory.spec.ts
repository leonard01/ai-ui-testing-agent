import { test, expect } from "@playwright/test";
import { createReviewServer } from "../src/review-server.js";
import { observeSuccessfulRun } from "../src/application-memory.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const site = "http://127.0.0.1:3000";
let server: Server;
let dataDir: string;
let reviewURL: string;
let providerPrompt = "";

test.beforeEach(async ({browser}) => {
  dataDir = await mkdtemp(join(tmpdir(),"app-memory-web-"));
  const fixture = JSON.parse(await readFile("examples/add-task.json","utf8"));
  const mock = async ({prompt}: {prompt:string}) => {
    providerPrompt = prompt;
    return JSON.stringify({
      ...fixture,
      steps:fixture.steps.map((step:{action:{provenance?:string}}) =>
        step.action.provenance === "human-confirmed"
          ? {...step,action:{...step.action,provenance:"inferred"}} : step),
    });
  };
  server = await createReviewServer(dataDir,browser,mock);
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  reviewURL = "http://127.0.0.1:"+(server.address() as AddressInfo).port;
  providerPrompt = "";
});
test.afterEach(async()=>{
  server.closeAllConnections();
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  await rm(dataDir,{recursive:true,force:true});
});

async function teachWebsite(){
  const steps = [
    {id:"open",description:"Open website",action:{kind:"navigate",url:site}},
    {id:"username",description:"Fill username",action:{kind:"fill",target:{by:"label",value:"Username"},value:"user"}},
    {id:"password",description:"Fill password",action:{kind:"fill",target:{by:"label",value:"Password"},value:"SECRET"}},
    {id:"login",description:"Click login",action:{kind:"click",target:{by:"role",role:"button",name:"Login"}}},
    {id:"cart",description:"Add multiple items to basket",action:{kind:"click",target:{by:"role",role:"button",name:"Add to cart"}}},
    {id:"verify",description:"Verify basket",action:{kind:"assert-visible",target:{by:"text",value:"Basket"},provenance:"requirements"}},
  ];
  const definition = {schemaVersion:1,id:"cart-test",title:"Shop after login",version:1,steps} as any;
  const report = {
    schemaVersion:1,testId:null,title:"Shop after login",status:"passed",startedAt:new Date().toISOString(),
    durationMs:1250,steps:steps.map(step=>({
      id:step.id,description:step.description,status:"passed",durationMs:25,
    })),artifacts:{},evidenceErrors:[],
  } as any;
  await observeSuccessfulRun(dataDir,site,definition,report);
}

test("website knowledge is visibly suggested but user may turn it off before generation",async({page})=>{
  await teachWebsite();
  await page.goto(reviewURL);
  await page.getByLabel("Your test instructions").fill("add multiple items to basket");
  await page.getByRole("button",{name:"Check known prerequisites"}).click();
  await expect(page.locator("#application-memory-status")).toContainText("previous passing shopping test",{ignoreCase:true});
  await page.getByLabel("Generate with").selectOption("groq");
  await page.getByRole("button",{name:"Generate draft"}).click();
  await expect(page.locator("#generation-status")).toContainText("Draft ready");
  expect(providerPrompt).toContain("HISTORICAL WEBSITE PREREQUISITE SUGGESTIONS");
  await expect(page.locator("#application-memory-status")).toContainText("logged in first");
  await page.getByLabel("Use successful-test knowledge from this website").uncheck();
  await page.getByRole("button",{name:"Generate draft"}).click();
  await expect(page.locator("#generation-status")).toContainText("Draft ready");
  expect(providerPrompt).not.toContain("HISTORICAL WEBSITE PREREQUISITE SUGGESTIONS");
});

test("unknown website or non-shopping instructions do not gain prerequisite hints",async({page})=>{
  await teachWebsite();
  await page.goto(reviewURL);
  await page.getByLabel("Your test instructions").fill("Check heading is visible");
  await page.getByRole("button",{name:"Check known prerequisites"}).click();
  await expect(page.locator("#application-memory-status")).toContainText("No matching prerequisite");
  const response = await page.request.get(reviewURL+"/api/application-memory?"+
    new URLSearchParams({baseURL:"https://other.test",instructions:"add items to basket"}));
  expect(response.ok()).toBe(true);
  expect((await response.json()).suggestions).toEqual([]);
});
