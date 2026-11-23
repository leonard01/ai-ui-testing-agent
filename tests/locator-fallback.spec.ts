import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { parseTestDefinition } from "../src/schema.js";
import { runTest } from "../src/runner.js";
import { preflightSelectors } from "../src/preflight.js";
import { generatePlaywrightSpec } from "../src/export.js";

test.use({ trace: "off" });

function definition(url: string, by: "id" | "testid" | "css" | "xpath", value: string) {
  return parseTestDefinition({
    schemaVersion: 1, id: "locator-fallback", title: "Fallback locator", version: 1,
    steps: [
      {id: "open", description: "Open fixture", action: {kind: "navigate", url}},
      {id: "click", description: "Click Login", action: {kind: "click", target: {by, value}}},
      {id: "check", description: "Verify complete", action: {kind: "assert-text", target: {
        by: "testid", value: "status",
      }, expected: "Clicked once", provenance: "requirements"}},
    ],
  });
}

async function fixture(): Promise<{url: string; server: Server}> {
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end('<!doctype html><html><body>' +
      '<button id="loginButton" data-testid="login-button" name="submit-login">Log in</button>' +
      '<p data-testid="status">Waiting</p>' +
      '<script>document.querySelector("#loginButton").addEventListener("click", () => {' +
      'document.querySelector("[data-testid=status]").textContent = "Clicked once";' +
      '});</script></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {url: "http://127.0.0.1:" + (server.address() as AddressInfo).port, server};
}
async function shutdown(server: Server) {
  await new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

for (const [by, value, expectedSnippet] of [
  ["testid", "login-button", "page.getByTestId"],
  ["id", "loginButton", "page.locator"],
  ["css", "button[name='submit-login']", "page.locator"],
  ["xpath", "//button[@id='loginButton']", "page.locator"],
] as const) {
  test("explicit " + by + " selector passes and exports independently of Groq", async ({browser}, info) => {
    const {url, server} = await fixture();
    try {
      const input = definition(url, by, value);
      const spec = generatePlaywrightSpec(input, {baseURL: url});
      expect(spec).toContain(expectedSnippet);
      if (by === "css") expect(spec).toContain("css=");
      if (by === "xpath") expect(spec).toContain("xpath=");
      const preflight = await preflightSelectors(input, url, browser);
      expect(preflight.findings[0]).toMatchObject({stepId: "click", status: "matched", matches: 1});
      const report = await runTest(input, {baseURL:url,outputDir:info.outputPath(by)}, browser);
      expect(report.status, JSON.stringify(report,null,2)).toBe("passed");
    } finally { await shutdown(server); }
  });
}

test("missing and invalid CSS/XPath selectors produce reviewable preflight warnings", async ({browser}) => {
  const {url, server} = await fixture();
  try {
    for (const [by,value] of [
      ["css", "button.missing"],
      ["css", "button:nth-child("],
      ["xpath", "//button[@id='missing']"],
      ["xpath", "//*["],
    ] as const) {
      const report = await preflightSelectors(definition(url, by, value), url, browser);
      expect(report.findings[0].status).toBe("warning");
      expect(report.findings[0].stepNumber).toBe(2);
      expect(report.summary.warnings).toBeGreaterThan(0);
    }
  } finally { await shutdown(server); }
});

test("ambiguous XPath stays unapproved and fails closed at runtime", async ({browser}, info) => {
  const {url,server} = await fixture();
  try {
    const d = definition(url, "xpath", "//button | //p");
    const preflight = await preflightSelectors(d,url,browser);
    expect(preflight.findings[0]).toMatchObject({status:"warning",matches:2});
    const report = await runTest(d,{baseURL:url,outputDir:info.outputPath("ambiguous"),timeoutMs:350},browser);
    expect(report.status).toBe("execution-error");
    expect(report.steps.find(step=>step.id==="click")?.status).toBe("execution-error");
  } finally { await shutdown(server); }
});
