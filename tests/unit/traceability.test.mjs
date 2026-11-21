import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildTraceabilityReport, parseTestDefinition } from "../../dist/index.js";

const source = JSON.parse(await readFile(
  new URL("../../examples/add-task.json", import.meta.url), "utf8"));

test("report classifies human-selected links, inferred-only assertions and gaps", () => {
  const definition = structuredClone(source);
  definition.steps.find((step) => step.id === "empty").action.provenance = "inferred";
  definition.requirements = [
    { id: "R1", text: "User can add and see a task", stepIds: ["enter", "add", "visible"] },
    { id: "R2", text: "User can mark complete", stepIds: ["complete"] },
    { id: "R3", text: "Initially no tasks", stepIds: ["empty"] },
    { id: "R4", text: "Filtered tasks are visible", stepIds: [] },
  ];
  const report = buildTraceabilityReport(definition);
  assert.equal(report.reviewOnly, true);
  assert.deepEqual(report.summary, {
    total: 4, unmapped: 1, stepsOnly: 1,
    inferredAssertion: 1, assertionLinked: 1,
  });
  assert.equal(report.requirements[0].status, "assertion-linked");
  assert.deepEqual(report.requirements[0].assertions.map((a) => a.stepId), ["visible"]);
  assert.equal(report.requirements[2].assertions[0].provenance, "inferred");
  assert.equal(report.requirements[3].status, "unmapped");
  assert.deepEqual(report.unlinkedAssertions.map((entry) => entry.stepId),
    ["completed", "cleared"]);
  assert.equal(parseTestDefinition(definition).requirements.length, 4);
});

test("previous JSON tests remain compatible and do not imply coverage", () => {
  const report = buildTraceabilityReport(source);
  assert.equal(report.summary.total, 0);
  assert.equal(report.summary.assertionLinked, 0);
  assert.equal(report.unlinkedAssertions.length, 4);
});

test("invalid or duplicate references, IDs and unsupported trace metadata are rejected", () => {
  const invalidCases = [
    [{ id: "R1", text: "Known", stepIds: ["does-not-exist"] }],
    [{ id: "R1", text: "Known", stepIds: ["add", "add"] }],
    [{ id: "R1", text: "Known", stepIds: [] },
     { id: "R1", text: "Duplicate", stepIds: [] }],
    [{ id: "", text: "Missing ID", stepIds: [] }],
    [{ id: "R1", text: "", stepIds: [] }],
    [{ id: "R1", text: "Extra field", stepIds: [], aiConfirmed: true }],
    Array.from({ length: 41 }, (_, i) => ({
      id: "R" + i, text: "Required", stepIds: [],
    })),
  ];
  for (const requirements of invalidCases) {
    const definition = structuredClone(source);
    definition.requirements = requirements;
    assert.throws(() => parseTestDefinition(definition));
    assert.throws(() => buildTraceabilityReport(definition));
  }
  const validEmpty = structuredClone(source);
  validEmpty.requirements = [];
  assert.equal(buildTraceabilityReport(validEmpty).summary.total, 0);
});
