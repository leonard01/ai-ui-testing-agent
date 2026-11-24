import { test, expect } from "@playwright/test";
import { createReviewServer } from "../src/review-server.js";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

let server: Server;
let directory: string;
let url: string;
const baseURL = "http://127.0.0.1:3000";
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "review-api-boundaries-"));
  server = await createReviewServer(directory);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  url = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});
test.afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve,reject) => server.close(e => e ? reject(e) : resolve()));
  await rm(directory,{recursive:true,force:true});
});

const generation = { baseURL, requirements:"Add a task", provider:"fixture" };
for (const [label, override, message] of [
  ["blank URL", {baseURL:" "}, "application URL"],
  ["blank instructions", {requirements:"  "}, "Enter a test instruction"],
  ["oversized instructions", {requirements:"x".repeat(12001)}, "12,000"],
  ["unknown provider", {provider:"unknown"}, "explicit generation provider"],
  ["missing provider", {provider:undefined}, "explicit generation provider"],
] as const) {
  test("generation rejects " + label, async ({request}) => {
    const response = await request.post(url+"/api/generate",{data:{...generation,...override}});
    expect(response.status()).toBe(400);
    const result = await response.json();
    expect(result.error).toContain(message);
    expect(result.definition).toBeUndefined();
  });
}

for (const length of [1,200,201]) {
  test("approved test name length " + length, async ({request}) => {
    const definition = JSON.parse(await readFile("examples/add-task.json","utf8"));
    const response = await request.post(url+"/api/save",{data:{
      baseURL,definition,testName:"x".repeat(length),
    }});
    expect(response.status()).toBe(length<=200?200:400);
    const result = await response.json();
    if(length<=200) {
      expect(result.id).toBeTruthy();
      expect(result.siteUrl).toBe(baseURL);
      expect(result.message).toContain("no test has been executed");
    } else {
      expect(result.error).toContain("Enter a test name");
      expect(result.id).toBeUndefined();
    }
  });
}

for (const [label, ids] of [
  ["empty", []],
  ["duplicate", ["reviewed-example.json","reviewed-example.json"]],
  ["oversized", Array.from({length:11},(_,i)=>"reviewed-"+i+".json")],
  ["path traversal", ["../example.json"]],
] as const) {
  test("suite rejects " + label + " selection", async ({request}) => {
    const response = await request.post(url+"/api/suites",{data:{baseURL,ids}});
    expect(response.status()).toBe(400);
    expect((await response.json()).error).toContain("unique approved saved tests");
  });
}

test("save rejects off-origin navigation without returning an approved ID", async ({request}) => {
  const definition = JSON.parse(await readFile("examples/add-task.json","utf8"));
  definition.steps[0].action.url = "https://example.test/";
  const response = await request.post(url+"/api/save",{data:{baseURL,definition,testName:"Unsafe navigation"}});
  expect(response.status()).toBe(400);
  expect((await response.json()).id).toBeUndefined();
});

test("history deletion requires exact confirmation", async ({request}) => {
  for (const data of [{confirmed:false,confirmationText:"DELETE ALL HISTORY"},
    {confirmed:true,confirmationText:"delete all history"},{confirmed:true}]) {
    const response = await request.post(url+"/api/history/delete-all",{data});
    expect(response.status()).toBe(400);
    expect((await response.json()).error).toContain("Explicit confirmation");
  }
});
