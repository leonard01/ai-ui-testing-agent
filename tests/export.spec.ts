import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createReviewServer } from "../src/review-server.js";
import { generatePlaywrightSpec } from "../src/export.js";
import { runTest } from "../src/runner.js";
import type { TestDefinition } from "../src/domain.js";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

test.use({ trace: "off" });
const execute = promisify(execFile);
const baseURL = "http://127.0.0.1:3000";

async function example(): Promise<TestDefinition> {
  return JSON.parse(await readFile("examples/add-task.json", "utf8")) as TestDefinition;
}

function withIntent(original: TestDefinition): TestDefinition {
  const definition = structuredClone(original);
  definition.steps[2].action = {
    kind: "fill", target: { by: "intent", value: "Task", role: "textbox" },
    value: "Prepare interview",
  };
  definition.steps[3].action = {
    kind: "click", target: { by: "intent", value: "Add", role: "button" },
  };
  definition.steps[5].action = {
    kind: "check", target: { by: "intent", value: "Complete Prepare interview", role: "checkbox" },
  };
  definition.steps[7].action = {
    kind: "click", target: { by: "intent", value: "Delete Prepare interview", role: "button" },
  };
  return definition;
}

async function executePortable(source: string, resultsDir: string, environmentURL = baseURL) {
  // Playwright skips the repository's ignored test-results directory when
  // collecting tests. Generate the independent spec under tests/ instead,
  // with a unique folder and clean it up immediately after the child run.
  const dir = await mkdtemp(join(resolve("tests"), "portable-export-"));
  try {
    const spec = join(dir, "independent.spec.ts");
    const config = join(dir, "playwright.config.cjs");
    await writeFile(spec, source);
    await writeFile(config, [
      "module.exports = {",
      "  testDir: " + JSON.stringify(dir) + ",",
      "  outputDir: " + JSON.stringify(resultsDir) + ",",
      '  testMatch: "**/independent.spec.ts",',
      "  workers: 1,",
      '  reporter: "line",',
      '  use: { browserName: "chromium" },',
      "};",
      "",
    ].join("\n"));
    return await execute(process.execPath, [
      resolve("node_modules/@playwright/test/cli.js"), "test", "--config", config,
    ], { cwd: process.cwd(), timeout: 40_000, env: { ...process.env, TEST_BASE_URL: environmentURL } });
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

test("portable TypeScript passes in a separate Playwright process with live intent targets", async ({}, info) => {
  const source = generatePlaywrightSpec(withIntent(await example()), {
    baseURL, timeoutMs: 1500,
  });
  expect(source).toContain('import { test, expect, type Page, type Locator } from "@playwright/test";');
  expect(source).toContain("async function intentLocator(");
  expect(source).toContain("await target.check()");
  expect(source).not.toMatch(/from\s+["'][^"']*(?:src\/|ai-ui-testing-agent)[^"']*["']/);
  expect(source).not.toContain("GROQ_API_KEY");
  const result = await executePortable(source, info.outputPath("portable"));
  expect(result.stdout + result.stderr).toMatch(/1 passed/);
});

test("portable export selects the correct product-scoped Add to cart button", async ({}, info) => {
  const fixture: Server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end('<!doctype html><main>' +
      '<article><div>Sauce Labs Bike Light</div><button onclick="document.getElementById(\'cart\').textContent=\'Sauce Labs Bike Light\'">Add to cart</button></article>' +
      '<article><div>Sauce Labs Backpack</div><button onclick="document.getElementById(\'cart\').textContent=\'Sauce Labs Backpack\'">Add to cart</button></article>' +
      '<div role="status" aria-label="Cart" id="cart">empty</div>' +
      '</main>');
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + (fixture.address() as AddressInfo).port;
  try {
    const definition: TestDefinition = {
      schemaVersion: 1, id: "portable-cart", title: "Scoped cart action",
      version: 1, steps: [
        { id: "open", description: "Open", action: { kind: "navigate", url: "/" } },
        { id: "add", description: "Add Sauce Labs Backpack to cart", action: {
          kind: "click", target: { by: "role", role: "button", name: "Add to cart", within: {role:"article",text:"Sauce Labs Backpack"} },
        } },
        { id: "verify", description: "Verify Backpack", action: {
          kind: "assert-text", target: { by: "role", role: "status", name: "Cart" },
          expected: "Sauce Labs Backpack", provenance: "requirements",
        } },
      ],
    };
    const source = generatePlaywrightSpec(definition, { baseURL: url, timeoutMs: 1500 });
    expect(source).not.toContain("async function resolveCartAction(");
    expect(source).toContain('container.getByRole("button", { name: "Add to cart", exact: true })');
    const result = await executePortable(source, info.outputPath("portable-cart"), url);
    expect(result.stdout + result.stderr).toMatch(/1 passed/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      fixture.close((error) => error ? reject(error) : resolve());
      fixture.closeAllConnections();
    });
  }
});

test("exported assertion mismatch fails independently without weakening the expectation", async ({}, info) => {
  const definition = await example();
  const action = definition.steps[1].action;
  if (action.kind !== "assert-text") throw new Error("Expected text assertion");
  action.expected = "Wrong count — must fail";
  const source = generatePlaywrightSpec(definition, { baseURL, timeoutMs: 500 });
  expect(source).toContain("Wrong count — must fail");
  let failure: { code?: string | number; stdout?: string; stderr?: string } | undefined;
  try {
    await executePortable(source, info.outputPath("failure"));
  } catch (error) {
    failure = error as typeof failure;
  }
  expect(failure).toBeDefined();
  expect(failure?.code).toBe(1);
  expect((failure?.stdout ?? "") + (failure?.stderr ?? "")).toMatch(/1 failed/);
});

test("export supports every action, escapes content and permits origin overrides", async () => {
  const definition = await example();
  definition.title = 'Quotes " $(touch never) \n suspicious title';
  definition.steps[0].description = 'Description with "); process.exit(1); //';
  definition.steps[0].action = { kind: "navigate", url: baseURL + "/?scenario=1" };
  definition.steps[1].action = {
    kind: "assert-url", expected: baseURL + "/?scenario=1", provenance: "requirements",
  };
  definition.steps[2].action = {
    kind: "select-option", target: { by: "role", role: "combobox", name: "Shipping" }, value: "fast",
  };
  definition.steps[3].action = {
    kind: "check", target: { by: "role", role: "checkbox", name: "Terms" },
  };
  definition.steps[4].action = {
    kind: "uncheck", target: { by: "label", value: "Terms" },
  };
  definition.steps[5].action = {
    kind: "press", target: { by: "role", role: "textbox", name: "Command" }, key: "Enter",
  };
  definition.steps[6].action = {
    kind: "assert-count", target: { by: "role", role: "button", name: "Save" },
    expected: 0, provenance: "inferred",
  };
  definition.steps[7].action = {
    kind: "assert-visible", target: { by: "text", value: "Ready" }, provenance: "human-confirmed",
  };
  definition.steps[8].action = {
    kind: "click", target: { by: "role", role: "button", name: "Finish" },
  };
  const source = generatePlaywrightSpec(definition, { baseURL, timeoutMs: 1000 });
  expect(source).toContain('await target.selectOption("fast")');
  expect(source).toContain("await target.check()");
  expect(source).toContain("await target.uncheck()");
  expect(source).toContain('await target.press("Enter")');
  expect(source).toContain("await expect(target).toHaveCount(0");
  expect(source).toContain('toHaveURL(sameOriginURL("/?scenario=1")');
  expect(source).not.toContain('sameOriginURL("http://127.0.0.1:3000/?scenario=1")');
  expect(source).toContain("Assertion provenance: inferred");
  expect(source).toContain(JSON.stringify(definition.title));
  expect(source).toContain(JSON.stringify("1. " + definition.steps[0].description));
  expect(source.match(/^import .*from/gm)).toHaveLength(1);
  expect(source).not.toContain("async function intentLocator");
});

test("export rejects cross-origin URL assertions, navigation and malformed input", async () => {
  const definition = await example();
  expect(() => generatePlaywrightSpec(definition, { baseURL: "file:///tmp/site" })).toThrow();
  const changed = structuredClone(definition);
  changed.steps[0].action = { kind: "navigate", url: "https://unrelated.example/" };
  expect(() => generatePlaywrightSpec(changed, { baseURL })).toThrow(/origin/);
  changed.steps[0].action = { kind: "navigate", url: "/" };
  changed.steps[1].action = {
    kind: "assert-url", expected: "https://unrelated.example/path", provenance: "requirements",
  };
  expect(() => generatePlaywrightSpec(changed, { baseURL })).toThrow(/origin/);
  expect(() => generatePlaywrightSpec(definition, { baseURL, timeoutMs: -1 })).toThrow(/timeout/);
  expect(() => generatePlaywrightSpec({ schemaVersion: 1, steps: [] }, { baseURL })).toThrow();
});

test("CLI exports a standalone spec without starting a browser", async ({}, info) => {
  const target = info.outputPath("cli-export.spec.ts");
  const result = await execute(process.execPath, [
    "dist/cli.js", "export", "examples/add-task.json",
    "--base-url", baseURL, "--output", target,
  ], { cwd: process.cwd(), timeout: 10000 });
  expect(result.stdout).toContain("Exported standalone Playwright TypeScript");
  const source = await readFile(target, "utf8");
  expect(source).toContain('test("Add, complete and delete a task"');
  expect(source).not.toContain('from "./runner.js"');
});

test("review UI exports only approved saved tests and never creates an extra file @sanity", async ({ browser, page }) => {
  const dir = await mkdtemp(join(tmpdir(), "review-export-"));
  const server: Server = await createReviewServer(dir, browser);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  try {
    await page.goto(url);
    const link = page.getByRole("link", { name: "Export Playwright (.spec.ts)" });
    await expect(link).toBeHidden();
    await page.locator("#test-name").fill("Add, complete and delete a task");
    await page.getByLabel("Your test instructions").fill("Create a task and then remove it.");
    await page.getByLabel("Generate with").selectOption("fixture");
    await page.getByRole("button", { name: "Generate draft" }).click();
    await expect(page.locator(".step")).toHaveCount(9);
    await expect(link).toBeHidden();
    for (const checkbox of await page.locator(".step input[type=checkbox]").all()) {
      await checkbox.check();
    }
    await page.locator("#save-test-name").fill("Add, complete and delete a task");
    await page.getByRole("button", { name: "Save Test" }).click();
    await expect(page.locator("#saved")).toContainText("Saved and ready to execute");
    await page.locator("#nav-run").click();
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    if (!href) throw new Error("Download link was not generated");
    expect(href).toMatch(/^\/api\/tests\/reviewed-\d{13}-[a-f0-9]{8}\.json\/export\.ts\?/);
    const response = await fetch(url + href);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(/attachment; filename="reviewed-.*\.spec\.ts"/);
    const contents = await response.text();
    expect(contents).toContain('import { test, expect');
    const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
    expect(download.suggestedFilename()).toMatch(/^reviewed-\d{13}-[a-f0-9]{8}\.spec\.ts$/);
    const invalid = await fetch(url + href.replace(/timeoutMs=5000/, "timeoutMs=-20"));
    expect(invalid.status).toBe(400);
    const missing = await fetch(url +
      "/api/tests/reviewed-1700000000000-deadbeef.json/export.ts?baseURL=" +
      encodeURIComponent(baseURL));
    expect(missing.status).toBe(400);
    const wrongOrigin = await fetch(url + href.replace(
      encodeURIComponent(baseURL), encodeURIComponent("file:///tmp/private")));
    expect(wrongOrigin.status).toBe(400);
    const files = await readdir(dir);
    expect(files.filter((name) => name.endsWith(".spec.ts"))).toHaveLength(0);
  } finally {
    // Browser pages may leave keep-alive HTTP connections open; close them so
    // the temporary test server does not hang until the Playwright timeout.
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close((err) => err ? reject(err) : done()));
    await rm(dir, { force: true, recursive: true });
  }
});

test("portable export uses toContainText only when comparison mode is contains", async () => {
  const definition = await example();
  const action = definition.steps[1].action;
  if (action.kind !== "assert-text") throw new Error("Text assertion fixture required");
  action.expected = "tasks, 0 completed";
  action.match = "contains";
  const contains = generatePlaywrightSpec(definition, { baseURL, timeoutMs: 1500 });
  expect(contains).toContain('await expect(target).toContainText("tasks, 0 completed"');
  action.match = "exact";
  const exact = generatePlaywrightSpec(definition, { baseURL, timeoutMs: 1500 });
  expect(exact).toContain('await expect(target).toHaveText("tasks, 0 completed"');
});


for (const visible of [true,false]) {
  test("portable existential visibility "+(visible?"passes on a later visible match":"rejects all hidden matches"),async({},info)=>{
    const fixture=createServer((_req,res)=>{
      res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
      res.end('<!doctype html><main><p hidden>Record found</p><p id="later" hidden>Record found</p>'+
        (visible?'<script>setTimeout(()=>document.getElementById("later").hidden=false,250)</script>':'')+'</main>');
    });
    await new Promise<void>(done=>fixture.listen(0,"127.0.0.1",done));
    const url="http://127.0.0.1:"+(fixture.address() as AddressInfo).port;
    try {
      const definition:TestDefinition={schemaVersion:1,id:"portable-visible",title:"Visibility",version:1,steps:[
        {id:"open",description:"Open",action:{kind:"navigate",url:"/"}},
        {id:"verify",description:"Verify record is visible",action:{kind:"assert-visible",target:{by:"text",value:"Record found"},provenance:"requirements"}},
      ]};
      const source=generatePlaywrightSpec(definition,{baseURL:url,timeoutMs:1000});
      if(visible){
        const result=await executePortable(source,info.outputPath("portable-visible"),url);
        expect(result.stdout+result.stderr).toMatch(/1 passed/);
      }else{
        let failure:{code?:string|number;stdout?:string;stderr?:string}|undefined;
        try {await executePortable(source,info.outputPath("portable-hidden"),url);}
        catch(error){failure=error as typeof failure;}
        expect(failure?.code).toBe(1);
        expect((failure?.stdout??"")+(failure?.stderr??"")).toMatch(/1 failed/);
      }
    }finally{
      fixture.closeAllConnections();
      await new Promise<void>((done,reject)=>fixture.close(error=>error?reject(error):done()));
    }
  });
}


for(const scenario of [
  {label:"exact rejects extra result text",html:'<article data-testid="search-result">Running shoes</article>',match:"exact",passes:false},
  {label:"contains rejects wrong case",html:'<article data-testid="search-result">Running SHOES</article>',match:"contains",passes:false},
  {label:"exact accepts exact result text",html:'<article data-testid="search-result">shoes</article>',match:"exact",passes:true},
  {label:"scoped table data",html:'<section aria-label="Search results"><table><tbody><tr><td>Running shoes</td></tr></tbody></table></section>',passes:true},
  {label:"repeated generic records",html:'<section aria-label="Search results"><div><div><h3>Boots</h3><a href="/1">Details</a></div><div><h3>Running shoes</h3><a href="/2">Details</a></div></div></section>',passes:true},
  {label:"hidden matching text",html:'<section aria-label="Search results"><article data-testid="search-result">Boots<span hidden>shoes</span></article></section>',passes:false},
  {label:"query outside records",html:'<section aria-label="Search results"><h2>Results for shoes</h2><table><thead><tr><th>Shoes</th></tr></thead><tbody><tr><td>Boots</td></tr></tbody></table></section>',passes:false},
] as const){
  test("portable scoped result assertion: "+scenario.label,async({browser},info)=>{
    const fixture=createServer((_req,res)=>{
      res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
      res.end('<!doctype html><main>'+scenario.html+'</main>');
    });
    await new Promise<void>(done=>fixture.listen(0,"127.0.0.1",done));
    const url="http://127.0.0.1:"+(fixture.address() as AddressInfo).port;
    try{
      const definition:TestDefinition={schemaVersion:1,id:"portable-results",title:"Scoped results",version:1,steps:[
        {id:"open",description:"Open",action:{kind:"navigate",url:"/"}},
        {id:"verify",description:"Verify returned result contains shoes",action:{
          kind:"assert-text",target:{by:"text",value:"shoes"},expected:"shoes",match:"match" in scenario ? scenario.match : "contains",scope:"search-results",provenance:"requirements",
        }},
      ]};
      const report=await runTest(definition,{baseURL:url,timeoutMs:800,outputDir:info.outputPath("runner-results")},browser);
      const source=generatePlaywrightSpec(definition,{baseURL:url,timeoutMs:1000});
      if(scenario.passes){
        const result=await executePortable(source,info.outputPath("portable-results"),url);
        expect(result.stdout+result.stderr).toMatch(/1 passed/);
      }else{
        let failure:{code?:string|number;stdout?:string;stderr?:string}|undefined;
        try{await executePortable(source,info.outputPath("portable-results"),url);}
        catch(error){failure=error as typeof failure;}
        expect(failure?.code).toBe(1);
        expect((failure?.stdout??"")+(failure?.stderr??"")).toMatch(/1 failed/);
      }
      expect(report.status,JSON.stringify(report.steps)).toBe(scenario.passes?"passed":"assertion-failed");
    }finally{
      fixture.closeAllConnections();
      await new Promise<void>((done,reject)=>fixture.close(error=>error?reject(error):done()));
    }
  });
}


for(const scenario of [
  {label:"hidden target",html:'<p id="message" hidden>Payment successful</p>',match:"exact",passes:false},
  {label:"hidden descendant",html:'<p id="message">Payment pending<span hidden>Payment successful</span></p>',match:"contains",passes:false},
  {label:"visible target with hidden diagnostic",html:'<p id="message">Payment successful<span hidden>Internal diagnostic</span></p>',match:"exact",passes:true},
] as const){
  test("portable visible text assertion: "+scenario.label,async({},info)=>{
    const fixture=createServer((_req,res)=>{
      res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
      res.end('<!doctype html><main>'+scenario.html+'</main>');
    });
    await new Promise<void>(done=>fixture.listen(0,"127.0.0.1",done));
    const url="http://127.0.0.1:"+(fixture.address() as AddressInfo).port;
    try{
      const definition:TestDefinition={schemaVersion:1,id:"portable-visible-text",title:"Visible text",version:1,steps:[
        {id:"open",description:"Open",action:{kind:"navigate",url:"/"}},
        {id:"verify",description:"Verify visible payment successful text",action:{
          kind:"assert-text",target:{by:"id",value:"message"},expected:"Payment successful",match:scenario.match,provenance:"requirements",
        }},
      ]};
      const source=generatePlaywrightSpec(definition,{baseURL:url,timeoutMs:1000});
      expect(source).toContain("useInnerText: true");
      expect(source).toContain("await expect(target).toBeVisible(");
      if(scenario.passes){
        const result=await executePortable(source,info.outputPath("portable-visible-text"),url);
        expect(result.stdout+result.stderr).toMatch(/1 passed/);
      }else{
        let failure:{code?:string|number;stdout?:string;stderr?:string}|undefined;
        try{await executePortable(source,info.outputPath("portable-visible-text"),url);}
        catch(error){failure=error as typeof failure;}
        expect(failure?.code).toBe(1);
        const output=(failure?.stdout??"")+(failure?.stderr??"");
        expect(output).toMatch(/1 failed/);
        expect(output).toContain(scenario.label==="hidden target"?"toBeVisible":"toContainText");
      }
    }finally{
      fixture.closeAllConnections();
      await new Promise<void>((done,reject)=>fixture.close(error=>error?reject(error):done()));
    }
  });
}


for (const scenario of [
  {label:"exact button with legacy hint",html:`<button onclick="document.getElementById('status').textContent='Done'">Logout</button>`,policy:"hint",passes:true},
  {label:"legacy hint rejects unique exact link",html:'<a href="#done" onclick="document.getElementById(\'status\').textContent=\'Done\'">Logout</a>',policy:"hint",passes:false},
  {label:"strict role",html:'<a href="#done" onclick="document.getElementById(\'status\').textContent=\'Done\'">Logout</a>',policy:"strict",passes:false},
  {label:"duplicate exact links",html:'<a href="#done" onclick="document.getElementById(\'status\').textContent=\'Done\'">Logout</a><a href="#other">Logout</a>',policy:"hint",passes:false},
  {label:"partial button decoy",html:'<a href="#done">Logout</a><button onclick="document.getElementById(\'status\').textContent=\'Done\'">Logout settings</button>',policy:"strict",passes:false},
] as const) {
  test("portable strict role: "+scenario.label,async({},info)=>{
    const fixture=createServer((_req,res)=>{
      res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
      res.end('<!doctype html><main>'+scenario.html+'<p id="status">Ready</p></main>');
    });
    await new Promise<void>(done=>fixture.listen(0,"127.0.0.1",done));
    const url="http://127.0.0.1:"+(fixture.address() as AddressInfo).port;
    try {
      const definition:TestDefinition={schemaVersion:1,id:"portable-role",title:"Strict role",version:1,steps:[
        {id:"open",description:"Open",action:{kind:"navigate",url:"/"}},
        {id:"click",description:"Click Logout",action:{kind:"click",target:{by:"intent",role:"button",value:"Logout",rolePolicy:scenario.policy}}},
        {id:"verify",description:"Verify Done",action:{kind:"assert-text",target:{by:"id",value:"status"},expected:"Done",provenance:"requirements"}},
      ]};
      const source=generatePlaywrightSpec(definition,{baseURL:url,timeoutMs:1000});
      if(scenario.passes){
        const result=await executePortable(source,info.outputPath("portable-role"),url);
        expect(result.stdout+result.stderr).toMatch(/1 passed/);
      }else{
        let failure:{code?:string|number;stdout?:string;stderr?:string}|undefined;
        try {await executePortable(source,info.outputPath("portable-role"),url);}
        catch(error){failure=error as typeof failure;}
        expect(failure?.code).toBe(1);
        const output=(failure?.stdout??"")+(failure?.stderr??"");
        expect(output).toMatch(/1 failed/);
        expect(output).toContain("Could not resolve intent");
      }
    }finally{
      fixture.closeAllConnections();
      await new Promise<void>((done,reject)=>fixture.close(error=>error?reject(error):done()));
    }
  });
}
