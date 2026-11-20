import { test, expect } from "@playwright/test";
import { readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runTest } from "../src/runner.js";
import type { TestDefinition } from "../src/domain.js";

const execute = promisify(execFile);
const baseURL = "http://127.0.0.1:3000";
async function example(): Promise<TestDefinition> {
  return JSON.parse(await readFile("examples/add-task.json", "utf8"));
}

test("executes the complete task lifecycle and isolates the next run", async ({
  browser,
}, info) => {
  const definition = await example();
  for (const number of [1, 2]) {
    const dir = info.outputPath(`run-${number}`);
    const report = await runTest(
      definition,
      { baseURL, outputDir: dir },
      browser,
    );
    expect(report.status).toBe("passed");
    expect(report.steps).toHaveLength(9);
    expect(report.steps.every((step) => step.status === "passed")).toBe(true);
    expect(report.evidenceErrors).toEqual([]);
    await info.attach(`run-${number}`, {
      path: join(dir, "report.json"),
      contentType: "application/json",
    });
  }
});

test("reports incorrect expectations, skips later steps and captures failure evidence", async ({
  browser,
}, info) => {
  const definition = await example();
  const action = definition.steps[1].action;
  if (action.kind === "assert-text") action.expected = "99 tasks, 0 completed";
  const dir = info.outputPath("runner");
  const report = await runTest(
    definition,
    { baseURL, outputDir: dir, timeoutMs: 300 },
    browser,
  );
  expect(report.status).toBe("assertion-failed");
  expect(report.steps[1]).toMatchObject({
    status: "assertion-failed",
    expected: "99 tasks, 0 completed",
    observed: "0 tasks, 0 completed",
  });
  expect(report.steps.slice(2).every((step) => step.status === "skipped")).toBe(
    true,
  );
  for (const file of ["report.json", "failure.png", "trace.zip"]) {
    expect((await stat(join(dir, file))).size).toBeGreaterThan(0);
    await info.attach(file, { path: join(dir, file) });
  }
  expect(report.evidenceErrors).toEqual([]);
});

test("reports missing targets as execution errors", async ({
  browser,
}, info) => {
  const definition = await example();
  definition.steps[3].action = {
    kind: "click",
    target: { by: "role", role: "button", name: "Missing button" },
  };
  const dir = info.outputPath("runner");
  const report = await runTest(
    definition,
    { baseURL, outputDir: dir, timeoutMs: 300 },
    browser,
  );
  expect(report.status).toBe("execution-error");
  expect(report.steps[3].status).toBe("execution-error");
  expect(report.steps.slice(4).every((step) => step.status === "skipped")).toBe(
    true,
  );
  expect(report.artifacts).toEqual({
    screenshot: "failure.png",
    trace: "trace.zip",
  });
  await info.attach("execution-error", { path: join(dir, "report.json") });
});

test("CLI runs a JSON case and returns exit zero", async ({}, info) => {
  const dir = info.outputPath("cli");
  const result = await execute(
    process.execPath,
    ["dist/cli.js", "run", "examples/add-task.json", "--output", dir],
    { timeout: 20000 },
  );
  expect(result.stdout).toContain("passed:");
  expect(
    JSON.parse(await readFile(join(dir, "report.json"), "utf8")).status,
  ).toBe("passed");
});

test("CLI returns exit one for an assertion failure", async ({}, info) => {
  const definition = await example();
  if (definition.steps[1].action.kind === "assert-text")
    definition.steps[1].action.expected = "Wrong status";
  const casePath = info.outputPath("wrong.json");
  await writeFile(casePath, JSON.stringify(definition));
  const dir = info.outputPath("cli");
  let exitCode: unknown;
  try {
    await execute(
      process.execPath,
      ["dist/cli.js", "run", casePath, "--output", dir, "--timeout", "300"],
      { timeout: 20000 },
    );
  } catch (error) {
    exitCode = (error as { code: unknown }).code;
  }
  expect(exitCode).toBe(1);
  expect(
    JSON.parse(await readFile(join(dir, "report.json"), "utf8")).status,
  ).toBe("assertion-failed");
});
