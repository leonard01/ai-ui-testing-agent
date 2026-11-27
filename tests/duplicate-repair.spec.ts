import { selectSavedScript } from "./helpers/select-saved-script.js";
import { test, expect, type Browser, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReviewServer } from "../src/review-server.js";
import { approvedPath } from "./helpers/saved-files.js";

test.use({ trace: "off" });

const duplicateButtons = `<!doctype html>
<html lang="en"><head><title>Duplicate controls demo</title></head>
<body>
  <button id="add">Add Element</button><section id="buttons"></section>
  <script>
    document.querySelector("#add").addEventListener("click", () => {
      const button = document.createElement("button");
      button.textContent = "Delete";
      button.addEventListener("click", () => button.remove());
      document.querySelector("#buttons").append(button);
    });
  </script>
</body></html>`;

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return "http://127.0.0.1:" + (server.address() as AddressInfo).port;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()));
}

for (const nth of [0, 1]) {
  test("human-selected duplicate Delete button " + (nth + 1) +
    " is saved as an indexed role locator and reruns successfully", async ({ browser, page }) => {
    const dir = await mkdtemp(join(tmpdir(), "duplicate-repair-"));
    const targetServer = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(duplicateButtons);
    });
    let review: Server | undefined;
    try {
      const websiteURL = await listen(targetServer);
      review = await createReviewServer(dir, browser);
      const reviewURL = await listen(review);

      const definition = {
        schemaVersion: 1, id: "remove-one", title: "Add twice, delete once", version: 1,
        steps: [
          { id: "open", description: "Open demo", action: { kind: "navigate", url: "/" } },
          { id: "add-first", description: "Add first button", action: {
            kind: "click", target: { by: "role", role: "button", name: "Add Element" },
          } },
          { id: "add-second", description: "Add second button", action: {
            kind: "click", target: { by: "role", role: "button", name: "Add Element" },
          } },
          { id: "two-buttons", description: "Two Delete buttons are shown", action: {
            kind: "assert-count", target: { by: "role", role: "button", name: "Delete" },
            expected: 2, provenance: "requirements",
          } },
          { id: "delete", description: "Click one Delete button", action: {
            kind: "click", target: { by: "intent", value: "Delete", role: "button" },
          } },
          { id: "one-button", description: "One Delete button remains", action: {
            kind: "assert-count", target: { by: "role", role: "button", name: "Delete" },
            expected: 1, provenance: "requirements",
          } },
        ],
      };
      const savedResponse = await page.request.post(reviewURL + "/api/save", {
        data: { testName: "Regression test", definition, baseURL: websiteURL },
      });
      expect(savedResponse.status()).toBe(200);
      const saved = await savedResponse.json();

      await page.goto(reviewURL);
      await selectSavedScript(page, saved.id);
      await expect(page.locator("#execution-url")).toHaveValue(websiteURL + "/");
      await page.getByRole("button", { name: "Run selected test" }).click();
      await expect(page.locator("#run-status"))
        .toContainText("Run complete", { timeout: 25000 });
      await expect(page.locator("#run-summary")).toContainText("FAILED");

      const repair = page.locator(".repair-choice");
      await expect(repair).toBeVisible();
      await expect(repair.locator(".repair-option")).toHaveCount(2);
      await expect(repair.locator(".repair-option").nth(0)).toContainText("match 1 of 2");
      await expect(repair.locator(".repair-option").nth(1)).toContainText("match 2 of 2");
      await repair.locator(".repair-option").nth(nth).locator("input").check();
      await expect(repair.getByRole("button", { name: "Save corrected copy and rerun from start" }))
        .toBeEnabled();
      await expect(repair.locator(".repair-feedback")).toContainText(
        "match " + (nth + 1) + " using current page order");

      const firstReport = await page.getByRole("link", { name: "View full JSON report" })
        .getAttribute("href");
      if (!firstReport) throw new Error("Missing original report");
      const initial = await (await page.request.get(reviewURL + firstReport)).json();
      const failed = initial.steps.find((step: {id: string}) => step.id === "delete");
      expect(failed.ambiguity.candidates.map((candidate: {nth: number}) => candidate.nth))
        .toEqual([0, 1]);

      await repair.getByRole("button", {
        name: "Save corrected copy and rerun from start",
      }).click();
      await expect(page.locator("#run-status"))
        .toContainText("Run complete", { timeout: 25000 });
      await expect(page.locator("#run-summary")).toContainText("PASSED");

      const revisedId = await page.locator("#execution-panel").getByLabel("Test", { exact: true }).inputValue();
      expect(revisedId).not.toBe(saved.id);
      const corrected = JSON.parse(await readFile(await approvedPath(dir, revisedId), "utf8"));
      expect(corrected.steps[4].action.target).toEqual({
        by: "role", role: "button", name: "Delete", nth,
      });
      expect(corrected.steps[5].action.expected).toBe(1);
      expect((await page.request.get(reviewURL + "/api/tests/" + saved.id)).status())
        .toBe(404);

      const exportURL = reviewURL + "/api/tests/" + revisedId +
        "/export.ts?baseURL=" + encodeURIComponent(websiteURL);
      const exported = await page.request.get(exportURL);
      expect(exported.status()).toBe(200);
      expect(await exported.text()).toContain(
        'page.getByRole("button", { name: "Delete", exact: true }).nth(' + nth + ')');
    } finally {
      if (review) await close(review);
      await close(targetServer);
      await rm(dir, { recursive: true, force: true });
    }
  });
}


