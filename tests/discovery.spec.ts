import { expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { runTest } from "../src/runner.js";
import { discoverTarget, findAssertionAlternatives, findLocatorAlternatives } from "../src/discovery.js";
import type { TestDefinition } from "../src/domain.js";

test.use({ trace: "off" });

const pageHtml = [
  '<!doctype html><html><body><main>',
  '<h1>User administration</h1>',
  '<button id="btn_7">Create user</button>',
  '<div id="panel"></div><ul id="users"></ul><p role="status">0 users</p>',
  '</main>',
  '<script>',
  'document.getElementById("btn_7").onclick = () => {',
  '  document.getElementById("panel").innerHTML =',
  '    \'<form><div class="row"><span>Username</span><input id="fld_73" /></div>\' +',
  '    \'<button type="submit" class="b_19">Save user</button></form>\';',
  '  document.querySelector("form").onsubmit = (event) => {',
  '    event.preventDefault();',
  '    const name = document.getElementById("fld_73").value.trim();',
  '    if (!name) return;',
  '    const li = document.createElement("li");',
  '    const span = document.createElement("span");',
  '    span.textContent = name;',
  '    const remove = document.createElement("button");',
  '    remove.textContent = "Delete " + name;',
  '    remove.onclick = () => {',
  '      li.remove();',
  '      document.querySelector(\'[role="status"]\').textContent = "0 users";',
  '    };',
  '    li.append(span, remove);',
  '    document.querySelector("#users").append(li);',
  '    document.querySelector(\'[role="status"]\').textContent = "1 user";',
  '  };',
  '};',
  '</script></body></html>',
].join("\n");

let server: Server;
let baseURL: string;
test.beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(pageHtml);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseURL = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});
test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()));
});

test("dynamic form rejects unlabelled intent then runs with explicit reviewed locator", async ({ browser }, info) => {
  const definition: TestDefinition = {
    schemaVersion: 1, id: "dynamic-user-form", title: "Create and delete Bob", version: 1,
    steps: [
      { id: "open", description: "Open users", action: { kind: "navigate", url: "/" } },
      { id: "show", description: "Open user form", action: {
        kind: "click", target: { by: "intent", value: "Create user", role: "button" },
      } },
      { id: "name", description: "Enter Bob into Username", action: {
        kind: "fill", target: { by: "intent", value: "Username", role: "textbox" }, value: "Bob",
      } },
      { id: "save", description: "Save user", action: {
        kind: "click", target: { by: "intent", value: "Save user", role: "button" },
      } },
      { id: "visible", description: "Bob is visible", action: {
        kind: "assert-visible", target: { by: "intent", value: "Bob" }, provenance: "requirements",
      } },
      { id: "status", description: "One user exists", action: {
        kind: "assert-text", target: { by: "intent", value: "status", role: "status" },
        expected: "1 user", provenance: "requirements",
      } },
      { id: "delete", description: "Delete Bob", action: {
        kind: "click", target: { by: "intent", value: "Delete Bob", role: "button" },
      } },
      { id: "empty", description: "Back to zero users", action: {
        kind: "assert-text", target: { by: "intent", value: "status", role: "status" },
        expected: "0 users", provenance: "requirements",
      } },
    ],
  };
  const rejected = await runTest(definition, {
    baseURL, outputDir: info.outputPath("dynamic-invalid"), timeoutMs: 300,
  }, browser);
  expect(rejected.steps.find(step => step.id === "name")?.status).toBe("execution-error");
  expect(rejected.steps.find(step => step.id === "save")?.status).toBe("skipped");
  const corrected = structuredClone(definition);
  corrected.steps[2].action = {kind:"fill",target:{by:"id",value:"fld_73"},value:"Bob"};
  corrected.steps[4].action = {kind:"assert-visible",target:{by:"text",value:"Bob"},provenance:"requirements"};
  corrected.steps[5].action = {kind:"assert-text",target:{by:"role",role:"status"},expected:"1 user",provenance:"requirements"};
  corrected.steps[7].action = {kind:"assert-text",target:{by:"role",role:"status"},expected:"0 users",provenance:"requirements"};
  const report = await runTest(corrected, {
    baseURL, outputDir: info.outputPath("dynamic"), timeoutMs: 1200,
  }, browser);
  expect(report.status, JSON.stringify(report.steps, null, 2)).toBe("passed");
  expect(report.steps.every((step) => step.status === "passed")).toBe(true);
  expect(report.steps.find(step => step.id === "visible")?.status).toBe("passed");
});

test("assertion DOM search finds visible Products span, not absent heading", async ({ browser }) => {
  const page = await browser.newPage();
  try {
    await page.setContent('<!doctype html><main><header><span class="title">Products</span></header>' +
      '<p>Browse products here</p></main>');
    const candidates = await findAssertionAlternatives(
      page, { by: "role", role: "heading", name: "Products" }, "assert-visible",
    );
    expect(candidates).toMatchObject({
      query: "Products",
      total: 1,
      candidates: [{ tag: "span", name: "Products",
        target: { by: "text", value: "Products" } }],
    });
    expect(await page.getByRole("heading", { name: "Products" }).count()).toBe(0);
    expect(await page.getByText("Products", { exact: true }).count()).toBe(1);
    const missing = await findAssertionAlternatives(
      page, { by: "role", role: "heading", name: "Invoices" }, "assert-visible",
    );
    expect(missing.candidates).toHaveLength(0);
    expect(missing.total).toBe(0);
  } finally {
    await page.close();
  }
});

test("text mismatch searches visible product-name div, not the Add to cart button", async ({ browser }) => {
  const page = await browser.newPage();
  try {
    await page.setContent('<!doctype html><main>' +
      '<div class="inventory_details_name large_size">Sauce Labs Backpack</div>' +
      '<button>Add to cart</button><div class="inventory_details_price">$29.99</div>' +
      '<div hidden>Fake Sauce Labs Backpack</div>' +
      '</main>');
    const alternatives = await findAssertionAlternatives(
      page,
      { by: "role", role: "button", name: "Add to cart" },
      "assert-text", "Sauce Labs Backpack", true,
    );
    expect(alternatives).toMatchObject({
      query: "Sauce Labs Backpack", total: 1,
      candidates: [{
        tag: "div", name: "Sauce Labs Backpack",
        target: { by: "text", value: "Sauce Labs Backpack" },
      }],
    });
    const incorrect = await page.getByRole("button", { name: "Add to cart" }).innerText();
    expect(incorrect).toBe("Add to cart");
    expect(await page.getByText("Sauce Labs Backpack", { exact: true }).innerText())
      .toBe("Sauce Labs Backpack");
    const notPresent = await findAssertionAlternatives(
      page, { by: "role", role: "button", name: "Add to cart" },
      "assert-text", "Sauce Labs Laptop", true,
    );
    expect(notPresent.candidates).toHaveLength(0);
  } finally {
    await page.close();
  }
});

