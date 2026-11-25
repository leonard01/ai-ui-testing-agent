import { test, expect } from "@playwright/test";
import { createReviewServer } from "../src/review-server.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";

test("initial generation permits reviewed execution with explicitly acknowledged missing coverage @sanity", async ({browser,page}) => {
  const dir=await mkdtemp(join(tmpdir(),"requirement-preservation-"));
  const fixture={schemaVersion:1,id:"unrelated",title:"Unrelated",version:1,steps:[
    {id:"open",description:"Open",action:{kind:"navigate",url:"/"}},
    {id:"verify",description:"Verify task count",action:{kind:"assert-text",target:{by:"role",role:"status"},expected:"0 tasks, 0 completed",provenance:"inferred"}},
  ]};
  const server=await createReviewServer(dir,browser,async()=>JSON.stringify(fixture));
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const url="http://127.0.0.1:"+(server.address() as AddressInfo).port;
  try {
    await page.goto(url);
    await page.locator("#test-name").fill("Coverage warning");
    await page.getByLabel("Your test instructions").fill("Log in. Verify the cart.");
    await page.getByLabel("Generate with").selectOption("groq");
    await page.getByRole("button",{name:"Generate draft"}).click();
    await expect(page.locator("#draft")).toBeVisible();
    await expect(page.locator("#generation-exception")).toBeHidden();
    await expect(page.locator("#instruction-coverage-blockers")).toContainText("2 requirement mappings need review");
    await page.getByRole("button",{name:"Add All",exact:true}).click();
    await expect(page.locator("#save")).toBeDisabled();
    await page.locator("#accept-coverage-warning").check();
    await expect(page.locator("#save")).toBeEnabled();
    await page.getByRole("button",{name:"Save & Run",exact:true}).click();
    await expect(page.locator("#run-status")).toContainText("Run complete",{timeout:30000});
    await expect(page.locator("#run-coverage-warnings")).toContainText("Log in.");
    await expect(page.locator("#run-coverage-warnings")).toContainText("Verify the cart.");
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

test("AI reinterpretation explains invalidated requirement mappings and allows explicit step association", async ({browser,page}) => {
  const dir=await mkdtemp(join(tmpdir(),"incremental-coverage-review-"));
  const server=await createReviewServer(dir,browser);
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const url="http://127.0.0.1:"+(server.address() as AddressInfo).port;
  const source="Add a task called Review report.\nVerify Review report is visible.";
  const amendment="Verify Review report appears after adding it.";
  const steps=[
    {id:"open",description:"Open task list",action:{kind:"navigate",url:"http://127.0.0.1:3000/"}},
    {id:"fill",description:"Enter Review report",action:{kind:"fill",target:{by:"label",value:"Task"},value:"Review report"}},
    {id:"add",description:"Add task",action:{kind:"click",target:{by:"role",role:"button",name:"Add"}}},
    {id:"verify-old",description:"Verify Review report is present",action:{kind:"assert-visible",target:{by:"text",value:"Review report"},provenance:"requirements"}},
  ];
  const coverageRow=(id:string,text:string,stepIds:string[],issue="")=>({
    id,text,stepIds,issue,interpretation:"Test mapping",confirmed:false,availability:"identified",
  });
  const original={
    schemaVersion:1,id:"task-flow",title:"Task workflow",version:1,steps,
    instructionCoverage:{source,entries:[
      coverageRow("R1","Add a task called Review report.",["fill","add"]),
      coverageRow("R2","Verify Review report is visible.",["verify-old"]),
    ],prerequisiteStepIds:[]},
  };
  const replacement={id:"verify-new",description:"Verify Review report in the task list",
    action:{kind:"assert-visible",target:{by:"text",value:"Review report"},provenance:"requirements"}};
  const revised={
    ...original,steps:[...steps.slice(0,3),replacement],
    instructionCoverage:{source:source+"\n"+amendment,entries:[
      coverageRow("R1","Add a task called Review report.",["fill","add"]),
      {...coverageRow("R2","Verify Review report is visible.",[]),
        issue:"Previous mapping referenced replaced step ID(s): verify-old. Link the revised executable step(s) after review."},
      {...coverageRow("R3",amendment,[]),issue:"New amendment requires explicit coverage review."},
    ],prerequisiteStepIds:[]},
  };
  try {
    await page.route("**/api/generate",route=>route.fulfill({
      status:200,contentType:"application/json",body:JSON.stringify({
        definition:original,needsReview:true,provider:"groq",generationAttempts:1,
        message:"AI-generated draft",memorySuggestions:[],
      }),
    }));
    await page.route("**/api/regenerate-steps",route=>route.fulfill({
      status:200,contentType:"application/json",body:JSON.stringify({
        definition:revised,replacement:[replacement],removed:[steps[3]],
        preservedApprovedStepIds:[],warnings:[
          "Instruction-to-step mappings need explicit review before the revised test can be saved or run.",
        ],generationAttempts:1,
      }),
    }));
    await page.goto(url);
    await page.locator("#test-name").fill("Add and verify task");
    await page.getByLabel("Your test instructions").fill(source);
    await page.getByLabel("Generate with").selectOption("groq");
    await page.getByRole("button",{name:"Generate draft"}).click();
    await expect(page.locator("#instruction-coverage-blockers")).toBeHidden();
    await page.locator("#step-list .step").nth(3).getByRole("button",{name:"Reinterpret with AI"}).click();
    await page.getByLabel("New plain-English instructions for replacement steps").fill(amendment);
    await page.getByRole("button",{name:"Generate replacement"}).click();
    await expect(page.locator("#incremental-status")).toContainText("Proposal ready");
    await expect(page.locator("#incremental-warnings")).toContainText("mappings need explicit review");
    await page.getByRole("button",{name:"Apply proposed steps (unapproved)"}).click();

    const panel=page.locator("#instruction-coverage-blockers");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("2 requirement mappings need review");
    await expect(panel).toContainText("R2 — Verify Review report is visible.");
    await expect(panel).toContainText("verify-old");
    await expect(panel).toContainText("R3 — "+amendment);
    await expect(panel).toContainText("New amendment requires explicit coverage review");
    await expect(page.locator("#draft-dom-wide-summary")).toContainText("1 DOM-wide assertion");
    await page.getByRole("button",{name:"Add All",exact:true}).click();
    await expect(page.getByRole("button",{name:"Save Test"})).toBeDisabled();

    await page.locator("#accept-coverage-warning").check();
    await expect(page.getByRole("button",{name:"Save Test"})).toBeEnabled();
    await expect(panel).toBeVisible();
    await page.locator("#accept-coverage-warning").uncheck();
    const first=panel.locator('[data-requirement-id="R2"]');
    await expect(first.getByRole("button",{name:"Confirm mapping for R2"})).toBeDisabled();
    await first.locator('input[value="verify-new"]').check();
    await first.getByRole("button",{name:"Confirm mapping for R2"}).click();
    await expect(panel).toContainText("1 requirement mapping needs review");
    await expect(page.getByRole("button",{name:"Save Test"})).toBeDisabled();

    const second=panel.locator('[data-requirement-id="R3"]');
    await second.locator('input[value="verify-new"]').check();
    await second.getByRole("button",{name:"Confirm mapping for R3"}).click();
    await expect(panel).toBeHidden();
    await expect(page.locator("#draft-dom-wide-summary")).toContainText("1 DOM-wide assertion");
    await expect(page.getByRole("button",{name:"Save Test"})).toBeEnabled();
    await page.getByRole("button",{name:"Save Test"}).click();
    await expect(page.locator("#saved")).toContainText("Saved and ready to execute");
    const saved=(await (await page.request.get(url+"/api/tests")).json()).tests;
    expect(saved).toHaveLength(1);
    const savedCase=(await (await page.request.get(url+"/api/tests/"+encodeURIComponent(saved[0].id))).json()).definition;
    expect(savedCase.instructionCoverage.entries.map((r:{stepIds:string[]})=>r.stepIds))
      .toEqual([["fill","add"],["verify-new"],["verify-new"]]);
    expect(savedCase.instructionCoverage.entries.slice(1).every((r:{confirmed:boolean,issue:string})=>r.confirmed&&!r.issue)).toBe(true);
    expect(savedCase.instructionCoverage.source).toBe(source+"\n"+amendment);
  }finally{
    server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await rm(dir,{recursive:true,force:true});
  }
});
