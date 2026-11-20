import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { runTest } from "./runner.js";

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "base-url": { type: "string", default: "http://127.0.0.1:3000" },
      output: { type: "string" },
      headed: { type: "boolean", default: false },
      timeout: { type: "string", default: "5000" },
    },
  });
  if (positionals.length !== 2 || positionals[0] !== "run")
    throw new Error(
      "Usage: npm run agent -- run <case.json> [--base-url URL] [--output DIR] [--headed] [--timeout MS]",
    );
  const outputDir = resolve(
    values.output ?? `run-results/${Date.now()}-${process.pid}`,
  );
  let input: unknown;
  try {
    input = JSON.parse(await readFile(positionals[1], "utf8"));
  } catch (error) {
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      join(outputDir, "report.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          testId: null,
          title: null,
          status: "execution-error",
          startedAt: new Date().toISOString(),
          durationMs: 0,
          steps: [],
          error: `Unable to read test case: ${error instanceof Error ? error.message : String(error)}`,
          artifacts: {},
          evidenceErrors: [],
        },
        null,
        2,
      ) + "\n",
    );
    console.error(
      `execution-error: unable to read test case. Report: ${join(outputDir, "report.json")}`,
    );
    process.exitCode = 2;
    return;
  }
  const report = await runTest(input, {
    baseURL: values["base-url"]!,
    outputDir,
    headed: values.headed,
    timeoutMs: Number(values.timeout),
  });
  console.log(`${report.status}: ${report.title ?? "Invalid test definition"}`);
  console.log(`Report: ${join(outputDir, "report.json")}`);
  process.exitCode =
    report.status === "passed"
      ? 0
      : report.status === "assertion-failed"
        ? 1
        : 2;
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