test("shopping intent scopes Add to cart to the named product, never the first button", async ({ browser }) => {
  const tab = await browser.newPage();
  try {
    await tab.setContent('<!doctype html><main>' +
      '<article><div>Sauce Labs Backpack</div><button data-item="backpack">Add to cart</button></article>' +
      '<article><div>Sauce Labs Bike Light</div><button data-item="light">Add to cart</button></article>' +
      '<article><div>Sauce Labs Bolt T-Shirt</div><button data-item="shirt">Add to cart</button></article>' +
      '<script>document.querySelectorAll("button").forEach(b => b.onclick = () => b.textContent = "Remove")</script>' +
      '</main>');

    // Exact phrase, even when the AI strips the suffix "to cart".
    const backpack = await discoverTarget(tab, {
      by: "intent", value: "Add Sauce Labs Backpack", role: "button",
    }, "click", 350);
    expect(backpack.evidence.locator).toContain('product "Sauce Labs Backpack"');
    await backpack.locator.click();
    await expect(tab.locator('[data-item="backpack"]')).toHaveText("Remove");
    await expect(tab.locator('[data-item="light"]')).toHaveText("Add to cart");

    // Partial product name and a different verb must still identify one card.
    const light = await discoverTarget(tab, {
      by: "intent", value: "Put the Bike Light in my basket", role: "button",
    }, "click", 350);
    await light.locator.click();
    await expect(tab.locator('[data-item="light"]')).toHaveText("Remove");
    await expect(tab.locator('[data-item="shirt"]')).toHaveText("Add to cart");
  } finally {
    await tab.close();
  }
});

test("shopping intent fails closed on absent, duplicate or non-actionable products", async ({ browser }) => {
  const tab = await browser.newPage();
  try {
    await tab.setContent('<main>' +
      '<article><div>Sauce Labs Backpack</div><span>Sold out</span></article>' +
      '<article><div>Sauce Labs Bike Light</div><button>Add to cart</button></article>' +
      '</main>');
    await expect(discoverTarget(tab, {
      by: "intent", value: "Add Sauce Labs Backpack to cart", role: "button",
    }, "click", 200)).rejects.toThrow(/No unique enabled Add to cart button within product/);
    await expect(discoverTarget(tab, {
      by: "intent", value: "Add Missing Widget to cart", role: "button",
    }, "click", 200)).rejects.toThrow(/not found as a unique visible title/);
    await expect(tab.getByRole("button", { name: "Add to cart" })).toHaveCount(1);

    await tab.setContent('<main>' +
      '<article><div>Sauce Labs Backpack</div><button>Add to cart</button></article>' +
      '<article><div>Sauce Labs Backpack</div><button>Add to cart</button></article>' +
      '</main>');
    await expect(discoverTarget(tab, {
      by: "intent", value: "Add Sauce Labs Backpack", role: "button",
    }, "click", 200)).rejects.toThrow(/matched multiple visible titles/);
    await expect(tab.getByRole("button", { name: "Add to cart" })).toHaveCount(2);
  } finally {
    await tab.close();
  }
});

test("ambiguous intent stops safely without clicking a random button", async ({ browser }, info) => {
  const tab = await browser.newPage();
  try {
    await tab.setContent("<!doctype html><button>Save</button><button>Save</button>");
    await expect(discoverTarget(tab, { by: "intent", value: "Save", role: "button" }, "click", 250))
      .rejects.toThrow(/Ambiguous intent/);
  } finally {
    await tab.close();
  }
  const definition: TestDefinition = {
    schemaVersion: 1, id: "missing-target", title: "Missing target", version: 1,
    steps: [
      { id: "open", description: "Open users", action: { kind: "navigate", url: "/" } },
      { id: "missing", description: "Target absent", action: {
        kind: "click", target: { by: "intent", value: "nonexistent", role: "button" },
      } },
      { id: "later", description: "No execution", action: {
        kind: "assert-text", target: { by: "role", role: "status" },
        expected: "0 users", provenance: "requirements",
      } },
    ],
  };
  const report = await runTest(definition, {
    baseURL, outputDir: info.outputPath("no-match"), timeoutMs: 250,
  }, browser);
  expect(report.status).toBe("execution-error");
  expect(report.steps[1].error).toContain("Could not resolve intent");
  expect(report.steps[2].status).toBe("skipped");
});

test("intent targets work for dynamically added task text in the existing demo", async ({ browser }, info) => {
  const definition: TestDefinition = {
    schemaVersion: 1, id: "task-by-intent", title: "Task by intent", version: 1,
    steps: [
      { id: "open", description: "Open", action: { kind: "navigate", url: "/" } },
      { id: "fill", description: "Enter task", action: {
        kind: "fill", target: { by: "intent", value: "Task", role: "textbox" },
        value: "Prepare interview",
      } },
      { id: "add", description: "Add task", action: {
        kind: "click", target: { by: "intent", value: "Add", role: "button" },
      } },
      { id: "visible", description: "Check task appears", action: {
        kind: "assert-visible", target: { by: "text", value: "Prepare interview" },
        provenance: "requirements",
      } },
    ],
  };
  const report = await runTest(definition, {
    baseURL: "http://127.0.0.1:3000", outputDir: info.outputPath("task"),
  }, browser);
  expect(report.status, JSON.stringify(report.steps, null, 2)).toBe("passed");
  expect(report.steps[2].resolution?.name).toBe("Add");
});

test("two task checkboxes reject generic Complete but resolve exact intended task", async ({ browser }) => {
  const tab = await browser.newPage();
  try {
    await tab.setContent(`<!doctype html><main>
      <label><input type="checkbox" aria-label="Complete preparing a presentation">
        preparing a presentation</label>
      <label><input type="checkbox" aria-label="Complete reviewing documentation">
        reviewing documentation</label>
    </main>`);
    await expect(discoverTarget(tab, {
      by: "intent", value: "Complete", role: "checkbox",
    }, "click", 250)).rejects.toThrow(/Ambiguous intent.*Complete/);
    await expect(discoverTarget(tab, {
      by: "intent", value: "Complete", role: "checkbox",
    }, "click", 250)).rejects.toMatchObject({
      ambiguity: {
        intent: "Complete",
        role: "checkbox",
        total: 2,
        candidates: [
          { role: "checkbox", name: "Complete preparing a presentation" },
          { role: "checkbox", name: "Complete reviewing documentation" },
        ],
      },
    });

    const resolved = await discoverTarget(tab, {
      by: "intent", value: "Complete preparing a presentation", role: "checkbox",
    }, "click", 250);
    expect(resolved.evidence.name).toBe("Complete preparing a presentation");
    await resolved.locator.check();
    await expect(tab.getByRole("checkbox", { name: "Complete preparing a presentation" })).toBeChecked();
    await expect(tab.getByRole("checkbox", { name: "Complete reviewing documentation" })).not.toBeChecked();
  } finally {
    await tab.close();
  }
});


// Reproduce the live TodoMVC failures without an AI call or external website.
test("named task completion must not select the global completion checkbox", async ({ page }) => {
  await page.setContent(`<main>
    <section><input id="toggle-all" type="checkbox"><label for="toggle-all">Mark all as complete</label>
      <ul><li><div><input id="review" type="checkbox" aria-label="Toggle Todo"><label>Review report</label></div></li>
      <li><div><input id="other" type="checkbox" aria-label="Toggle Todo"><label>Prepare presentation</label></div></li></ul>
    </section></main>
    <script>document.querySelector("#toggle-all").onchange = e => {
      document.querySelectorAll("li input").forEach(input => input.checked = e.target.checked);
    }</script>`);
  await expect(discoverTarget(page, {
    by: "intent", value: "Complete Review report", role: "checkbox",
  }, "click", 500)).rejects.toThrow(/Could not resolve intent|Ambiguous intent/);
  await expect(page.locator("input:checked")).toHaveCount(0);
  await page.getByRole("listitem").filter({has:page.getByText("Review report",{exact:true})})
    .getByRole("checkbox",{name:"Toggle Todo",exact:true}).check();
  await expect(page.locator("#toggle-all")).not.toBeChecked();
  await expect(page.locator("#review")).toBeChecked();
  await expect(page.locator("#other")).not.toBeChecked();
});

