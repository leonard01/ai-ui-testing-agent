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
    await page.getByLabel("Your test instructions").fill(requirements);
    await page.getByLabel("Generate with").selectOption("groq");
    await page.getByRole("button",{name:"Generate draft"}).click();
    await expect(page.locator("#exception-count")).toContainText("3 of 3");
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
