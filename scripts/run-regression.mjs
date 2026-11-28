import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { platform, arch, freemem } from "node:os";
import { createRun, writeMetadata, publishLatest } from "./regression-history.mjs";
import { detectProfile } from "./test-profile.mjs";

const args = process.argv.slice(2);
const profileArgs = args.filter(a => a.startsWith("--profile="));
if (profileArgs.length > 1 || profileArgs.includes("--profile=")) throw new Error("Specify one nonempty profile");
const env = { ...process.env };
if (profileArgs.length) env.TEST_PROFILE = profileArgs[0].slice("--profile=".length);
const selected = detectProfile(env);
const forwarded = args.filter(a => !a.startsWith("--profile="));
const overrides = forwarded.some(a => /^--(workers|global-timeout|config|output|reporter)(=|$)|^-c|^-j/.test(a));
if (overrides) throw new Error("Use a named profile with this runner; use npx playwright test for custom worker, timeout, config or report overrides.");
const gib = n => (n / 1024**3).toFixed(2);
console.log("\nRegression environment: " + (selected.ci ? "CI" : "local"));
console.log("CPU parallelism: " + selected.cores + " | RAM: " + gib(selected.totalBytes) + " GiB total, " + gib(selected.freeBytes) + " GiB free");
console.log("Profile: " + selected.profile + " | Workers: " + selected.workers + " | Global timeout: " + selected.globalTimeout/60000 + " min");
console.log("Reason: " + selected.reason);
console.log("Override: npm run test:low-spec / test:parallel / test:performance\n");
env.TEST_PROFILE = selected.profile;
const started = Date.now();
const { runId, directory } = createRun(resolve("regression-history"), selected.profile, new Date(started));
env.REGRESSION_RUN_DIR = directory;
const git = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
const dirty = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" });
const metadata = { schemaVersion: 1, runId, ...selected,
  startedAt: new Date(started).toISOString(), gitCommit: git.status === 0 ? git.stdout.trim() : null,
  trackedChanges: dirty.status === 0 ? Boolean(dirty.stdout.trim()) : null,
  platform: platform(), architecture: arch(), nodeVersion: process.version,
  arguments: forwarded, status: "running" };
writeMetadata(directory, metadata);
console.log("Run history: " + directory);
const run = spawnSync(process.execPath, [resolve("node_modules/@playwright/test/cli.js"), "test",
  "--workers="+selected.workers, "--global-timeout="+selected.globalTimeout, ...forwarded],
  {stdio:"inherit", env});
writeMetadata(directory, { ...metadata, status: run.status === 0 ? "passed" : "failed",
  completedAt: new Date().toISOString(), durationMs: Date.now()-started,
  freeBytesAtEnd: freemem(), exitCode: run.status, signal: run.signal,
  launchError: run.error?.code ?? null });
publishLatest(directory, resolve("test-results"), resolve("playwright-report"));
console.log("Historical reports: " + directory);
if (run.status !== 0 && !selected.ci && selected.workers > 1)
  console.log("If failures involve timing, compare with npm run test:low-spec. Failures remain failures.");
if (run.error) console.error(run.error.message);
process.exitCode = run.status ?? 1;
