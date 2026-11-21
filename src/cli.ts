import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join, dirname, basename } from "node:path";
import { parseArgs } from "node:util";
import { runTest } from "./runner.js";
import { generatePlaywrightSpec } from "./export.js";

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
  if (positionals.length !== 2 ||
      (positionals[0] !== "run" && positionals[0] !== "export"))
    throw new Error(
      "Usage: npm run agent -- run <case.json> [--base-url URL] [--output DIR] [--headed] [--timeout MS]\n" +
      "   or: npm run agent -- export <case.json> [--base-url URL] [--output PATH.spec.ts] [--timeout MS]",
    );
  if (positionals[0] === "export") {
    // CLI export accepts a validated definition; the review UI download is
    // restricted to already-approved saved cases.
    const input = JSON.parse(await readFile(positionals[1], "utf8")) as unknown;
    const source = generatePlaywrightSpec(input, {
      baseURL: values["base-url"]!,
      timeoutMs: Number(values.timeout),
    });
    const filename = basename(positionals[1]).replace(/\.json$/i, "") + ".spec.ts";
    const file = resolve(values.output ?? join("generated", filename));
    if (!file.endsWith(".spec.ts")) {
      throw new Error("Playwright export output must end with .spec.ts");
    }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, source, { flag: "wx" });
    console.log("Exported standalone Playwright TypeScript: " + file);
    console.log("Review the test data before sharing or committing it.");
    return;
  }
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