test("wrong filter role must not trigger Clear completed", async ({ page }) => {
  await page.setContent(`<main><ul id="tasks"><li>Review report</li></ul>
    <footer><a href="#/completed">Completed</a><button>Clear completed</button></footer>
    </main><script>document.querySelector("button").onclick = () => {
      document.querySelector("#tasks").replaceChildren();
    }</script>`);
  // A mismatched role must fail closed, or resolve the exact filter safely.
  // Any successful resolution must actually navigate, not delete tasks.
  let resolved;
  try {
    resolved = await discoverTarget(page, {
      by: "intent", value: "Completed", role: "button",
    }, "click", 500);
  } catch (error) {
    expect(String(error)).toMatch(/Could not resolve intent|Ambiguous intent/);
  }
  if (resolved) {
    await resolved.locator.click();
    expect(new URL(page.url()).hash).toBe("#/completed");
  }
  await expect(page.locator("#tasks li")).toHaveText("Review report");
});


test("generic item checkbox resolution rejects duplicate and missing item names", async ({ page }) => {
  await page.setContent(`<main><ul>
    <li><input type="checkbox" aria-label="Toggle Todo"><label>Review report</label></li>
    <li><input type="checkbox" aria-label="Toggle Todo"><label>Review report</label></li>
    <li><input type="checkbox" aria-label="Toggle Todo"><label>Prepare presentation</label></li>
    </ul></main>`);
  await expect(discoverTarget(page, {
    by: "intent", value: "Complete Review report", role: "checkbox",
  }, "click", 500)).rejects.toThrow(/Ambiguous intent|Could not resolve intent/);
  await expect(discoverTarget(page, {
    by: "intent", value: "Complete Missing report", role: "checkbox",
  }, "click", 500)).rejects.toThrow(/Could not resolve intent/);
  await expect(page.locator("input:checked")).toHaveCount(0);
});

test("generic item checkbox resolution rejects shared container and partial item title", async ({ page }) => {
  await page.setContent(`<main>
    <div><input type="checkbox" aria-label="Toggle Todo">
      <input type="checkbox" aria-label="Toggle Todo"><label>Review report</label></div>
    <div><input type="checkbox" aria-label="Toggle Todo"><label>Review report tomorrow</label></div>
    </main>`);
  await expect(discoverTarget(page, {
    by: "intent", value: "Complete Review report", role: "checkbox",
  }, "click", 500)).rejects.toThrow(/Could not resolve intent/);
  await expect(page.locator("input:checked")).toHaveCount(0);
});


// Legacy hints must not relax approved role constraints.
test("legacy button hint rejects exact link without changing page state", async ({ page }) => {
  await page.setContent(`<main><ul id="tasks"><li>Review report</li></ul>
    <footer><a href="#/completed" onclick="document.body.dataset.filtered='yes'">Completed</a>
    <button onclick="document.querySelector('#tasks').replaceChildren()">Clear completed</button></footer>
    </main>`);
  const target = { by: "intent", value: "Completed", role: "button", rolePolicy: "hint" } as const;
  await expect(discoverTarget(page, target, "click", 500)).rejects.toThrow(/Could not resolve intent/);
  await expect(page.locator("body")).not.toHaveAttribute("data-filtered", "yes");
  await expect(page.locator("#tasks li")).toHaveText("Review report");
});

test("role hint does not permit ambiguous or partial alternative actions", async ({ page }) => {
  const target = { by: "intent", value: "Completed", role: "button", rolePolicy: "hint" } as const;
  await page.setContent('<a href="#/one">Completed</a><a href="#/two">Completed</a><button>Clear completed</button>');
  await expect(discoverTarget(page, target, "click", 500)).rejects.toThrow(/Ambiguous intent|Could not resolve intent/);
  await page.setContent('<a href="#/one">Show completed</a>');
  await expect(discoverTarget(page, target, "click", 500)).rejects.toThrow(/Could not resolve intent/);
});

test("explicit button role remains strict when only exact link exists", async ({ page }) => {
  await page.setContent('<a href="#/completed">Completed</a><button>Clear completed</button>');
  await expect(discoverTarget(page, { by: "intent", value: "Completed", role: "button" }, "click", 500))
    .rejects.toThrow(/Could not resolve intent/);
});

test("role hint must not substitute a checkbox for a requested button", async ({ page }) => {
  await page.setContent('<input type="checkbox" aria-label="Completed">');
  const target = { by: "intent", value: "Completed", role: "button", rolePolicy: "hint" } as const;
  await expect(discoverTarget(page, target, "click", 500)).rejects.toThrow(/Could not resolve intent/);
});


// Product identity may be rendered inside an interactive details control.
test("shopping intent resolves interactive product title within its own card", async ({ page }) => {
  await page.setContent(`<main>
    <article><button aria-label="View details for Example Backpack"><span>Example Backpack</span></button>
      <button id="backpack" onclick="this.textContent='Remove'">Add to cart</button></article>
    <article><div role="button" tabindex="0" aria-label="View details for Example Lamp"><span>Example Lamp</span></div>
      <button id="lamp" onclick="this.textContent='Remove'">Add to cart</button></article>
  </main>`);
  for (const [name,id] of [["Example Backpack","backpack"],["Example Lamp","lamp"]]) {
    const result=await discoverTarget(page,{by:"intent",role:"button",value:"Add "+name+" to cart"},"click",500);
    await result.locator.click();
    await expect(page.locator("#"+id)).toHaveText("Remove");
    if(id==="backpack") await expect(page.locator("#lamp")).toHaveText("Add to cart");
  }
});

test("shopping intent rejects interactive titles when the named card has no cart action", async ({ page }) => {
  await page.setContent(`<main><section>
    <article><button aria-label="View details for Example Backpack"><span>Example Backpack</span></button></article>
    <article><div>Example Lamp</div><button id="lamp" onclick="this.textContent='Remove'">Add to cart</button></article>
  </section></main>`);
  await expect(discoverTarget(page,{by:"intent",role:"button",value:"Add Example Backpack to cart"},"click",500))
    .rejects.toThrow(/Could not resolve intent/);
  await expect(page.locator("#lamp")).toHaveText("Add to cart");
});


// Explicitly ambiguous drafts must fail; a reviewed concrete locator must succeed.
test("ambiguous role click fails until a concrete item locator is explicitly reviewed", async ({ browser }, info) => {
  const html = `<!doctype html><main>
    <article><a href="#" role="button"><span>Example Lamp</span></a><button onclick="document.getElementById('selection').textContent='Lamp'">Add to cart</button></article>
    <article><a href="#" role="button"><span>Example Backpack</span></a><button onclick="document.getElementById('selection').textContent='Backpack'">Add to cart</button></article>
    <p role="status" id="selection">None</p></main>`;
  const fixture = createServer((_req,res) => {res.writeHead(200,{"Content-Type":"text/html"});res.end(html);});
  await new Promise<void>(resolve => fixture.listen(0,"127.0.0.1",resolve));
  const url = "http://127.0.0.1:"+(fixture.address() as AddressInfo).port;
  try {
    const definition: TestDefinition = {
      schemaVersion:1,id:"contextual-role",title:"Contextual role recovery",version:1,
      steps:[
        {id:"open",description:"Open products",action:{kind:"navigate",url:"/"}},
        {id:"add",description:"Add Example Backpack to cart",action:{kind:"click",target:{by:"role",role:"button",name:"Add to cart"}}},
        {id:"verify",description:"Verify the selected item",action:{kind:"assert-text",target:{by:"role",role:"status"},expected:"Backpack",provenance:"requirements"}},
      ],
    };
    const report=await runTest(definition,{baseURL:url,outputDir:info.outputPath("contextual-role"),timeoutMs:1500},browser);
    expect(report.status,JSON.stringify(report.steps,null,2)).toBe("execution-error");
    expect(report.steps.find(s=>s.id==="add")?.resolution).toBeUndefined();
    expect(report.steps.find(s=>s.id==="verify")?.status).toBe("skipped");
    const repaired: TestDefinition = {...definition,steps:definition.steps.map(step =>
      step.id === "add" ? {...step,action:{kind:"click",target:{by:"css",value:"article:has-text('Example Backpack') button"}}} : step)};
    const rerun=await runTest(repaired,{baseURL:url,outputDir:info.outputPath("reviewed-contextual-role"),timeoutMs:1500},browser);
    expect(rerun.status,JSON.stringify(rerun.steps,null,2)).toBe("passed");
    expect(rerun.steps.find(s=>s.id==="verify")?.observed).toBe("Backpack");
    expect(rerun.steps.find(s=>s.id==="add")?.resolution).toBeUndefined();
  } finally {
    await new Promise<void>((resolve,reject)=>fixture.close(err=>err?reject(err):resolve()));
  }
});

