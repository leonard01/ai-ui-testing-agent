import { test } from "node:test";
import assert from "node:assert/strict";
import { restoreMissingSearchFill } from "../../dist/search-workflow.js";

function draft(steps) {
  return {
    schemaVersion: 1, id: "google-shoes", title: "Search shoes", version: 1,
    steps: [
      { id: "open", description: "Open Google", action: {
        kind: "navigate", url: "https://www.google.com/",
      } },
      ...steps,
      { id: "verify", description: "A returned result contains shoes", action: {
        kind: "assert-text", target: { by: "text", value: "shoes" },
        expected: "shoes", provenance: "requirements",
      } },
    ],
  };
}
const submit = (target = { by: "role", role: "combobox", name: "Search" }) => ({
  id: "submit", description: "Enter shoes in search and submit",
  action: { kind: "press", target, key: "Enter" },
});
const instructions = "search for 'shoes'\nvalidate a return contains the text shoes";

test("restore missing search fill from an explicit quoted search requirement", () => {
  const definition = draft([submit()]);
  assert.equal(restoreMissingSearchFill(definition, instructions), true);
  assert.deepEqual(definition.steps.map(step => step.action.kind),
    ["navigate", "fill", "press", "assert-text"]);
  assert.deepEqual(definition.steps[1].action, {
    kind: "fill", value: "shoes",
    target: { by: "role", role: "combobox", name: "Search" },
  });
  assert.deepEqual(definition.steps[2].action.target, definition.steps[1].action.target);
  assert.notEqual(definition.steps[1].id, definition.steps[2].id);
  assert.equal(definition.steps[2].description, "Submit search by pressing Enter");
  assert.equal(restoreMissingSearchFill(definition, instructions), false);
});

test("do not add a second fill if the model already typed the query", () => {
  const definition = draft([
    { id: "type", description: "Type query", action: {
      kind: "fill", target: { by: "placeholder", value: "Search" }, value: "shoes",
    } },
    submit(),
  ]);
  assert.equal(restoreMissingSearchFill(definition, instructions), false);
  assert.equal(definition.steps.length, 4);
});

test("do not invent a query when requirements have no unambiguous quoted search value", () => {
  const missing = draft([submit()]);
  assert.equal(restoreMissingSearchFill(missing, "search for shoes and check a result"), false);
  assert.equal(missing.steps.length, 3);
  const conflicting = draft([submit()]);
  assert.equal(restoreMissingSearchFill(conflicting,
    "search for 'shoes', then search for 'hats'"), false);
  assert.equal(conflicting.steps.length, 3);
});

test("do not auto-fill unrelated Enter targets", () => {
  const definition = draft([submit({ by: "role", role: "textbox", name: "Password" })]);
  assert.equal(restoreMissingSearchFill(definition, instructions), false);
  assert.equal(definition.steps.length, 3);
});

test("works with placeholder search targets and unique ID collisions", () => {
  const definition = draft([
    { id: "submit-fill", description: "Other action", action: {
      kind: "click", target: { by: "role", role: "button", name: "Ready" },
    } },
    submit({ by: "placeholder", value: "Search for anything" }),
  ]);
  assert.equal(restoreMissingSearchFill(definition, instructions), true);
  assert.equal(definition.steps[2].id, "submit-fill-2");
  assert.equal(definition.steps[2].action.value, "shoes");
});
