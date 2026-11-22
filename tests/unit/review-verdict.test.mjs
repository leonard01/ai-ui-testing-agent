import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../../demo/review.html", import.meta.url), "utf8");

test("passed result renders explicit success icon and styling", () => {
  assert.match(source, /didPass \? "✓ PASSED — " : "✕ FAILED — "/);
  assert.match(source, /classList\.toggle\("run-passed", didPass\)/);
  assert.match(source, /#run-summary\.run-passed \{[^}]*color:/);
});

test("diagnosis is hidden for passing runs and retained on failures", () => {
  assert.match(source, /\$\("run-diagnosis"\)\.hidden = didPass/);
  assert.match(source, /\$\("run-diagnosis"\)\.textContent = didPass \? "" : diagnosticText\(result\)/);
  assert.match(source, /classList\.toggle\("run-failed", !didPass\)/);
});
