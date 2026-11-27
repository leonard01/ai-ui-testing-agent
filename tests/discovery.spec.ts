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

test("resolves intent after opening a dynamic form with a poorly labelled input", async ({ browser }, info) => {
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
  const report = await runTest(definition, {
    baseURL, outputDir: info.outputPath("dynamic"), timeoutMs: 1200,
  }, browser);
  expect(report.status, JSON.stringify(report.steps, null, 2)).toBe("passed");
  expect(report.steps.every((step) => step.status === "passed")).toBe(true);
  const entered = report.steps.find((step) => step.id === "name");
  expect(entered?.resolution).toMatchObject({
    method: "live-dom", intent: "Username", tag: "input", role: "textbox",
  });
  expect(entered?.resolution?.nearby).toContain("Username");
  expect(report.steps.find((step) => step.id === "visible")?.resolution?.tag).toBe("span");
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
        kind: "click", target: { by: "intent", value: "Add task", role: "button" },
      } },
      { id: "visible", description: "Check task appears", action: {
        kind: "assert-visible", target: { by: "intent", value: "Prepare interview" },
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
  const resolved = await discoverTarget(page, {
    by: "intent", value: "Complete Review report", role: "checkbox",
  }, "click", 500);
  await resolved.locator.click();
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
  }, "click", 500)).rejects.toThrow(/Ambiguous intent/);
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


// Role hints are opt-in; existing role constraints must remain strict.
test("inferred button role can recover to unique exact link without destructive click", async ({ page }) => {
  await page.setContent(`<main><ul id="tasks"><li>Review report</li></ul>
    <footer><a href="#/completed" onclick="document.body.dataset.filtered='yes'">Completed</a>
    <button onclick="document.querySelector('#tasks').replaceChildren()">Clear completed</button></footer>
    </main>`);
  const target = { by: "intent", value: "Completed", role: "button", rolePolicy: "hint" } as const;
  const resolved = await discoverTarget(page, target, "click", 500);
  expect(resolved.evidence.role).toBe("link");
  await resolved.locator.click();
  await expect(page.locator("body")).toHaveAttribute("data-filtered", "yes");
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


// Reproduce a valid model draft whose role locator drops the item context.
test("ambiguous role click recovers the named item without selecting a neighbouring button", async ({ browser }, info) => {
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
    expect(report.status,JSON.stringify(report.steps,null,2)).toBe("passed");
    expect(report.steps.find(s=>s.id==="add")?.resolution?.intent).toBe("Add Example Backpack to cart");
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
