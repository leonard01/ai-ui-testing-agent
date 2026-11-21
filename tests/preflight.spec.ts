import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { preflightSelectors } from "../src/preflight.js";
import type { TestDefinition } from "../src/domain.js";

test("preflight identifies grounded alternatives, ambiguity and dynamic targets without clicking", async ({ browser }) => {
  let mutations = 0;
  const server = createServer((req, res) => {
    if (req.url === "/mutation") {
      mutations++;
      res.writeHead(200);
      res.end("mutated");
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><title>Preflight fixture</title>
      <span>Products</span>
      <label>Task <input type="text"></label>
      <button>Add</button><button>Save</button><button>Save</button>
      <button onclick="fetch('/mutation', {method:'POST'})">Danger</button>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseURL = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const definition: TestDefinition = {
    schemaVersion: 1, id: "preflight-test", title: "Read-only preflight", version: 1,
    steps: [
      { id: "open", description: "Open fixture", action: { kind: "navigate", url: "/" } },
      { id: "heading", description: "Locate page title", action: {
        kind: "assert-visible", target: { by: "role", role: "heading", name: "Products" }, provenance: "requirements",
      } },
      { id: "duplicate", description: "Check duplicate action", action: {
        kind: "click", target: { by: "role", role: "button", name: "Save" },
      } },
      { id: "fill", description: "Enter task", action: {
        kind: "fill", target: { by: "label", value: "Task" }, value: "A new task",
      } },
      { id: "wrong-label", description: "Add task", action: {
        kind: "click", target: { by: "label", value: "Add" },
      } },
      { id: "future", description: "Assert dynamically added task", action: {
        kind: "assert-visible", target: { by: "text", value: "A new task" }, provenance: "requirements",
      } },
      { id: "danger", description: "Should never click", action: {
        kind: "click", target: { by: "role", role: "button", name: "Danger" },
      } },
    ],
  };
  const original = JSON.stringify(definition);
  try {
    const report = await preflightSelectors(definition, baseURL, browser);
    expect(report.readOnly).toBe(true);
    expect(report.inspectedURL).toBe(baseURL + "/");
    expect(report.summary.warnings).toBe(3);
    expect(report.findings.find((f) => f.stepId === "heading")).toMatchObject({
      status: "warning", matches: 0, suggestedTarget: { by: "text", value: "Products" },
    });
    expect(report.findings.find((f) => f.stepId === "duplicate")).toMatchObject({
      status: "warning", matches: 2,
    });
    expect(report.findings.find((f) => f.stepId === "wrong-label")).toMatchObject({
      status: "warning", matches: 0, suggestedTarget: { by: "role", role: "button", name: "Add" },
    });
    expect(report.findings.find((f) => f.stepId === "future")?.status).toBe("deferred");
    expect(report.findings.find((f) => f.stepId === "danger")?.status).toBe("initial-match");
    expect(mutations).toBe(0);
    expect(JSON.stringify(definition)).toBe(original);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});

test("preflight refuses navigation outside configured origin before opening pages", async ({ browser }) => {
  const definition = {
    schemaVersion: 1, id: "unsafe", title: "Unsafe", version: 1,
    steps: [
      { id: "open", description: "Open", action: { kind: "navigate", url: "/" } },
      { id: "check", description: "Check", action: {
        kind: "assert-visible", target: { by: "role", role: "heading" }, provenance: "requirements",
      } },
      { id: "escape", description: "Escape", action: {
        kind: "navigate", url: "https://example.com/",
      } },
    ],
  };
  await expect(preflightSelectors(definition, "http://127.0.0.1:3000", browser))
    .rejects.toThrow("URL must remain on the configured HTTP(S) application origin");
});
