import { test, expect } from "@playwright/test";
import { createReviewServer } from "../src/review-server.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";

test("generation exception offers three decisions and never exposes an unmapped draft", async ({browser, page}) => {
  const dir=await mkdtemp(join(tmpdir(),"requirement-preservation-"));
  const fixture={schemaVersion:1,id:"unrelated",title:"Unrelated",version:1,steps:[
    {id:"open",description:"Open",action:{kind:"navigate",url:"/"}},
    {id:"verify",description:"Verify task count",action:{kind:"assert-text",target:{by:"role",role:"status"},expected:"0 tasks, 0 completed",provenance:"inferred"}},
  ]};
  const server=await createReviewServer(dir,browser,async()=>JSON.stringify(fixture));
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const url="http://127.0.0.1:"+(server.address() as AddressInfo).port;
  try {
    const requirements="Log in. Add a product to cart. Verify the cart.";
    for(const proceedUnresolved of [false,true]){
      const response=await page.request.post(url+"/api/generate",{data:{
        baseURL:"http://127.0.0.1:3000",provider:"groq",useApplicationMemory:false,requirements,proceedUnresolved
      }});
      expect(response.status()).toBe(409);
      const data=await response.json();
      expect(data.definition).toBeUndefined();
      expect(data.problematicIds).toEqual(["R1","R2","R3"]);
    }
    await page.goto(url);
    await expect(page.locator("#review-workspace")).toBeHidden();
    await page.locator("#test-name").fill("Requirement preservation 1");
    await page.getByLabel("Your test instructions").fill(requirements);
    await page.getByLabel("Generate with").selectOption("groq");
    await page.getByRole("button",{name:"Generate draft"}).click();
    await expect(page.locator("#exception-count")).toContainText("3 of 3");
    await expect(page.locator("#review-workspace")).toBeVisible();
    await expect(page.locator("#review-workspace #generation-exception")).toBeVisible();
    await expect(page.locator("#placeholder")).toBeHidden();
    await expect(page.locator("#working-drafts-panel")).toBeHidden();
    await expect(page.locator("#draft")).toBeHidden();
    await page.getByRole("button",{name:"Edit test description",exact:true}).click();
    await expect(page.locator("#exception-description")).toHaveValue(requirements);
    await page.getByRole("button",{name:"Edit or delete problematic requirements"}).click();
    await expect(page.locator("#exception-row-R1")).toHaveValue("Log in.");
    await page.locator("#exception-edit-list").getByRole("button",{name:"Delete",exact:true}).first().click();
    await expect(page.locator("#exception-row-R1")).toBeDisabled();
    await page.getByRole("button",{name:"Proceed without changes"}).click();
    await expect(page.locator("#exception-proceed-panel")).toContainText("potential critical test failures");
    await expect(page.locator("#exception-generate-anyway")).toBeDisabled();
    await page.locator("#exception-risk").check();
    await page.locator("#exception-generate-anyway").click();
    await expect(page.locator("#exception-edit-error")).toContainText("Unable to preserve every instruction");
    await expect(page.locator("#draft")).toBeHidden();
    await expect(page.getByLabel("Your test instructions")).toHaveValue(requirements);
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

test("edit/delete and full-description choices revalidate while retaining original instructions",async({browser,page})=>{
  const dir=await mkdtemp(join(tmpdir(),"exception-edits-"));
  const original="Open the task list.\nLog in.\nAdd a product.\nVerify the status.";
  const responses:string[]=[];
  const server=await createReviewServer(dir,browser,async({prompt})=>{
    responses.push(prompt);
    const amended=!prompt.includes('"text":"Log in."')&&!prompt.includes('"text":"Add a product."');
    const steps=[
      {id:"open",description:"Open task list",action:{kind:"navigate",url:"/"}},
      {id:"verify",description:"Verify task status",action:{kind:"assert-text",target:{by:"role",role:"status"},expected:"0 tasks, 0 completed",provenance:"requirements"}},
    ];
    const row=(id:string,stepIds:string[],issue?:string)=>({id,interpretation:"Test mapping",stepIds,...(issue?{issue,availability:"functional-mismatch"}:{availability:"identified"})});
    return JSON.stringify({schemaVersion:1,id:"case",title:"Task status",version:1,steps,coverage:{entries:amended?[row("R1",["open"]),row("R2",["verify"])]:[row("R1",["open"]),row("R2",[],"No login"),row("R3",[],"No products"),row("R4",["verify"])]}});
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const url="http://127.0.0.1:"+(server.address() as AddressInfo).port;
  try{
    for(const mode of ["description","requirements"]){
      await page.goto(url);
      await page.locator("#test-name").fill("Requirement preservation 2");
    await page.getByLabel("Your test instructions").fill(original);
      await page.getByLabel("Generate with").selectOption("groq");
      await page.getByRole("button",{name:"Generate draft"}).click();
      await expect(page.locator("#exception-count")).toContainText("2 of 4");
      if(mode==="description"){
        await page.locator("#exception-edit-desc").click();
        await page.locator("#exception-description").fill("Open the task list.\nVerify the status.");
        await page.locator("#exception-validate-desc").click();
      }else{
        await page.locator("#exception-edit-reqs").click();
        await expect(page.locator("#exception-edit-list textarea")).toHaveCount(2);
        await page.locator("#exception-edit-list").getByRole("button",{name:"Delete",exact:true}).first().click();
        await page.locator("#exception-edit-list").getByRole("button",{name:"Delete",exact:true}).first().click();
        await page.locator("#exception-apply-reqs").click();
      }
      await expect(page.locator("#review-workspace #draft")).toBeVisible();
      await expect(page.locator("#review-workspace")).toBeVisible();
      await expect(page.locator("#generation-exception")).toBeHidden();
      await expect(page.locator("#step-list .step")).toHaveCount(2);
      await expect(page.locator("#instruction-coverage-blockers")).toBeHidden();
      expect(await page.getByLabel("Your test instructions").inputValue()).not.toContain("Log in.");
      await page.locator("#test-name").fill("Exception edit "+mode);
      await page.getByRole("button",{name:"Add All",exact:true}).click();
      await expect(page.locator("#save")).toBeEnabled();
    }
    expect(responses).toHaveLength(4);
  }finally{
    server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await rm(dir,{recursive:true,force:true});
  }
});
