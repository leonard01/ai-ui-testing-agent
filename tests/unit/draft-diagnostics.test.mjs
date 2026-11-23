import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { draftQualityWarnings } from "../../dist/draft-diagnostics.js";

const fixture = JSON.parse(await readFile("examples/add-task.json", "utf8"));
const baseSnapshot = {
  url: "http://127.0.0.1:3000/",
  title: "Task list",
  headings: ["Task list"],
  controls: [{ kind: "textbox", name: "Task" }],
  statusText: ["0 tasks, 0 completed"],
  sampleText: [],
};
test("draft warnings flag a search silently replaced with an unexpected error assertion", () => {
  const definition = {
    ...fixture,
    steps: [
      { id: "open", description: "Open eBay", action: { kind: "navigate", url: "https://www.ebay.com/" } },
      { id: "error", description: "Verify error page message", action: {
        kind: "assert-text", target: { by: "text", value: "Something went wrong on our end" },
        expected: "Something went wrong on our end", provenance: "inferred",
      } },
    ],
  };
  const warnings = draftQualityWarnings(
    "search for 'Wooden Abacus' and verify 'wooden' and 'abacus' are in the results",
    definition,
    { ...baseSnapshot, title: "eBay", statusText: ["Something went wrong on our end"],
      inspection: { mainDocumentStatus: 200, blockedCrossOriginRequests: 9, pageErrors: 2 } },
  );
  assert.ok(warnings.some((w) => w.includes("error/block message")));
  // Third-party request blocking is expected policy activity, not automatically
  // a defect in a page that returned meaningful heading/status evidence.
  assert.ok(!warnings.some((w) => w.includes("blocked 9 cross-origin")));
  assert.ok(!warnings.some((w) => w.includes("blocked 9 external")));
  assert.ok(warnings.some((w) => w.includes("JavaScript exception") &&
    w.includes("does NOT mean a test step or selector has failed")));
  assert.ok(warnings.some((w) => w.includes("Wooden Abacus")));
  assert.ok(warnings.some((w) => w.includes("false pass")));
});
test("blocked third-party requests are warned about only if the initial UI appears absent", () => {
  const snapshot = {
    ...baseSnapshot,
    headings: [], controls: [], statusText: [], sampleText: [],
    inspection: {
      mainDocumentStatus: 200, blockedCrossOriginRequests: 4,
      allowedCrossOriginRequests: 1, pageErrors: 0,
      blockedRequestKinds: { "script:GET": 1, "fetch:POST": 3 },
    },
  };
  const warnings = draftQualityWarnings("Verify the Login button", fixture, snapshot);
  assert.ok(warnings.some(w => w.includes("no visible application controls or page content")));
  assert.ok(warnings.some(w => w.includes("blocked 4 external request(s)")));
  const usableSnapshot = {...snapshot, headings: ["Login"]};
  const normal = draftQualityWarnings("Verify the Login button", fixture, usableSnapshot);
  assert.ok(!normal.some(w => w.includes("blocked 4 external request(s)")));
});

test("HTTP error status is surfaced without pretending it proves a bug", () => {
  const warnings = draftQualityWarnings("Check task list", fixture, {
    ...baseSnapshot, inspection: { mainDocumentStatus: 503, blockedCrossOriginRequests: 0, pageErrors: 0 },
  });
  assert.ok(warnings.some((w) => w.includes("HTTP 503")));
  assert.ok(!warnings.some((w) => w.includes("cross-origin")));
});
test("normal task fixture produces no quality warnings", () => {
  const warnings = draftQualityWarnings(
    "Add 'Prepare interview', complete it, then delete it.",
    fixture,
    baseSnapshot,
  );
  assert.deepEqual(warnings, []);
});
test("error verification requested explicitly is not mistaken for an unrequested error assertion", () => {
  const definition = {
    ...fixture, steps: [
      fixture.steps[0],
      { id: "error", description: "Verify expected error", action: {
        kind: "assert-text", target: { by: "text", value: "Access denied" },
        expected: "Access denied", provenance: "inferred",
      } },
    ],
  };
  const warnings = draftQualityWarnings("Verify the 'Access denied' message", definition, {
    ...baseSnapshot, statusText: ["Access denied"],
  });
  assert.ok(!warnings.some((w) => w.includes("false pass")));
});
