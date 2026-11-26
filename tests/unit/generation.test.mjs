import { test } from "node:test";
import assert from "node:assert/strict";
import { extractResponseText, makeGenerationPrompt } from "../../dist/generation.js";
import { ensureAllowedNavigation } from "../../dist/inspect.js";

const snapshot = {
  url: "http://127.0.0.1:3000/",
  title: "Task list test application",
  headings: ["Task list"],
  controls: [{ kind: "button", name: "Add" }],
  statusText: ["0 tasks, 0 completed"],
  sampleText: ["Task"],
};

test("extracts text from a completed Responses API result", () => {
  assert.equal(extractResponseText({
    status: "completed",
    output: [{ content: [{ type: "output_text", text: '{"ok":true}' }] }],
  }), '{"ok":true}');
  assert.throws(() => extractResponseText({ status: "incomplete", output: [] }), /not completed/);
  assert.throws(() => extractResponseText({ output: [] }), /generated text/);
});
test("creates a review-first prompt with provenance constraints", () => {
  const { system, prompt } = makeGenerationPrompt(
    "One new task must increase the count", snapshot,
  );
  assert.match(system, /NEVER 'human-confirmed'/);
  assert.match(system, /untrusted DATA/);
  assert.match(system, /Prefer grounded live DOM intent/);
  assert.match(system, /Use associated form labels, never button text as label/);
  assert.match(system, /Listitem often has no accessible name/);
  assert.match(system, /resolution occurs at each step/);
  assert.match(system, /No invented CSS\/XPath\/id\/testid/);
  assert.match(system, /named repeated controls carry exact item identity/);
  assert.match(system, /Never generic Delete\/Edit\/Complete with multiple items/);
  assert.match(system, /Do not invent row selection when a direct control exists/);
  assert.match(system, /'Complete Eggs', role checkbox/);
  assert.match(system, /'Delete Eggs', role button/);
  assert.match(system, /use unique visible text for added task assertions rather than guessed listitem name or label/);
  assert.match(prompt, /One new task must increase/);
  assert.match(prompt, /review it before execution/);
});
test("rejects off-origin or non-HTTP navigation", () => {
  const base = new URL(snapshot.url);
  assert.equal(ensureAllowedNavigation("/tasks", base).pathname, "/tasks");
  for (const url of ["https://example.org/", "//example.org", "javascript:alert(1)"]) {
    assert.throws(() => ensureAllowedNavigation(url, base), /configured HTTP/);
  }
});
