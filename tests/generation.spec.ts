import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateDraft, type ModelProvider } from "../src/generation.js";
import { runTest } from "../src/runner.js";
import { fixtureProvider } from "../src/local-providers.js";
import type { TestDefinition } from "../src/domain.js";

test.use({ trace: "off" });
const baseURL = "http://127.0.0.1:3000";

async function fixture(): Promise<TestDefinition> {
  return JSON.parse(await readFile("examples/add-task.json", "utf8"));
}
function stub(definition: TestDefinition): ModelProvider {
  return async () => JSON.stringify(definition);
}
function markRequirements(definition: TestDefinition): void {
  for (const step of definition.steps) {
    if (step.action.kind === "assert-text" || step.action.kind === "assert-visible") {
      step.action.provenance = "requirements";
    }
  }
}
test("creates a valid review-only draft using a live page snapshot", async ({ browser }) => {
  const definition = await fixture();
  markRequirements(definition);
  const draft = await generateDraft({
    baseURL,
    model: "test-stub",
    requirements: "Adding a task must change the visible status",
  }, stub(definition), browser);
  expect(draft.needsReview).toBe(true);
  expect(draft.definition.steps).toHaveLength(9);
  expect(draft.snapshot.headings).toContain("Task list");
  expect(draft.snapshot.controls).toContainEqual({ kind: "button", name: "Add", type: "submit" });
  expect(draft.snapshot.controls).toContainEqual({ kind: "textbox", name: "Task", type: "text" });
});
test("offline fixture mode generates a valid draft and it runs with no model", async ({ browser }, info) => {
  const draft = await generateDraft({
    baseURL,
    model: "deterministic-fixture",
    requirements: "Add and complete a task then remove it",
  }, fixtureProvider(), browser);
  expect(draft.needsReview).toBe(true);
  expect(draft.definition.steps).toHaveLength(9);
  expect(draft.definition.steps.some(s =>
    (s.action.kind === "assert-text" || s.action.kind === "assert-visible") &&
    s.action.provenance === "human-confirmed"
  )).toBe(false);
  const report = await runTest(draft.definition, {
    baseURL, outputDir: info.outputPath("fixture-run"),
  }, browser);
  expect(report.status).toBe("passed");
});

test("rejects a model falsely claiming human confirmation", async ({ browser }) => {
  const definition = await fixture();
  await expect(generateDraft({
    baseURL, model: "test-stub", requirements: "Check task count",
  }, stub(definition), browser)).rejects.toThrow(/human-confirmed/);
});
test("rejects generated cross-origin navigation", async ({ browser }) => {
  const definition = await fixture();
  markRequirements(definition);
  if (definition.steps[0].action.kind === "navigate") {
    definition.steps[0].action.url = "https://example.org";
  }
  await expect(generateDraft({
    baseURL, model: "test-stub", requirements: "Check task count",
  }, stub(definition), browser)).rejects.toThrow(/configured HTTP/);
});

async function defectServer(): Promise<{ server: Server; url: string }> {
  const original = await readFile("demo/index.html", "utf8");
  const before = 'done = list.querySelectorAll("input:checked").length;';
  if (!original.includes(before)) throw new Error("Demo fixture unexpectedly changed");
  // Deliberately broken: checking a task fails to increment the completed count.
  const broken = original.replace(before, "done = 0; // intentional defect");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(broken);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}
test("requirement-based assertion detects an intentional completed-count defect", async ({ browser }, info) => {
  const definition = await fixture();
  markRequirements(definition);
  const { definition: draft } = await generateDraft({
    baseURL,
    model: "test-stub",
    requirements: await readFile("examples/requirements-task-list.md", "utf8"),
  }, stub(definition), browser);
  const good = await runTest(draft, { baseURL, outputDir: info.outputPath("good") }, browser);
  expect(good.status).toBe("passed");
  const { server, url } = await defectServer();
  try {
    const bad = await runTest(draft, {
      baseURL: url, outputDir: info.outputPath("seeded-defect"), timeoutMs: 700,
    }, browser);
    expect(bad.status).toBe("assertion-failed");
    expect(bad.steps.some(s => s.id === "completed" && s.status === "assertion-failed")).toBe(true);
    expect(bad.artifacts.screenshot).toBe("failure.png");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});