test("ambiguous role click rejects missing or duplicate item context", async ({ browser }, info) => {
  const html = `<!doctype html><main>
    <article><h2>Example Backpack</h2><button>Add to cart</button></article>
    <article><h2>Example Backpack</h2><button>Add to cart</button></article>
    <article><h2>Example Lamp</h2><button>Add to cart</button></article></main>`;
  const fixture=createServer((_req,res)=>{res.writeHead(200,{"Content-Type":"text/html"});res.end(html);});
  await new Promise<void>(resolve=>fixture.listen(0,"127.0.0.1",resolve));
  const url="http://127.0.0.1:"+(fixture.address() as AddressInfo).port;
  try {
    for(const [index,description] of ["Add to cart","Add Missing Widget to cart","Add Example Backpack to cart"].entries()){
      const definition: TestDefinition={
        schemaVersion:1,id:"ambiguous-role",title:"Unresolved context",version:1,
        steps:[
          {id:"open",description:"Open products",action:{kind:"navigate",url:"/"}},
          {id:"add",description,action:{kind:"click",target:{by:"role",role:"button",name:"Add to cart"}}},
          {id:"verify",description:"Verify products",action:{kind:"assert-visible",target:{by:"text",value:"Example Lamp"},provenance:"requirements"}},
        ],
      };
      const report=await runTest(definition,{baseURL:url,outputDir:info.outputPath("ambiguous-"+index),timeoutMs:1000},browser);
      expect(report.status).toBe("execution-error");
      expect(report.steps.find(s=>s.id==="add")?.resolution).toBeUndefined();
      expect(report.steps.find(s=>s.id==="verify")?.status).toBe("skipped");
    }
  } finally {
    await new Promise<void>((resolve,reject)=>fixture.close(err=>err?reject(err):resolve()));
  }
});


test("ambiguous candidate context distinguishes repeated controls across cards and rows", async ({ page }) => {
  for (const html of [
    `<main><article><h2>Quarterly report</h2><div><button>Edit</button></div></article>
      <article><h2>Annual budget</h2><div><button>Edit</button></div></article></main>`,
    `<main><table><tbody><tr><td>Quarterly report</td><td><div><button>Edit</button></div></td></tr>
      <tr><td>Annual budget</td><td><div><button>Edit</button></div></td></tr></tbody></table></main>`,
    `<main><div><div><a href="#">Quarterly report</a></div><div><div><button>Edit</button></div></div></div>
      <div><div><a href="#">Annual budget</a></div><div><div><button>Edit</button></div></div></div></main>`,
  ]) {
    await page.setContent(html);
    const choices=await findLocatorAlternatives(page,{by:"role",role:"button",name:"Edit"},"click");
    expect(choices.total).toBe(2);
    expect(choices.candidates.map(c=>c.nth)).toEqual([0,1]);
    expect(choices.candidates[0].nearby).toContain("Quarterly report");
    expect(choices.candidates[0].nearby).not.toContain("Annual budget");
    expect(choices.candidates[1].nearby).toContain("Annual budget");
    expect(choices.candidates[1].nearby).not.toContain("Quarterly report");
  }
});

test("ambiguous candidate context excludes shared page and hidden content", async ({ page }) => {
  await page.setContent(`<main><h1>Shared dashboard heading</h1>
    <section><article><span hidden>Hidden diagnostic sentinel</span><div><button>Edit</button></div></article>
    <article><div><button>Edit</button></div></article></section></main>`);
  const choices=await findLocatorAlternatives(page,{by:"role",role:"button",name:"Edit"},"click");
  expect(choices.total).toBe(2);
  for(const candidate of choices.candidates){
    expect(candidate.nearby).not.toContain("Shared dashboard heading");
    expect(candidate.nearby).not.toContain("Hidden diagnostic sentinel");
    expect(candidate.nearby.length).toBeLessThanOrEqual(180);
  }
});


test("ambiguous candidate ranking prioritises instruction context without changing locator indexes", async ({ page }) => {
  await page.setContent(`<main><article><h2>Annual budget</h2><div><button>Edit</button></div></article>
    <article><h2>Quarterly report</h2><div><button>Edit</button></div></article>
    <article><h2>Quarterly forecast</h2><div><button>Edit</button></div></article></main>`);
  const target={by:"role" as const,role:"button" as const,name:"Edit"};
  // Reflect the optional fourth argument planned for diagnostic ranking.
  const rank = findLocatorAlternatives as (page: Parameters<typeof findLocatorAlternatives>[0],
    target: Parameters<typeof findLocatorAlternatives>[1],
    operation: "click", instruction?: string) => ReturnType<typeof findLocatorAlternatives>;
  const choices=await rank(page,target,"click","Edit the Quarterly report");
  expect(choices.total).toBe(3);
  expect(choices.candidates.map(c=>c.nth)).toEqual([1,0,2]);
  expect(choices.candidates[0].nearby).toContain("Quarterly report");
  expect(choices.candidates.every(c=>c.matchCount===3)).toBe(true);
  await expect(page.getByRole("button",{name:"Edit",exact:true})).toHaveCount(3);
});

test("ambiguous candidate ranking preserves DOM order for missing or tied contextual evidence", async ({ page }) => {
  await page.setContent(`<main><article><h2>Quarterly report</h2><button>Edit</button></article>
    <article><h2>Quarterly report</h2><button>Edit</button></article>
    <article><h2>Annual budget</h2><button>Edit</button></article></main>`);
  const target={by:"role" as const,role:"button" as const,name:"Edit"};
  const rank = findLocatorAlternatives as (page: Parameters<typeof findLocatorAlternatives>[0],
    target: Parameters<typeof findLocatorAlternatives>[1],
    operation: "click", instruction?: string) => ReturnType<typeof findLocatorAlternatives>;
  for(const instruction of [undefined,"Edit","Edit Missing document","Edit Quarterly report"]){
    const choices=await rank(page,target,"click",instruction);
    expect(choices.total).toBe(3);
    expect(choices.candidates.map(c=>c.nth)).toEqual([0,1,2]);
  }
});


// Cross-site evidence: a control styled like a button may actually be a link.
test("generalised action suggestions include verified links without clicking them", async ({ page }) => {
  await page.setContent(`<main><a href="#profile">View profile</a>
    <a href="#logout" class="button"><i>Logout</i></a>
    <a href="#hidden" hidden>Logout</a></main>`);
  const choices=await findLocatorAlternatives(page,{by:"role",role:"button",name:"Logout"},"click","Log out");
  expect(choices.candidates).toEqual(expect.arrayContaining([
    expect.objectContaining({role:"link",name:"Logout",target:{by:"css",value:'a[href="#logout"]'}}),
  ]));
  expect(await page.evaluate(()=>location.hash)).toBe("");
});

