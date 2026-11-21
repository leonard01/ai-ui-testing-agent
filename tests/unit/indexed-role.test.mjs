import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseTestDefinition } from "../../dist/schema.js";
import { generatePlaywrightSpec } from "../../dist/export.js";

const example = JSON.parse(await readFile(
  new URL("../../examples/add-task.json", import.meta.url), "utf8"));

function withIndexedRole(nth) {
  const definition = structuredClone(example);
  definition.steps[3].action = {
    kind: "click",
    target: { by: "role", role: "button", name: "Delete", nth },
  };
  return definition;
}

test("human-reviewed role index is validated and survives Playwright export", () => {
  for (const nth of [0, 1, 249]) {
    const validated = parseTestDefinition(withIndexedRole(nth));
    assert.equal(validated.steps[3].action.target.nth, nth);
    const source = generatePlaywrightSpec(validated, { baseURL: "http://127.0.0.1:3000" });
    assert.ok(source.includes(
      'page.getByRole("button", { name: "Delete", exact: true }).nth(' + nth + ')'));
  }
});

test("role index rejects negative, fractional, huge and non-number values", () => {
  for (const invalid of [-1, 1.5, 250, "0", null]) {
    assert.throws(() => parseTestDefinition(withIndexedRole(invalid)));
  }
});

test("count assertions remain multi-match and must never accept nth", () => {
  const definition = structuredClone(example);
  definition.steps[1].action = {
    kind: "assert-count", target: {
      by: "role", role: "button", name: "Delete", nth: 0,
    }, expected: 2, provenance: "requirements",
  };
  assert.throws(() => parseTestDefinition(definition));
});
