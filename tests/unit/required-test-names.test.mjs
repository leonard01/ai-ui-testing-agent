import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const ui = readFileSync(new URL("../../demo/review.html", import.meta.url), "utf8");
const server = readFileSync(new URL("../../src/review-server.ts", import.meta.url), "utf8");

test("review requires an explicit tester-entered name before save", () => {
  assert.match(ui, /id="test-name"[^>]*maxlength="200"[^>]*required/);
  assert.match(ui, /\$\("save"\)\.disabled = [\s\S]*?!\$\("test-name"\)\.value\.trim\(\)/);
  assert.match(ui, /const testName = \$\("test-name"\)\.value\.trim\(\)/);
  assert.match(ui, /testName, baseURL: selectedBaseURL/);
  assert.match(server, /typeof rawName !== "string" \|\| !rawName\.trim\(\)/);
  assert.match(server, /title: rawName\.trim\(\)/);
});

test("editing loads the saved name rather than an AI-suggested default", () => {
  assert.match(ui, /definition = payload\.definition;[\s\S]{0,800}\$\("test-name"\)\.value = definition\.title/);
  assert.match(ui, /if \(!wasEditing\) \{[\s\S]{0,180}originalInstructions = exceptionRootInstructions \?\? requirements/);
  assert.doesNotMatch(ui, /if \(!wasEditing\) \{[^}]*\$\("test-name"\)\.value = ""/);
});

test("previously used URL selector supports saved scripts and recent generation", () => {
  assert.match(ui, /id="recent-url"/);
  assert.match(ui, /approvedCatalog\.flatMap\(\(test\) => test\.sourceUrl/);
  assert.match(ui, /rememberRecentUrl\(baseURL\)/);
  assert.match(ui, /localStorage\.setItem\(RECENT_URLS_KEY/);
  assert.match(ui, /\$\("recent-url"\)\.addEventListener\("change"/);
});