test("generalised action suggestions identify unnamed controls using verified attributes", async ({ page }) => {
  await page.setContent(`<main><div><input placeholder="Find records">
    <button id="submit_search"><svg aria-hidden="true"></svg></button></div>
    <div><input placeholder="Email"><button id="subscribe"><svg aria-hidden="true"></svg></button></div>
    <button id="hidden_search" hidden></button></main>`);
  const choices=await findLocatorAlternatives(page,{by:"role",role:"button"},"click","Submit search");
  expect(choices.candidates[0]).toMatchObject({target:{by:"id",value:"submit_search"}});
  expect(choices.candidates).toEqual(expect.arrayContaining([
    expect.objectContaining({target:{by:"id",value:"subscribe"}}),
  ]));
  expect(choices.candidates).not.toEqual(expect.arrayContaining([
    expect.objectContaining({target:{by:"id",value:"hidden_search"}}),
  ]));
});

test("generalised action suggestions do not offer nonunique or hidden attribute locators", async ({ page }) => {
  await page.setContent(`<main><button id="duplicate_search"></button><button id="duplicate_search"></button>
    <button id="hidden_search" hidden></button></main>`);
  const choices=await findLocatorAlternatives(page,{by:"role",role:"button"},"click","Search");
  for(const candidate of choices.candidates){
    expect(candidate).not.toMatchObject({target:{by:"id",value:"duplicate_search"}});
    expect(candidate).not.toMatchObject({target:{by:"id",value:"hidden_search"}});
  }
});


test("icon action suggestions discover nonsemantic controls with explicit interaction evidence", async ({ page }) => {
  await page.setContent(`<main><table><tbody>
    <tr><td>Quarterly report</td><td><span id="edit-quarterly" title="Edit" onclick="this.dataset.clicked='true'"><svg width="20" height="20"></svg></span></td></tr>
    <tr><td>Annual budget</td><td><span id="edit-annual" title="Edit" tabindex="0" onclick="this.dataset.clicked='true'"><svg width="20" height="20"></svg></span></td></tr>
    </tbody></table>
    <span id="edit-decoration" title="Edit"><svg width="20" height="20"></svg></span>
    <span id="edit-hidden" title="Edit" onclick="this.dataset.clicked='true'" hidden>Icon</span>
    </main>`);
  const choices=await findLocatorAlternatives(page,{by:"role",role:"button",name:"Edit"},"click","Edit Annual budget");
  expect(choices.candidates[0]).toMatchObject({target:{by:"id",value:"edit-annual"}});
  expect(choices.candidates[0].nearby).toContain("Annual budget");
  expect(choices.candidates[0].nearby).not.toContain("Quarterly report");
  expect(choices.candidates.map(c=>c.target)).toEqual([
    {by:"id",value:"edit-annual"},{by:"id",value:"edit-quarterly"},
  ]);
  expect(await page.locator("[data-clicked]").count()).toBe(0);
});

test("icon action suggestions reject decorative, disabled and nonunique controls", async ({ page }) => {
  await page.setContent(`<main>
    <span id="edit-decorative" title="Edit">Icon</span>
    <span id="edit-disabled" title="Edit" aria-disabled="true" onclick="void 0">Icon</span>
    <span id="edit-duplicate" title="Edit" onclick="void 0">Icon</span>
    <span id="edit-duplicate" title="Edit" onclick="void 0">Icon</span>
    </main>`);
  const choices=await findLocatorAlternatives(page,{by:"role",role:"button",name:"Edit"},"click","Edit report");
  expect(choices.candidates).toEqual([]);
});


test("contextual action suggestions discover framework-style icon controls without inline handlers", async ({ page }) => {
  await page.setContent(`<main><div role="row"><span>Quarterly report</span>
    <span id="edit-1" title="Edit" style="cursor:pointer"><svg width="20" height="20"></svg></span></div>
    <div role="row"><span>Annual budget</span>
    <span id="edit-2" title="Edit" style="cursor:pointer"><svg width="20" height="20"></svg></span></div>
    <span id="decorative" title="Edit"><svg width="20" height="20"></svg></span>
    <span id="pointer-only" style="cursor:pointer"><svg width="20" height="20"></svg></span>
    </main>`);
  await page.evaluate(()=> {
    for (const el of document.querySelectorAll('[id^="edit-"]')) {
      el.addEventListener("click",()=>el.setAttribute("data-clicked","yes"));
    }
  });
  const choices=await findLocatorAlternatives(page,{by:"role",role:"button",name:"Edit"},"click","Edit Annual budget");
  expect(choices.candidates.map(c=>c.target)).toEqual([{by:"id",value:"edit-2"},{by:"id",value:"edit-1"}]);
  expect(choices.candidates[0].nearby).toContain("Annual budget");
  expect(choices.candidates[0].nearby).not.toContain("Quarterly report");
  expect(await page.locator("[data-clicked]").count()).toBe(0);
});

test("contextual action suggestions do not infer interactivity from isolated attributes or inherited cursors", async ({ page }) => {
  await page.setContent(`<main style="cursor:pointer"><span id="edit-caption" title="Edit">Edit</span>
    <span id="edit-focus" tabindex="0">Edit</span>
    <span id="edit-disabled" title="Edit" style="cursor:pointer" aria-disabled="true">Edit</span>
    <span id="edit-hidden" title="Edit" style="cursor:pointer" hidden>Edit</span></main>`);
  const choices=await findLocatorAlternatives(page,{by:"role",role:"button",name:"Edit"},"click","Edit");
  expect(choices.candidates).toEqual([]);
});


test("generalised container relationships rank differently labelled links using their local record", async ({ page }) => {
  await page.setContent(`<main><h1>Shared dashboard</h1>
    <div><div><h2>Quarterly report</h2><div><a href="/records/1">View details</a></div></div>
    <div><h2>Annual budget</h2><div><a href="/records/2">View details</a></div></div>
    <div><h2>Quarterly forecast</h2><div><a href="/records/3">View details</a></div></div></div>
    </main>`);
  const choices=await findLocatorAlternatives(page,{by:"role",role:"button",name:"View details"},"click","View details for Annual budget");
  expect(choices.total).toBe(3);
  expect(choices.candidates[0].target).toEqual({by:"css",value:'a[href="/records/2"]'});
  expect(choices.candidates[0].nearby).toContain("Annual budget");
  expect(choices.candidates[0].nearby).not.toContain("Quarterly report");
  expect(choices.candidates.every(c=>!c.nearby.includes("Shared dashboard"))).toBe(true);
});

test("generalised container relationships rank nested unnamed controls by visible record context", async ({ page }) => {
  await page.setContent(`<main><div>
    <div><span>Quarterly report</span><div><button id="remove-1"></button></div></div>
    <div><span>Annual budget</span><div><button id="remove-2"></button></div></div>
    <div><span>Quarterly forecast</span><div><button id="remove-3"></button></div></div>
    </div></main>`);
  const choices=await findLocatorAlternatives(page,{by:"role",role:"button",name:"Remove"},"click","Remove Annual budget");
  expect(choices.candidates.map(c=>c.target)).toEqual([
    {by:"id",value:"remove-2"},{by:"id",value:"remove-1"},{by:"id",value:"remove-3"},
  ]);
  expect(choices.candidates[0].nearby).toContain("Annual budget");
  expect(choices.candidates[0].nearby).not.toContain("Quarterly report");
});

