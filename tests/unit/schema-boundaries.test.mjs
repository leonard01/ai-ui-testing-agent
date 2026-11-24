import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTestDefinition } from "../../dist/schema.js";

const base = () => ({
  schemaVersion: 1, id: "boundary", title: "Boundary test", version: 1,
  steps: [
    { id: "open", description: "Open", action: { kind: "navigate", url: "/" } },
    { id: "verify", description: "Verify", action: {
      kind: "assert-count", target: { by: "text", value: "Item" },
      expected: 0, provenance: "requirements",
    } },
  ],
});

function check(label, mutate, accepted) {
  test(label, () => {
    const input = base();
    mutate(input);
    if (accepted) assert.doesNotThrow(() => parseTestDefinition(input));
    else assert.throws(() => parseTestDefinition(input));
  });
}

for (const [value, accepted] of [[0,true],[1,true],[100000,true],[100001,false],[-1,false],[0.5,false],["1",false]]) {
  check("count assertion boundary: " + JSON.stringify(value), d => {
    d.steps[1].action.expected = value;
  }, accepted);
}

for (const [n, accepted] of [[0,false],[1,true],[2000,true],[2001,false]]) {
  check("definition title length " + n, d => { d.title = "x".repeat(n); }, accepted);
}
check("whitespace-only title rejected", d => { d.title = "   "; }, false);
for (const [n, accepted] of [[0,true],[12000,true],[12001,false]]) {
  for (const field of ["sourceInstructions","workingInstructions"]) {
    check(field + " length " + n, d => { d[field] = "x".repeat(n); }, accepted);
  }
}

for (const [url, accepted] of [
  ["http://localhost:3000/path?q=1",true],
  ["https://example.test/path",true],
  ["ftp://example.test",false],
  ["javascript:alert(1)",false],
  ["https://user:password@example.test",false],
  ["//example.test",false],
  ["/relative",false],
]) {
  check("source URL: " + url, d => { d.sourceUrl = url; }, accepted);
}

for (const [n, accepted] of [[2,true],[99,true],[100,true],[101,false]]) {
  check("step count " + n, d => {
    while (d.steps.length < n) {
      d.steps.push({ id: "extra-" + d.steps.length, description: "Check", action: {
        kind: "assert-visible", target: { by: "text", value: "Item" }, provenance: "inferred",
      } });
    }
  }, accepted);
}

for (const [n, accepted] of [[-1,false],[0,true],[249,true],[250,false],[1.5,false]]) {
  check("indexed role boundary " + n, d => {
    d.steps[1].action = { kind: "assert-visible", target: {
      by: "role", role: "button", name: "Add", nth: n,
    }, provenance: "requirements" };
  }, accepted);
}
check("count rejects indexed role", d => {
  d.steps[1].action.target = { by: "role", role: "button", nth: 0 };
}, false);

for (const [n, accepted] of [[0,true],[10000,true],[10001,false]]) {
  check("fill value length " + n, d => {
    d.steps.splice(1, 0, { id: "fill", description: "Fill", action: {
      kind: "fill", target: { by: "label", value: "Input" }, value: "x".repeat(n),
    } });
  }, accepted);
}

for (const [n, accepted] of [[0,true],[40,true],[41,false]]) {
  check("requirements count " + n, d => {
    d.requirements = Array.from({length:n}, (_,i) => ({
      id: "r" + i, text: "Requirement", stepIds: ["verify"],
    }));
  }, accepted);
}
check("unmapped requirement is permitted", d => {
  d.requirements = [{id:"r",text:"Requirement",stepIds:[]}];
}, true);
check("duplicate requirement IDs rejected", d => {
  d.requirements = [{id:"r",text:"First",stepIds:["open"]},
    {id:"r",text:"Second",stepIds:["verify"]}];
}, false);
check("duplicate links rejected", d => {
  d.requirements = [{id:"r",text:"Requirement",stepIds:["verify","verify"]}];
}, false);
check("unknown step reference rejected", d => {
  d.requirements = [{id:"r",text:"Requirement",stepIds:["missing"]}];
}, false);

test("successful parsing trims identifiers and titles without altering entered fill values", () => {
  const input = base();
  input.title = "  My test  ";
  input.steps.splice(1,0,{id:"  fill  ",description:"Fill",action:{
    kind:"fill",target:{by:"label",value:"Input"},value:"  keep spaces  ",
  }});
  const parsed = parseTestDefinition(input);
  assert.equal(parsed.title,"My test");
  assert.equal(parsed.steps[1].id,"fill");
  assert.equal(parsed.steps[1].action.value,"  keep spaces  ");
});
