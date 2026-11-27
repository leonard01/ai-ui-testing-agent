import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { detectProfile } from "./test-profile.mjs";

const args = process.argv.slice(2);
const profileArgs = args.filter(a => a.startsWith("--profile="));
if (profileArgs.length > 1) throw new Error("Specify only one profile");
const env = { ...process.env };
if (profileArgs.length) env.TEST_PROFILE = profileArgs[0].slice("--profile=".length);
const selected = detectProfile(env);
const forwarded = args.filter(a => !a.startsWith("--profile="));
const overrides = forwarded.some(a => /^--(workers|global-timeout|config)(=|$)|^-c$|^-j/.test(a));
if (overrides) throw new Error("Use a named profile with this runner; use npx playwright test for custom worker, timeout or config overrides.");
const gib = n => (n / 1024**3).toFixed(2);
console.log("\nRegression environment: " + (selected.ci ? "CI" : "local"));
console.log("CPU parallelism: " + selected.cores + " | RAM: " + gib(selected.totalBytes) + " GiB total, " + gib(selected.freeBytes) + " GiB free");
console.log("Profile: " + selected.profile + " | Workers: " + selected.workers + " | Global timeout: " + selected.globalTimeout/60000 + " min");
console.log("Reason: " + selected.reason);
console.log("Override: npm run test:low-spec / test:parallel / test:performance\n");
env.TEST_PROFILE = selected.profile;
const started = Date.now();
const run = spawnSync(process.execPath, [resolve("node_modules/@playwright/test/cli.js"), "test",
  "--workers="+selected.workers, "--global-timeout="+selected.globalTimeout, ...forwarded],
  {stdio:"inherit", env});
mkdirSync("test-results", {recursive:true});
writeFileSync("test-results/environment.json", JSON.stringify({...selected, startedAt:new Date(started).toISOString(),
  durationMs:Date.now()-started, exitCode:run.status, signal:run.signal, arguments:forwarded},null,2)+"\n");
if (run.status !== 0 && !selected.ci && selected.workers > 1)
  console.log("If failures involve timing, compare with npm run test:low-spec. Failures remain failures.");
if (run.error) console.error(run.error.message);
process.exitCode = run.status ?? 1;