test("generalised container relationships never rank hidden or shared context as a unique record match", async ({ page }) => {
  await page.setContent(`<main><h1>Annual budget</h1><div>
    <div><span>Quarterly report</span><span hidden>Annual budget</span><div><a href="/records/1">Edit</a></div></div>
    <div><span>Quarterly forecast</span><div><a href="/records/2">Edit</a></div></div>
    </div></main>`);
  const choices=await findLocatorAlternatives(page,{by:"role",role:"button",name:"Edit"},"click","Edit Annual budget");
  expect(choices.candidates.map(c=>c.target)).toEqual([
    {by:"css",value:'a[href="/records/1"]'},{by:"css",value:'a[href="/records/2"]'},
  ]);
  expect(choices.candidates.every(c=>!c.nearby.includes("Annual budget"))).toBe(true);
});


test("partial assertion discovery suggests unique rendered paragraph without changing expected text", async ({ page }) => {
  await page.setContent('<main><section><p>Sed non urna. Donec et ante.</p><p>Unrelated content</p></section></main>');
  const attempted = {by:"text",value:"Sed non urna"} as const;
  const choices = await findAssertionAlternatives(page,attempted,"assert-text","Sed non urna",true);
  expect(choices.attempted).toEqual(attempted);
  expect(choices.query).toBe("Sed non urna");
  expect(choices.candidates.map(c=>c.target)).toEqual([{by:"text",value:"Sed non urna. Donec et ante."}]);
});

test("partial assertion discovery prioritises exact matches and excludes hidden and shared wrappers", async ({ page }) => {
  await page.setContent('<main><section><p>Annual budget approved</p><p>Annual budget</p><p hidden>Annual budget rejected</p></section><input value="Annual budget confidential"></main>');
  const choices = await findAssertionAlternatives(page,{by:"text",value:"Annual budget"},"assert-visible");
  expect(choices.candidates.map(c=>c.target)).toEqual([
    {by:"text",value:"Annual budget"},{by:"text",value:"Annual budget approved"},
  ]);
});

test("partial assertion discovery does not invent matches from hidden or input content", async ({ page }) => {
  await page.setContent('<main><p hidden>Annual budget approved</p><input value="Annual budget approved"><p>Quarterly report</p></main>');
  const choices = await findAssertionAlternatives(page,{by:"text",value:"Annual budget"},"assert-text","Annual budget",true);
  expect(choices.candidates).toEqual([]);
});


test("captured element picker includes uniquely identifiable controls and excludes sensitive input values", async ({page}) => {
  const module=await import("../src/discovery.js");
  const {captureElementSearchIndex,searchCapturedElements}=module as unknown as {captureElementSearchIndex:(page:import("@playwright/test").Page)=>Promise<Array<{target:{by:string;value?:string};actions:string[];nearby:string}>>;searchCapturedElements:(entries:Array<{target:{by:string;value?:string};actions:string[];nearby:string}>,query:string)=>Array<{target:{by:string;value?:string};actions:string[];nearby:string}>};
  await page.setContent(`
    <label for="choice">Default radio</label><input type="radio" id="choice" name="choice" value="yes">
    <label for="other">Second radio</label><input type="radio" id="other" name="choice" value="no">
    <input id="account" aria-label="Account" value="private-account-value">
    <input id="password" type="password" value="private-password-value">
    <button id="submit_search" aria-label="Search"></button>
    <button id="hidden" hidden>Hidden control</button>
    <p id="ready">Form ready</p>
  `);
  const entries=await captureElementSearchIndex(page);
  const radios=searchCapturedElements(entries,"radio");
  expect(radios.map(entry=>entry.target)).toEqual(expect.arrayContaining([
    {by:"id",value:"choice"},{by:"id",value:"other"}
  ]));
  expect(radios.find(entry=>entry.target.by==="id" && entry.target.value==="choice")?.actions).toContain("check");
  expect(searchCapturedElements(entries,"submit_search")[0]?.target).toEqual({by:"id",value:"submit_search"});
  expect(searchCapturedElements(entries,"Form ready")[0]?.target).toEqual({by:"id",value:"ready"});
  expect(searchCapturedElements(entries,"Hidden control")).toEqual([]);
  expect(JSON.stringify(entries)).not.toContain("private-account-value");
  expect(JSON.stringify(entries)).not.toContain("private-password-value");
});

test("captured element picker distinguishes duplicate controls using verified stable identifiers", async ({page}) => {
  const module=await import("../src/discovery.js");
  const {captureElementSearchIndex,searchCapturedElements}=module as unknown as {captureElementSearchIndex:(page:import("@playwright/test").Page)=>Promise<Array<{target:{by:string;value?:string};actions:string[];nearby:string}>>;searchCapturedElements:(entries:Array<{target:{by:string;value?:string};actions:string[];nearby:string}>,query:string)=>Array<{target:{by:string;value?:string};actions:string[];nearby:string}>};
  await page.setContent(`
    <article><h2>Annual report</h2><button id="annual-edit">Edit</button></article>
    <article><h2>Quarterly report</h2><button id="quarterly-edit">Edit</button></article>
    <button id="duplicate">Edit</button><button id="duplicate">Edit</button>
  `);
  const entries=await captureElementSearchIndex(page);
  const matches=searchCapturedElements(entries,"Edit");
  expect(matches.filter(entry=>entry.actions.includes("click")).map(entry=>entry.target)).toEqual([
    {by:"id",value:"annual-edit"},{by:"id",value:"quarterly-edit"}
  ]);
  expect(matches.find(entry=>entry.target.by==="id" && entry.target.value==="annual-edit")?.nearby).toContain("Annual report");
  expect(searchCapturedElements(entries,"Annual report").some(entry=>entry.target.by==="id" && entry.target.value==="annual-edit")).toBe(true);
});


test("runner captures dynamic failure-time elements only through opt-in evidence callback", async ({browser},info) => {
  const definition: TestDefinition = {
    schemaVersion:1,id:"dynamic-picker",title:"Dynamic failure evidence",version:1,
    steps:[
      {id:"open",description:"Open users",action:{kind:"navigate",url:"/"}},
      {id:"show",description:"Open form",action:{kind:"click",target:{by:"id",value:"btn_7"}}},
      {id:"wrong",description:"Enter username",action:{kind:"select-option",target:{by:"id",value:"fld_73"},value:"Bob"}},
      {id:"verify",description:"Verify user",action:{kind:"assert-visible",target:{by:"text",value:"Bob"},provenance:"requirements"}}
    ]
  };
  const captured: Array<{stepId:string;entries:import("../src/discovery.js").ElementSearchEntry[]}>=[];
  const options={
    baseURL,outputDir:info.outputPath("picker-capture"),timeoutMs:1200,
    onElementSearchIndex:(stepId:string,entries:import("../src/discovery.js").ElementSearchEntry[])=>captured.push({stepId,entries})
  };
  const report=await runTest(definition,options,browser);
  expect(report.status).toBe("execution-error");
  expect(captured).toHaveLength(1);
  expect(captured[0].stepId).toBe("wrong");
  expect(captured[0].entries).toEqual(expect.arrayContaining([
    expect.objectContaining({target:{by:"id",value:"fld_73"},actions:expect.arrayContaining(["fill"])})
  ]));
  expect(report.steps.find(step=>step.id==="wrong")).toMatchObject({elementSearchAvailable:true});
  expect(JSON.stringify(report)).not.toContain('"actions":["assert-visible"');
  const without=await runTest(definition,{baseURL,outputDir:info.outputPath("picker-disabled"),timeoutMs:1200},browser);
  expect(without.steps.find(step=>step.id==="wrong")).not.toHaveProperty("elementSearchAvailable");
});


