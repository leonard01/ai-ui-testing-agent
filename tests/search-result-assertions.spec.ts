import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { runTest } from "../src/runner.js";
import { generateDraft } from "../src/generation.js";
import { generatePlaywrightSpec } from "../src/export.js";

test.use({ trace: "off" });

const steps = (url: string) => ({
  schemaVersion: 1 as const,
  id: "search-shoes",
  title: "Search for shoes",
  version: 1,
  steps: [
    { id: "open", description: "Open search page", action: { kind: "navigate", url } },
    { id: "fill", description: "Enter shoes", action: {
      kind: "fill", target: { by: "placeholder", value: "Search" }, value: "shoes",
    } },
    { id: "submit", description: "Submit search", action: {
      kind: "press", target: { by: "placeholder", value: "Search" }, key: "Enter",
    } },
    { id: "verify", description: "Verify returned result contains shoes", action: {
      kind: "assert-text", target: { by: "text", value: "shoes" },
      expected: "shoes", match: "contains", scope: "search-results", provenance: "requirements",
    } },
  ],
});

async function fixturePage(result: "match" | "unrelated" | "none"): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (req.url?.startsWith("/search?")) {
      // A submit with no entered query must not magically return results.
      const searched = new URL(req.url, "http://127.0.0.1").searchParams.get("q");
      const cards = searched !== "shoes" ? "" : result === "match"
        ? '<article data-testid="search-result">Comfortable running SHOES for women</article>'
        : result === "unrelated"
          ? '<article data-testid="search-result">Waterproof boots for hiking</article>'
          : "";
      res.end(`<!doctype html><html><title>Search</title>
      <header><h1>Results for shoes</h1><nav>Shoes | Men | Women</nav></header>
      <main><section aria-label="Search results">${cards}</section></main></html>`);
    } else {
      res.end(`<!doctype html><html><title>Search</title>
      <header><h1>Search for shoes</h1><nav>Shoes | Men | Women</nav></header>
      <main><form action="/search"><input name="q" placeholder="Search">
      <button type="submit">Search</button></form></main></html>`);
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, url: "http://127.0.0.1:" + (server.address() as AddressInfo).port };
}

for (const result of ["match", "unrelated", "none"] as const) {
  test("scoped search assertion " + (
    result === "match" ? "accepts matching card" :
      result === "unrelated" ? "rejects query echoed outside unrelated result" :
        "rejects query in heading with no result cards"
  ), async ({ browser }, info) => {
    const { server, url } = await fixturePage(result);
    try {
      const report = await runTest(steps(url), {
        baseURL: url, outputDir: info.outputPath("run"), timeoutMs: 650,
      }, browser);
      const assertion = report.steps[3];
      if (result === "match") {
        expect(report.status).toBe("passed");
        expect(assertion).toMatchObject({ status: "passed", textMatch: "contains" });
        expect(assertion.observed).toContain("SHOES");
      } else {
        expect(report.status).toBe("assertion-failed");
        expect(assertion.status).toBe("assertion-failed");
        expect(assertion.error).toContain("Search-result assertion failed");
        if (result === "none") {
          expect(assertion.error).toContain("No identifiable search-result cards");
        }
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close(error => error ? reject(error) : resolve()));
    }
  });
}

test("AI draft missing a query fill restores type-then-Enter and actually searches", async ({ browser }, info) => {
  const { server, url } = await fixturePage("match");
  try {
    const proposal = steps(url);
    // Reproduce the generated Google draft: description claims typing, but JSON only presses Enter.
    proposal.steps.splice(1, 1);
    proposal.steps[1].description = "Enter 'shoes' in search box and submit";
    const original = structuredClone(proposal);
    const requirements = "search for 'shoes'\nvalidate a return contains the text shoes";

    // The bad draft cannot pass even though the query is visible on the home page.
    const uncorrected = await runTest(original, {
      baseURL: url, outputDir: info.outputPath("without-fill"), timeoutMs: 650,
    }, browser);
    expect(uncorrected.status).toBe("assertion-failed");

    const generated = await generateDraft({
      baseURL: url, model: "mock-model", requirements,
    }, async () => JSON.stringify(proposal), browser);
    expect(generated.definition.steps.map(step => step.action.kind)).toEqual([
      "navigate", "fill", "press", "assert-text",
    ]);
    const fill = generated.definition.steps[1].action;
    const press = generated.definition.steps[2].action;
    expect(fill.kind).toBe("fill");
    expect(press.kind).toBe("press");
    if (fill.kind === "fill" && press.kind === "press") {
      expect(fill.value).toBe("shoes");
      expect(fill.target).toEqual(press.target);
    }
    const check = generated.definition.steps[3].action;
    expect(check.kind).toBe("assert-text");
    if (check.kind === "assert-text") expect(check.scope).toBe("search-results");

    const corrected = await runTest(generated.definition, {
      baseURL: url, outputDir: info.outputPath("with-fill"), timeoutMs: 1500,
    }, browser);
    expect(corrected.status).toBe("passed");
    expect(corrected.steps.map(step => step.status)).toEqual([
      "passed", "passed", "passed", "passed",
    ]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()));
  }
});

test("AI draft matching the user search query is deterministically scoped to results", async ({ browser }) => {
  const { server, url } = await fixturePage("match");
  try {
    const proposed = steps(url);
    const last = proposed.steps[3].action as Record<string, unknown>;
    delete last.scope;
    delete last.match;
    const generated = await generateDraft({
      baseURL: url, model: "mock-model",
      requirements: "search for 'shoes'\nvalidate a return contains the text shoes",
    }, async () => JSON.stringify(proposed), browser);
    const action = generated.definition.steps[3].action;
    expect(action.kind).toBe("assert-text");
    if (action.kind === "assert-text") {
      expect(action.scope).toBe("search-results");
      expect(action.match).toBe("contains");
    }
    const exported = generatePlaywrightSpec(generated.definition, { baseURL: url });
    expect(exported).toContain("const resultCards = page.locator(");
    expect(exported).toContain("const resultPattern = new RegExp(");
    expect(exported).not.toContain('getByText("shoes"');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()));
  }
});

test("ordinary text assertions and unrelated expected values remain unscoped", async ({ browser }) => {
  const { server, url } = await fixturePage("match");
  try {
    const proposed = steps(url);
    const action = proposed.steps[3].action as Record<string, unknown>;
    delete action.scope;
    delete action.match;
    const generated = await generateDraft({
      baseURL: url, model: "mock-model",
      requirements: "Open the page and check that shoes appears as an existing page label",
    }, async () => JSON.stringify(proposed), browser);
    const assertion = generated.definition.steps[3].action;
    expect(assertion.kind).toBe("assert-text");
    if (assertion.kind === "assert-text") expect(assertion.scope).toBeUndefined();
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()));
  }
});
