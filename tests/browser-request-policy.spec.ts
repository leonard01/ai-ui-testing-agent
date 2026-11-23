import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { installBrowserRequestPolicy } from "../src/browser-request-policy.js";

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