for (const scenario of ["hidden-target", "hidden-descendant", "visible-target"] as const) {
  test("text assertion uses visible rendered evidence: " + scenario, async ({browser},info) => {
    const markup = scenario === "hidden-target"
      ? '<p id="message" hidden>Payment successful</p>'
      : scenario === "hidden-descendant"
        ? '<p id="message">Payment pending<span hidden>Payment successful</span></p>'
        : '<p id="message">Payment successful<span hidden>Internal diagnostic</span></p>';
    const site=createServer((_request,response)=>{
      response.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
      response.end("<!doctype html><main>"+markup+"</main>");
    });
    await new Promise<void>(resolve=>site.listen(0,"127.0.0.1",resolve));
    try {
      const definition:TestDefinition={schemaVersion:1,id:"visible-text",title:"Visible text assertion",version:1,steps:[
        {id:"open",description:"Open payment status",action:{kind:"navigate",url:"/"}},
        {id:"verify",description:"Verify visible payment successful text",action:{kind:"assert-text",target:{by:"id",value:"message"},expected:"Payment successful",match:scenario==="hidden-descendant"?"contains":"exact",provenance:"requirements"}}
      ]};
      const report=await runTest(definition,{baseURL:"http://127.0.0.1:"+(site.address() as AddressInfo).port,outputDir:info.outputPath("visible-text"),timeoutMs:800},browser);
      if(scenario==="visible-target"){
        expect(report.status).toBe("passed");
        expect(report.steps[1].observed).toBe("Payment successful");
      }else{
        expect(report.status).not.toBe("passed");
        if(scenario==="hidden-descendant") expect(report.steps[1].observed).toBe("Payment pending");
      }
    }finally{
      site.closeAllConnections();
      await new Promise<void>((resolve,reject)=>site.close(error=>error?reject(error):resolve()));
    }
  });
}


test("named deletion must not introduce an unapproved hover @sanity", async ({page}) => {
  await page.setContent('<style>li button {display:none} li:hover button {display:inline-block}</style><ul><li><label>sbf</label><button class="destroy" onclick="this.closest(\'li\').remove()"></button></li><li><label>test activity</label><button class="destroy" onclick="this.closest(\'li\').remove()"></button></li></ul><button>Clear completed</button>');
  const target = {by:"intent",role:"button",value:"Delete test activity"} as const;
  await expect(page.locator("li").nth(1).locator("button")).toBeHidden();
  await expect(discoverTarget(page,target,"click",500)).rejects.toThrow(/Could not resolve intent/);
  await expect(page.locator("li").nth(1).locator("button")).toBeHidden();
  await expect(page.getByText("test activity",{exact:true})).toBeVisible();
  await expect(page.getByText("sbf",{exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"Clear completed"})).toBeVisible();
});

test("named deletion refuses duplicate item identities, unrelated controls and bulk actions @sanity", async ({page}) => {
  for (const html of [
    '<ul><li><label>Draft report</label><button class="destroy"> </button></li><li><label>Draft report</label><button class="destroy"> </button></li></ul>',
    '<ul><li><label>Draft report</label><button>Edit</button></li><li><label>Other report</label><button>Delete</button></li></ul>',
    '<ul><li><label>Draft report</label><button>Clear completed</button></li></ul>',
    '<ul><li><label>Draft report</label><button>Delete</button><button>Remove</button></li></ul>',
  ]) {
    await page.setContent(html);
    await expect(discoverTarget(page,{by:"intent",role:"button",value:"Delete Draft report"},"click",250)).rejects.toThrow(/Could not resolve intent/);
  }
});


// Reproduce the fidelity violations against the real runner, not just locator helpers.
for (const scenario of ["label-placeholder-fill", "label-placeholder-press", "ambiguous-cart-description"] as const) {
  test("approved exact locator must not be silently corrected: " + scenario, async ({browser},info) => {
    const isCart = scenario === "ambiguous-cart-description";
    const markup = isCart
      ? '<article><h2>Alpha product</h2><button onclick="document.querySelector(\'#changed\').textContent=\'Alpha\'">Add to cart</button></article><article><h2>Beta product</h2><button onclick="document.querySelector(\'#changed\').textContent=\'Beta\'">Add to cart</button></article><p id="changed">unchanged</p>'
      : '<input placeholder="Search term" oninput="document.querySelector(\'#changed\').textContent=\'filled\'" onkeydown="document.querySelector(\'#changed\').textContent=\'pressed\'"><p id="changed">unchanged</p>';
    const site=createServer((_request,response)=>{
      response.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
      response.end("<!doctype html><main>"+markup+"</main>");
    });
    await new Promise<void>(resolve=>site.listen(0,"127.0.0.1",resolve));
    try {
      const action:TestDefinition["steps"][number]["action"] = isCart
        ? {kind:"click",target:{by:"role",role:"button",name:"Add to cart"}}
        : scenario === "label-placeholder-fill"
          ? {kind:"fill",target:{by:"label",value:"Search term"},value:"unexpected"}
          : {kind:"press",target:{by:"label",value:"Search term"},key:"Enter"};
      const definition:TestDefinition={schemaVersion:1,id:"fidelity",title:"Exact locator fidelity",version:1,steps:[
        {id:"open",description:"Open",action:{kind:"navigate",url:"/"}},
        {id:"wrong",description:isCart?"Add Alpha product to cart":"Search term",action},
        {id:"after",description:"Must not run after failure",action:{kind:"assert-text",target:{by:"id",value:"changed"},expected:"unchanged",provenance:"requirements"}}
      ]};
      const report=await runTest(definition,{baseURL:"http://127.0.0.1:"+(site.address() as AddressInfo).port,outputDir:info.outputPath("fidelity"),timeoutMs:800},browser);
      expect(report.steps.find(step=>step.id==="wrong")?.status).toBe("execution-error");
      expect(report.steps.find(step=>step.id==="wrong")?.resolution).toBeUndefined();
      expect(report.steps.find(step=>step.id==="after")?.status).toBe("skipped");
    }finally{
      site.closeAllConnections();
      await new Promise<void>((resolve,reject)=>site.close(error=>error?reject(error):resolve()));
    }
  });
}