for (const kind of ["link", "unnamed"] as const) {
  test("verified " + kind + " action suggestion can be selected and rerun through UI", async ({ browser, page }) => {
    const dir = await mkdtemp(join(tmpdir(), "verified-repair-"));
    const html = kind === "link"
      ? '<main><a href="#profile">View profile</a><a href="#logout" onclick="document.getElementById(\'status\').textContent=\'Done\'">Logout</a><p id="status" role="status">Pending</p></main>'
      : '<main><button id="submit_search" onclick="document.getElementById(\'status\').textContent=\'Done\'"></button><button id="subscribe" onclick="document.getElementById(\'status\').textContent=\'Wrong\'"></button><p id="status" role="status">Pending</p></main>';
    const targetServer = createServer((_req,res)=>{res.writeHead(200,{"Content-Type":"text/html"});res.end(html);});
    let review: Server | undefined;
    try {
      const websiteURL=await listen(targetServer);
      review=await createReviewServer(dir,browser);
      const reviewURL=await listen(review);
      const definition={
        schemaVersion:1,id:"verified-action",title:"Verified action repair",version:1,
        steps:[
          {id:"open",description:"Open demo",action:{kind:"navigate",url:"/"}},
          {id:"click",description:kind==="link"?"Log out":"Submit search",action:{kind:"click",target:kind==="link"?{by:"role",role:"button",name:"Logout"}:{by:"role",role:"button"}}},
          {id:"verify",description:"Verify outcome",action:{kind:"assert-text",target:{by:"role",role:"status"},expected:"Done",provenance:"requirements"}},
        ],
      };
      const savedResponse=await page.request.post(reviewURL+"/api/save",{data:{testName:"Verified repair",definition,baseURL:websiteURL}});
      expect(savedResponse.status()).toBe(200);
      const saved=await savedResponse.json();
      await page.goto(reviewURL);
      await selectSavedScript(page,saved.id);
      await page.getByRole("button",{name:"Run selected test"}).click();
      await expect(page.locator("#run-status")).toContainText("Run complete",{timeout:25000});
      await expect(page.locator("#run-summary")).toContainText("FAILED");
      const repair=page.locator(".locator-repair");
      await expect(repair).toBeVisible();
      const option=repair.locator(".locator-option").filter({hasText:kind==="link"?"Logout":"submit_search"});
      await expect(option).toHaveCount(1);
      await option.locator("input").check();
      const save=repair.getByRole("button",{name:"Save corrected locator and rerun from start"});
      await expect(save).toBeEnabled();
      await save.click();
      await expect(page.locator("#run-status")).toContainText("Run complete",{timeout:25000});
      await expect(page.locator("#run-summary")).toContainText("PASSED");
      const revisedId=await page.locator("#execution-panel").getByLabel("Test",{exact:true}).inputValue();
      const corrected=JSON.parse(await readFile(await approvedPath(dir,revisedId),"utf8"));
      expect(corrected.steps[1].action.target).toEqual(kind==="link"?{by:"css",value:'a[href="#logout"]'}:{by:"id",value:"submit_search"});
      expect(corrected.steps[2].action).toEqual(definition.steps[2].action);
    } finally {
      if(review) await close(review);
      await close(targetServer);
      await rm(dir,{recursive:true,force:true});
    }
  });
}
