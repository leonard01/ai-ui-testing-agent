import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, "test-results", "token-benchmarks");
await mkdir(directory, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const report = join(directory, "token-benchmark-" + stamp + "-" + process.pid + ".txt");
const latest = join(directory, "latest.txt");
await writeFile(report, "Offline token benchmark\nStarted: " + new Date().toISOString() + "\nNode: " + process.version + "\nNo hosted AI requests are made.\n", { flag: "wx" });

async function run(label, args) {
  await appendFile(report, "\n--- " + label + " ---\n");
  console.log(label);
  return new Promise((done) => {
    let writes = Promise.resolve();
    const child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const capture = (chunk, output) => {
      output.write(chunk);
      writes = writes.then(() => appendFile(report, chunk));
    };
    child.stdout.on("data", chunk => capture(chunk, process.stdout));
    child.stderr.on("data", chunk => capture(chunk, process.stderr));
    child.on("error", error => capture(Buffer.from(error.message + "\n"), process.stderr));
    child.on("close", (code, signal) => {
      writes.then(async () => {
        await appendFile(report, "\nExit: " + (code ?? signal ?? "unknown") + "\n");
        done(code ?? 1);
      }).catch(error => { console.error("Report write failed:", error.message); done(1); });
    });
  });
}

let code = 1;
try {
  code = await run("Build", [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"]);
  if (code === 0) {
    code = await run("Token regression tests", ["--test", "tests/unit/token-estimation.test.mjs"]);
  } else {
    await appendFile(report, "\nTests not run because the build failed.\n");
  }
} finally {
  await appendFile(report, "\nFinal status: " + (code === 0 ? "PASSED" : "FAILED") + "\nFinished: " + new Date().toISOString() + "\n");
  const { copyFile } = await import("node:fs/promises");
  await copyFile(report, latest);
  console.log("\nReport saved to: " + report);
  console.log("Latest report: " + latest);
}
process.exitCode = code;