test("explicit approved hover reveals only the intended record control; export preserves operation @sanity", async ({browser},info) => {
  const {generatePlaywrightSpec}=await import("../src/export.js");
  const {preflightSelectors}=await import("../src/preflight.js");
  const {parseTestDefinition}=await import("../src/schema.js");
  const markup=`<!doctype html><style>li button {display:none} li:hover button {display:inline-block}</style>
    <ul><li id="other"><span>Other task</span><button class="destroy" onclick="this.closest('li').remove()">Delete</button></li>
    <li id="selected"><span>Target task</span><button class="destroy" onclick="this.closest('li').remove()">Delete</button></li></ul>`;
  const site=createServer((_request,response)=>{response.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});response.end(markup);});
  await new Promise<void>(resolve=>site.listen(0,"127.0.0.1",resolve));
  const url="http://127.0.0.1:"+(site.address() as AddressInfo).port;
  try {
    const definition:TestDefinition={schemaVersion:1,id:"explicit-hover",title:"Explicit hover",version:1,steps:[
      {id:"open",description:"Open",action:{kind:"navigate",url:"/"}},
      {id:"hover",description:"Reveal target controls",action:{kind:"hover",target:{by:"id",value:"selected"}}},
      {id:"delete",description:"Click target delete button",action:{kind:"click",target:{by:"css",value:"#selected button.destroy"}}},
      {id:"absent",description:"Target removed",action:{kind:"assert-count",target:{by:"id",value:"selected"},expected:0,provenance:"requirements"}},
      {id:"other",description:"Other retained",action:{kind:"assert-visible",target:{by:"id",value:"other"},provenance:"requirements"}}
    ]};
    const before=JSON.stringify(definition);
    const preflight=await preflightSelectors(definition,url,browser);
    expect(preflight.findings.find(f=>f.stepId==="delete")?.status).toBe("deferred");
    expect(JSON.stringify(definition)).toBe(before);
    const options={baseURL:url,timeoutMs:1000,outputDir:info.outputPath("explicit-hover")};
    const report=await runTest(definition,options,browser);
    expect(report.status,JSON.stringify(report.steps)).toBe("passed");
    expect(report.steps.find(s=>s.id==="hover")).toMatchObject({actionKind:"hover",status:"passed"});
    const without={...definition,steps:definition.steps.filter(s=>s.id!=="hover")};
    const failed=await runTest(without,{...options,outputDir:info.outputPath("missing-hover")},browser);
    expect(failed.steps.find(s=>s.id==="delete")?.status).toBe("execution-error");
    expect(failed.steps.find(s=>s.id==="absent")?.status).toBe("skipped");
    const invalid={...definition,steps:definition.steps.map(s=>s.id==="hover"?{...s,action:{kind:"hover",target:{by:"intent",value:"Target task"}}}:s)};
    expect(()=>parseTestDefinition(invalid)).toThrow();
    const spec=generatePlaywrightSpec(definition,{baseURL:url});
    expect(spec).toContain("await target.hover();");
    expect(spec.indexOf("await target.hover();")).toBeLessThan(spec.indexOf("await target.click();"));
  }finally{
    site.closeAllConnections();
    await new Promise<void>((resolve,reject)=>site.close(error=>error?reject(error):resolve()));
  }
});


test("scoped role locator uses exact record identity and rejects ambiguous containers @sanity", async ({browser},info) => {
  const row=(text:string,button:boolean)=>'<li><span>'+text+'</span>'+(button?'<button onclick="this.closest(\'li\').remove()">Delete</button>':'')+'</li>';
  let markup='<ul>'+row("Target task",true)+row("Target task extra",true)+'</ul>';
  const site=createServer((_req,res)=>{res.writeHead(200,{"Content-Type":"text/html"});res.end('<!doctype html><style>li button{display:none}li:hover button{display:inline-block}</style>'+markup);});
  await new Promise<void>(resolve=>site.listen(0,"127.0.0.1",resolve));
  const url="http://127.0.0.1:"+(site.address() as AddressInfo).port;
  try {
    const definition:TestDefinition={schemaVersion:1,id:"scoped-hover",title:"Scoped hover and delete",version:1,steps:[
      {id:"open",description:"Open",action:{kind:"navigate",url:"/"}},
      {id:"hover",description:"Hover exact task",action:{kind:"hover",target:{by:"role",role:"listitem",hasText:"Target task"}}},
      {id:"delete",description:"Delete in exact task",action:{kind:"click",target:{by:"role",role:"button",name:"Delete",within:{role:"listitem",text:"Target task"}}}},
      {id:"absent",description:"Target removed",action:{kind:"assert-count",target:{by:"text",value:"Target task"},expected:0,provenance:"requirements"}},
      {id:"retained",description:"Neighbour retained",action:{kind:"assert-visible",target:{by:"text",value:"Target task extra"},provenance:"requirements"}}
    ]};
    const opts={baseURL:url,timeoutMs:900,outputDir:info.outputPath("scoped-positive")};
    const report=await runTest(definition,opts,browser);
    expect(report.status,JSON.stringify(report.steps)).toBe("passed");
    // Even when just one duplicate container has a control, scope is ambiguous.
    markup='<ul>'+row("Target task",true)+row("Target task",false)+'</ul>';
    const duplicate={...definition,steps:definition.steps.filter(s=>s.id!=="hover")};
    const failed=await runTest(duplicate,{...opts,outputDir:info.outputPath("scoped-duplicate")},browser);
    expect(failed.steps.find(s=>s.id==="delete")?.status).toBe("execution-error");
    expect(failed.steps.find(s=>s.id==="delete")?.error).toContain("strict mode violation");
    expect(failed.steps.find(s=>s.id==="absent")?.status).toBe("skipped");
    const {generatePlaywrightSpec}=await import("../src/export.js");
    const source=generatePlaywrightSpec(definition,{baseURL:url});
    expect(source).toContain('const container = page.getByRole("listitem").filter({ has: page.getByText("Target task", { exact: true }) });');
    expect(source).toContain('await container.waitFor({ state: "attached", timeout: STEP_TIMEOUT });');
    expect(source).toContain('container.getByRole("button", { name: "Delete", exact: true })');
  }finally{
    site.closeAllConnections();
    await new Promise<void>((resolve,reject)=>site.close(error=>error?reject(error):resolve()));
  }
});


// Reproduce runtime guessing separately from read-only diagnostic ranking.
test("intent cannot borrow a missing action name from neighbouring text @sanity", async ({page}) => {
  await page.setContent('<section><span>Approve invoice</span><button onclick="document.body.dataset.clicked=\'yes\'">Cancel</button></section>');
  await expect(discoverTarget(page,{by:"intent",role:"button",value:"Approve invoice"},"click",300)).rejects.toThrow(/Could not resolve intent/);
  await expect(page.locator("body")).not.toHaveAttribute("data-clicked","yes");
});
test("intent cannot pick a partial action name merely because it is unique @sanity", async ({page}) => {
  await page.setContent('<button onclick="document.body.dataset.clicked=\'yes\'">Delete all records</button>');
  await expect(discoverTarget(page,{by:"intent",role:"button",value:"Delete"},"click",300)).rejects.toThrow(/Could not resolve intent/);
  await expect(page.locator("body")).not.toHaveAttribute("data-clicked","yes");
});
test("intent resolves an exact unique action without borrowing context @sanity", async ({page}) => {
  await page.setContent('<section><span>Approve invoice</span><button>Cancel</button><button onclick="document.body.dataset.clicked=\'yes\'">Approve invoice</button></section>');
  const found=await discoverTarget(page,{by:"intent",role:"button",value:"Approve invoice"},"click",300);
  await found.locator.click();
  await expect(page.locator("body")).toHaveAttribute("data-clicked","yes");
});


test("visible local deletion control is not inferred from a named intent @sanity", async ({page}) => {
  await page.setContent('<ul><li><span>Draft report</span><button class="destroy" onclick="this.closest(\'li\').remove()">Delete</button></li><li><span>Other report</span><button>Delete</button></li></ul>');
  await expect(discoverTarget(page,{by:"intent",role:"button",value:"Delete Draft report"},"click",300)).rejects.toThrow(/Could not resolve intent|Ambiguous intent/);
  await expect(page.getByText("Draft report",{exact:true})).toBeVisible();
  await expect(page.getByText("Other report",{exact:true})).toBeVisible();
});
test("named cart intent cannot infer a container and button @sanity", async ({page}) => {
  await page.setContent('<article><span>Example Backpack</span><button onclick="this.textContent=\'Remove\'">Add to cart</button></article><article><span>Example Lamp</span><button>Add to cart</button></article>');
  await expect(discoverTarget(page,{by:"intent",role:"button",value:"Add Example Backpack to cart"},"click",300)).rejects.toThrow(/Could not resolve intent|Ambiguous intent/);
  await expect(page.getByRole("button",{name:"Add to cart",exact:true})).toHaveCount(2);
});
