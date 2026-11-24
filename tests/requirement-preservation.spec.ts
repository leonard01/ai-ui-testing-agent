import { test, expect } from "@playwright/test";
import { createReviewServer } from "../src/review-server.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";

test("unrelated valid model response exposes unresolved requirements and cannot be saved", async ({browser, page}) => {
  const dir=await mkdtemp(join(tmpdir(),"requirement-preservation-"));
  const fixture={schemaVersion:1,id:"unrelated",title:"Unrelated",version:1,steps:[
    {id:"open",description:"Open",action:{kind:"navigate",url:"/"}},
    {id:"verify",description:"Verify task count",action:{kind:"assert-text",target:{by:"role",role:"status"},expected:"0 tasks, 0 completed",provenance:"inferred"}},
  ]};
  const server=await createReviewServer(dir,browser,async()=>JSON.stringify(fixture));
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const url="http://127.0.0.1:"+(server.address() as AddressInfo).port;
  try {
    const response=await page.request.post(url+"/api/generate",{data:{
      baseURL:"http://127.0.0.1:3000",provider:"groq",useApplicationMemory:false,
      requirements:"Log in using the standard user account.\nAdd Sauce Labs Backpack to cart.\nOpen the shopping cart.\nVerify that the cart contains exactly one item."
    }});
    expect(response.status()).toBe(200);
    const data=await response.json();
    expect(data.definition.instructionCoverage.entries).toHaveLength(4);
    expect(data.definition.instructionCoverage.entries.every((row:{issue:string,confirmed:boolean})=>row.issue&&!row.confirmed)).toBe(true);
    const save=await page.request.post(url+"/api/save",{data:{definition:data.definition,testName:"Unrelated",baseURL:"http://127.0.0.1:3000"}});
    expect(save.status()).toBe(400);
    expect((await save.json()).error).toContain("Unresolved instruction coverage");
    await page.goto(url);
    await page.getByLabel("Your test instructions").fill("Log in. Add a product to cart. Verify the cart.");
    await page.getByLabel("Generate with").selectOption("groq");
    await page.getByRole("button",{name:"Generate draft"}).click();
    await expect(page.locator("#instruction-coverage-blockers")).toContainText("3 instruction statement(s)");
    await expect(page.locator("#instruction-coverage-list")).toContainText("Log in.");
    await page.getByRole("button",{name:"Add All",exact:true}).click();
    await expect(page.locator("#save")).toBeDisabled();
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await rm(dir,{recursive:true,force:true});
  }
});

test("first-open explanation is dismissible, persists across reload and remains accessible in Help",async({browser,page})=>{
  const dir=await mkdtemp(join(tmpdir(),"welcome-note-"));
  const server=await createReviewServer(dir,browser);
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const url="http://127.0.0.1:"+(server.address() as AddressInfo).port;
  try{
    await page.goto(url);
    const notice=page.locator("#welcome-note");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("non-deterministic");
    await expect(notice).toContainText("without AI");
    await notice.getByRole("button",{name:"Got it"}).click();
    await expect(notice).toBeHidden();
    await page.reload();
    await expect(notice).toBeHidden();
    await page.getByRole("button",{name:"? Help",exact:true}).click();
    await expect(page.locator("#help-dialog")).toContainText("A pass only proves the executed checks passed.");
  }finally{
    server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await rm(dir,{recursive:true,force:true});
  }
});
