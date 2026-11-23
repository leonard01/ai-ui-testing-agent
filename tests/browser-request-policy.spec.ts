import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { installBrowserRequestPolicy } from "../src/browser-request-policy.js";
import { inspectApplication } from "../src/inspect.js";
import { draftQualityWarnings } from "../src/draft-diagnostics.js";
import { preflightSelectors } from "../src/preflight.js";


test.use({ trace: "off" });

test("public HTTPS CDN script can populate page controls while local cross-origin scripts stay blocked", async ({ browser }) => {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>CDN fixture</title><main><h1>CDN fixture</h1>
      <script src="https://cdn.example.org/app.js"></script>
      <script src="http://localhost:9567/unwanted.js"></script>
      <p role="status">waiting</p>
      <script>document.querySelector('[role=status]').textContent =
        window.cdnLoaded === true ? 'ready' : 'missing resources';</script></main>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const context = await browser.newContext({ serviceWorkers: "block" });
  const counters = { allowedCrossOriginRequests: 0, blockedCrossOriginRequests: 0 };
  try {
    // Controlled fixture response; the browser never contacts a real CDN.
    await context.route("https://cdn.example.org/app.js", (route) => route.fulfill({
      status: 200, contentType: "application/javascript",
      body: "window.cdnLoaded = true;",
    }));
    await installBrowserRequestPolicy(context, origin, counters);
    const page = await context.newPage();
    await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("status")).toHaveText("ready");
    expect(counters.allowedCrossOriginRequests).toBeGreaterThanOrEqual(1);
    expect(counters.blockedCrossOriginRequests).toBeGreaterThanOrEqual(1);
  } finally {
    await context.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});


test("blocked background cross-origin requests are diagnostics, not draft-quality failures", async ({ browser }) => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      '<!doctype html><title>Working login page</title>' +
      '<main><h1>Login</h1><label>Username<input type="text"></label>' +
      '<button>Login</button><p>Sign in to continue</p></main>' +
      '<script>fetch("https://telemetry.example.org/collect", {method:"POST", ' +
      'headers: {"Content-Type":"text/plain"}, body:"metrics"}).catch(() => {});</script>',
    );
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseURL = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const definition = {
    schemaVersion: 1 as const, id: "login", title: "Login fixture", version: 1,
    steps: [
      {id: "open", description: "Open login", action: {kind: "navigate", url: baseURL}},
      {id: "verify", description: "Login visible", action: {
        kind: "assert-visible", target: {by: "role", role: "button", name: "Login"},
        provenance: "requirements",
      }},
    ],
  };
  try {
    const snapshot = await inspectApplication(baseURL, browser);
    expect(snapshot.headings).toContain("Login");
    expect(snapshot.controls.some(control => control.name === "Login")).toBe(true);
    expect(snapshot.inspection?.mainDocumentStatus).toBe(200);
    expect(snapshot.inspection?.blockedCrossOriginRequests).toBeGreaterThan(0);
    expect(snapshot.inspection?.blockedRequestKinds?.["fetch:POST"]).toBeGreaterThan(0);
    expect(draftQualityWarnings("Verify the Login button", definition as any, snapshot))
      .not.toContainEqual(expect.stringContaining("cross-origin"));

    // Preflight uses the same policy as inspection and runner, so that routine
    // background traffic does not suppress grounded starting-page targets.
    const preflight = await preflightSelectors(definition, baseURL, browser);
    expect(preflight.findings[0]).toMatchObject({
      stepId: "verify", status: "matched", matches: 1,
    });
  } finally {
    await new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});
