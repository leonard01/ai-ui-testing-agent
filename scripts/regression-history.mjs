import { mkdirSync, cpSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export function createRun(root, profile, now = new Date()) {
  const runId = now.toISOString().replace(/[:.]/g, "-") + "-" + profile + "-" + randomUUID();
  const directory = join(root, runId);
  mkdirSync(directory, { recursive: true });
  return { runId, directory };
}

export function writeMetadata(directory, metadata) {
  writeFileSync(join(directory, "environment.json"), JSON.stringify(metadata, null, 2) + "\n");
}

// Latest convenience copies are separate from the immutable per-run evidence.
export function publishLatest(directory, latestResults, latestHtml) {
  mkdirSync(latestResults, { recursive: true });
  for (const name of ["junit.xml", "environment.json", "regression-evidence"]) {
    const destination = join(latestResults, name);
    rmSync(destination, { recursive: true, force: true });
    const source = join(directory, name);
    if (existsSync(source)) cpSync(source, destination, { recursive: true });
  }
  rmSync(latestHtml, { recursive: true, force: true });
  const html = join(directory, "playwright-report");
  if (existsSync(html)) cpSync(html, latestHtml, { recursive: true });
}
