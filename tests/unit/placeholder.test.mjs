import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseTestDefinition } from "../../dist/schema.js";
import { generatePlaywrightSpec } from "../../dist/export.js";

const example = JSON.parse(await readFile(new URL(
  "../../examples/add-task.json", import.meta.url), "utf8"));

test("placeholder locators validate for fill and press and export directly to Playwright", () => {
  const definition = structuredClone(example);
  definition.steps[2].action.target = {
    by: "placeholder", value: "What needs to be done?",
  };
  definition.steps[3].action = {
    kind: "press", target: {
      by: "placeholder", value: "What needs to be done?",
    }, key: "Enter",
  };
  const valid = parseTestDefinition(definition);
  assert.deepEqual(valid.steps[3].action.target, {
    by: "placeholder", value: "What needs to be done?",
  });
  const source = generatePlaywrightSpec(valid, { baseURL: "http://127.0.0.1:3000" });
  assert.match(source, /page\.getByPlaceholder\("What needs to be done\?", \{ exact: true \}\)/);
  assert.match(source, /await target\.press\("Enter"\)/);
});

test("placeholder locators reject blank values and unrecognized keys", () => {
  for (const value of ["", "    "]) {
    const definition = structuredClone(example);
    definition.steps[2].action.target = { by: "placeholder", value };
    assert.throws(() => parseTestDefinition(definition));
  }
  const definition = structuredClone(example);
  definition.steps[2].action.target = {
    by: "placeholder", value: "What needs to be done?", selector: "input",
  };
  assert.throws(() => parseTestDefinition(definition));
});

test("placeholder count assertions remain multi-match, with no positional index", () => {
  const definition = structuredClone(example);
  definition.steps[1].action = {
    kind: "assert-count",
    target: { by: "placeholder", value: "What needs to be done?" },
    expected: 1, provenance: "requirements",
  };
  assert.equal(parseTestDefinition(definition).steps[1].action.target.by, "placeholder");
});
