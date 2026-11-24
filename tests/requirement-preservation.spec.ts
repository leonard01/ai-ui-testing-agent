import { test, expect } from "@playwright/test";
import { createReviewServer } from "../src/review-server.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";

test("unrelated valid model response is rejected for explicit login and shopping instructions", async ({browser, page}) => {
  const dir=await mkdtemp(join(tmpdir(),"requirement-preservation-"));
  const fixture=JSON.parse(await readFile("examples/add-task.json","utf8"));
  fixture.steps=fixture.steps.slice(0,2);
  fixture.steps[1].action.provenance="inferred";
  const server=await createReviewServer(dir,browser,async()=>JSON.stringify(fixture));
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const url="http://127.0.0.1:"+(server.address() as AddressInfo).port;
  try {
    const response=await page.request.post(url+"/api/generate",{data:{
      baseURL:"http://127.0.0.1:3000",provider:"groq",useApplicationMemory:false,
      requirements:"Log in using the standard user account.\nAdd Sauce Labs Backpack to cart.\nOpen the shopping cart.\nVerify that the cart contains exactly one item."
    }});
    expect(response.status()).toBe(422);
    const data=await response.json();
    expect(data.error).toContain("Explicit login instruction");
    expect(data.definition).toBeUndefined();
    expect((await (await page.request.get(url+"/api/tests")).json()).tests).toHaveLength(0);
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
