import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { generateDraft } from "../src/generation.js";
import { createReviewServer } from "../src/review-server.js";
import { runTest } from "../src/runner.js";
import { generatePlaywrightSpec } from "../src/export.js";
import {
  requireHumanCredentialValues, unresolvedCredentialSteps,
  assertCredentialsReviewed, USERNAME_REVIEW_PLACEHOLDER,
  PASSWORD_REVIEW_PLACEHOLDER,
} from "../src/credential-guard.js";
import { parseTestDefinition } from "../src/schema.js";

const site = "http://127.0.0.1:3000";
function proposedLogin() {
  return parseTestDefinition({
    schemaVersion: 1, id: "login-case", title: "Login then shop", version: 1,
    steps: [
      { id: "open", description: "Open shop", action: { kind: "navigate", url: site } },
      { id: "username", description: "Enter username", action: {
        kind: "fill", target: { by: "label", value: "Username" }, value: "AI_GUESSED_USER",
      } },
      { id: "password", description: "Enter password", action: {
        kind: "fill", target: { by: "label", value: "Password" }, value: "AI_GUESSED_PASSWORD",
      } },
      { id: "login", description: "Click Login", action: {
        kind: "click", target: { by: "role", role: "button", name: "Login" },
      } },
      { id: "verify", description: "Verify products page", action: {
        kind: "assert-visible", target: { by: "text", value: "Products" },
        provenance: "requirements",
      } },
    ],
  });
}

test("sanitizes model-authored username and password but not unrelated inputs", () => {
  const definition = proposedLogin();
  definition.steps.splice(3, 0, {
    id: "shipping", description: "Enter shipping city", action: {
      kind: "fill", target: { by: "label", value: "City" }, value: "Belfast",
    },
  });
  expect(requireHumanCredentialValues(definition)).toBe(2);
  expect(definition.steps[1].action).toMatchObject({
    kind: "fill", value: USERNAME_REVIEW_PLACEHOLDER,
  });
  expect(definition.steps[2].action).toMatchObject({
    kind: "fill", value: PASSWORD_REVIEW_PLACEHOLDER,
  });
  expect(definition.steps[3].action).toMatchObject({
    kind: "fill", value: "Belfast",
  });
  expect(unresolvedCredentialSteps(definition)).toEqual([2, 3]);
  expect(() => assertCredentialsReviewed(definition)).toThrow(/step\(s\) 2, 3/);

  // Explicit tester-provided replacements are not re-scrubbed at save time.
  const user = definition.steps[1].action;
  const pass = definition.steps[2].action;
  if (user.kind === "fill") user.value = "confirmed-demo-user";
  if (pass.kind === "fill") pass.value = "confirmed-demo-password";
  expect(unresolvedCredentialSteps(definition)).toEqual([]);
  expect(() => assertCredentialsReviewed(definition)).not.toThrow();
});

test("model placeholder variations are not executable", () => {
  const definition = proposedLogin();
  const pass = definition.steps[2].action;
  if (pass.kind === "fill") pass.value = "REPLACE_WITH_YOUR_PASSWORD";
  expect(() => assertCredentialsReviewed(definition)).toThrow(/tester review/);
});

test("AI-generation output cannot retain fabricated login values", async ({ browser }) => {
  const result = await generateDraft({
    baseURL: site, model: "mock", requirements: "Log in and verify Products",
  }, async () => JSON.stringify(proposedLogin()), browser);
  expect(result.needsReview).toBe(true);
  expect(result.definition.steps[1].action).toMatchObject({
    kind: "fill", value: USERNAME_REVIEW_PLACEHOLDER,
  });
  expect(result.definition.steps[2].action).toMatchObject({
    kind: "fill", value: PASSWORD_REVIEW_PLACEHOLDER,
  });
  const report = await runTest(result.definition, {
    baseURL: site, outputDir: join(tmpdir(), "nonexistent-guard-report"),
  }, browser);
  expect(report.status).toBe("execution-error");
  expect(report.error).toContain("Credential values require tester review");
  expect(() => generatePlaywrightSpec(result.definition, { baseURL: site }))
    .toThrow(/Credential values require tester review/);
});

test("server rejects executable placeholder but permits partial working draft", async ({ page, browser }) => {
  const dir = await mkdtemp(join(tmpdir(), "credential-guard-"));
  const server = await createReviewServer(dir, browser);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const reviewURL = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  try {
    const definition = proposedLogin();
    requireHumanCredentialValues(definition);
    await page.goto(reviewURL);
    const request = async (path: string, body: unknown) => page.evaluate(
      async ({path, body}) => {
        const response = await fetch(path, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: response.status, data: await response.json() };
      }, { path, body },
    );
    const rejected = await request("/api/save", {
      baseURL: site, testName: "Shop after login", definition,
    });
    expect(rejected.status).toBe(400);
    expect(rejected.data.error).toContain("Credential values require tester review");

    const draft = await request("/api/drafts/save", {
      baseURL: site, testName: "Shop after login", definition,
      sourceInstructions: "Add to cart after login",
      workingInstructions: "Add to cart after login",
      approvedStepIds: [],
    });
    expect(draft.status).toBe(200);
    expect(draft.data.id).toMatch(/^draft-/);

    for (const step of definition.steps) {
      if (step.action.kind !== "fill") continue;
      if (step.id === "username") step.action.value = "confirmed-demo-user";
      if (step.id === "password") step.action.value = "confirmed-demo-password";
    }
    const saved = await request("/api/save", {
      baseURL: site, testName: "Shop after login", definition,
    });
    expect(saved.status).toBe(200);
    expect(saved.data.id).toMatch(/^reviewed-/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, {recursive: true, force: true});
  }
});
