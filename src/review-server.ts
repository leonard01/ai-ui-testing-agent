import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, type Dirent } from "node:fs";
import { mkdir, readFile, readdir, rm, unlink, writeFile, rmdir } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { generateDraft, GeneratedDraftValidationError, type ModelProvider } from "./generation.js";
import { fixtureProvider } from "./local-providers.js";
import { groqProvider, GroqProviderError } from "./hosted-providers.js";
import { parseTestDefinition } from "./schema.js";
import { ensureAllowedNavigation } from "./inspect.js";
import { searchCapturedAssertionText, type AssertionSearchEntry } from "./discovery.js";
import { runTest } from "./runner.js";
import { preflightSelectors } from "./preflight.js";
import { generatePlaywrightSpec } from "./export.js";
import { buildTraceabilityReport } from "./traceability.js";
import { SAVED_NAME, websiteOrigin, websiteDirectory, listSavedFiles, findSavedFile } from "./site-storage.js";
import type { Browser } from "playwright";
import type { RunReport, TestDefinition } from "./domain.js";

const MAX_BODY_BYTES = 110_000;
const MAX_REQUIREMENTS_CHARS = 12_000;
const RUN_ID = /^[a-f0-9-]{36}$/;
const MAX_RUN_HISTORY = 1000;
const MAX_SUITE_HISTORY = 1000;
const HISTORY_PAGE_SIZE = 10;
const MAX_SUITE_CASES = 10;

type RunJob = {
  id: string;
  fileId: string;
  state: "running" | "finished" | "error";
  startedAt: string;
  outputDir: string;
  report?: RunReport;
  error?: string;
  /** Short-lived DOM evidence held in memory, never included in reports. */
  assertionSearchIndex?: Map<string, AssertionSearchEntry[]>;
  suiteId?: string;
  baseURL?: string;
};

type SuiteEntry = {
  fileId: string;
  title: string;
  state: "queued" | "running" | "finished" | "error";
  runId?: string;
  verdict?: RunReport["status"];
  durationMs?: number;
  error?: string;
};

type SuiteJob = {
  id: string;
  state: "running" | "finished";
  startedAt: string;
  finishedAt?: string;
  baseURL: string;
  entries: SuiteEntry[];
};

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data));
}

async function readJSON(req: IncomingMessage): Promise<unknown> {
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
    throw new Error("This endpoint requires application/json");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_BODY_BYTES) throw new Error("Request too large");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("Invalid JSON request");
  }
}

function localOrigin(req: IncomingMessage): boolean {
  const host = req.headers.host ?? "";
  const origin = req.headers.origin;
  return /^127\.0\.0\.1:\d+$/.test(host) && (!origin || origin === "http://" + host);
}

function requestDetails(body: unknown): { baseURL: string; requirements: string; provider: "groq" | "fixture" } {
  if (!body || typeof body !== "object") throw new Error("Expected a request object");
  const data = body as Record<string, unknown>;
  if (typeof data.baseURL !== "string" || !data.baseURL.trim()) {
    throw new Error("Please enter the application URL");
  }
  const url = new URL(data.baseURL);
  ensureAllowedNavigation(url.href, url);
  if (typeof data.requirements !== "string" || !data.requirements.trim()) {
    throw new Error("Enter a test instruction or import a requirements file");
  }
  if (data.requirements.length > MAX_REQUIREMENTS_CHARS) {
    throw new Error("Requirements exceed 12,000 characters");
  }
  if (data.provider !== "groq" && data.provider !== "fixture") {
    throw new Error("Choose an explicit generation provider (groq or fixture)");
  }
  return { baseURL: url.href, requirements: data.requirements, provider: data.provider };
}

function validatedBaseURL(raw: unknown): URL {
  if (typeof raw !== "string") throw new Error("Application URL is required");
  const base = new URL(raw);
  ensureAllowedNavigation(base.href, base);
  return base;
}

function verifyNavigations(definition: TestDefinition, base: URL): void {
  for (const step of definition.steps) {
    if (step.action.kind === "navigate") ensureAllowedNavigation(step.action.url, base);
    if (step.action.kind === "assert-url") ensureAllowedNavigation(step.action.expected, base);
  }
}

function firstFailure(report: RunReport) {
  return report.steps.find((step) =>
    step.status === "assertion-failed" || step.status === "execution-error",
  );
}

/** Deterministic diagnostic suggestions. No AI call and no silent assertion repair. */
export function diagnoseRun(report: RunReport): { kind: string; explanation: string; suggestion: string } {
  if (report.status === "passed") return {
    kind: "passed",
    explanation: "All steps passed.",
    suggestion: "The result shows successful execution, not proof that the scenario is complete or requirements are correct.",
  };
  const step = firstFailure(report);
  const error = step?.error ?? report.error ?? "";
  if (report.status === "assertion-failed") return {
    kind: "assertion-mismatch",
    explanation: "The browser found the assertion target, but its content did not match the expected result.",
    suggestion: "Compare expected and observed values with the requirements. Check whether an earlier action changed the page. Do not change an expectation simply to make the test pass.",
  };
  if (/Ambiguous intent|strict mode violation|exactly one element/i.test(error)) return {
    kind: "ambiguous-target",
    explanation: "The proposed target identifies multiple possible elements.",
    suggestion: "Review the step and specify its surrounding section, role or exact target. Do not pick the first match blindly.",
  };
  if (/Could not resolve intent|waiting for getBy|locator\.|Timeout .* exceeded|Target closed/i.test(error)) return {
    kind: "locator-or-timing",
    explanation: "An interaction or target lookup could not complete.",
    suggestion: "Check the target's role, visible text and nearby context; compare the DOM evidence and screenshot. A longer timeout only helps genuinely slow pages.",
  };
  if (/browserType\.launch|browser has been closed|Executable doesn't exist/i.test(error)) return {
    kind: "environment",
    explanation: "The browser could not launch or was unexpectedly closed.",
    suggestion: "Check the Playwright Chromium installation and available system memory, then retry headless.",
  };
  return {
    kind: "execution-error",
    explanation: "The runner encountered an execution error that needs investigation.",
    suggestion: "Review the first failed step, the captured error, screenshot, and Playwright trace.",
  };
}

/**
 * Lightweight loopback-only test review UI. No API keys are sent to the browser.
 * Saving an approved draft never executes it. Safe for local development only:
 * there is deliberately no public-network listener or user authentication.
 */
export async function createReviewServer(outputDir = "generated", suppliedBrowser?: Browser, groqOverride?: ModelProvider) {
  const html = await readFile(new URL("../demo/review.html", import.meta.url));
  const savedDir = resolve(outputDir);
  const resultsDir = resolve(outputDir === "generated" ? "run-results" : join(outputDir, "run-results"));
  const jobs = new Map<string, RunJob>();
  const suites = new Map<string, SuiteJob>();
  let activeRun: string | null = null;
  let activePreflight = false;
  let activeDeletion = false;

  function registerRun(fileId: string, suiteId?: string, baseURL?: string): RunJob {
    const id = randomUUID();
    const job: RunJob = {
      id, fileId, state: "running", startedAt: new Date().toISOString(),
      outputDir: join(resultsDir, id), assertionSearchIndex: new Map(), suiteId, baseURL,
    };
    jobs.set(id, job);
    while (jobs.size > MAX_RUN_HISTORY) {
      const oldest = jobs.keys().next().value;
      if (!oldest || oldest === activeRun) break;
      jobs.delete(oldest);
    }
    return job;
  }

  function suiteSnapshot(suite: SuiteJob) {
    const completed = suite.entries.filter((entry) =>
      entry.state === "finished" || entry.state === "error").length;
    const passed = suite.entries.filter((entry) => entry.verdict === "passed").length;
    const failed = suite.entries.filter((entry) =>
      entry.verdict === "assertion-failed" || entry.verdict === "execution-error").length;
    const errors = suite.entries.filter((entry) => entry.state === "error").length;
    return {
      id: suite.id, state: suite.state, startedAt: suite.startedAt,
      finishedAt: suite.finishedAt, baseURL: suite.baseURL,
      verdict: suite.state === "running" ? "running" :
        passed === suite.entries.length ? "passed" : "failed",
      summary: {
        total: suite.entries.length, completed, passed, failed, errors,
        remaining: suite.entries.length - completed,
      },
      tests: suite.entries.map((entry) => ({
        ...entry,
        report: entry.runId && jobs.has(entry.runId)
          ? "/api/runs/" + entry.runId + "/report.json" : undefined,
        detailAvailable: Boolean(entry.runId && jobs.has(entry.runId)),
      })),
      report: suite.state === "finished"
        ? "/api/suites/" + suite.id + "/report.json" : undefined,
    };
  }


  // Run reports and suite reports are already persisted by the execution layer.
  // Keep a small metadata sidecar for the saved-test identity and suite membership;
  // no secret inputs, browser state or captured DOM evidence are stored here.
  async function persistRun(job: RunJob, state: "finished" | "error"): Promise<void> {
    await mkdir(job.outputDir, { recursive: true });
    await writeFile(join(job.outputDir, "run-metadata.json"), JSON.stringify({
      schemaVersion: 1, fileId: job.fileId, suiteId: job.suiteId,
      startedAt: job.startedAt, state, error: job.error, baseURL: job.baseURL,
    }, null, 2) + "\n");
  }

  function validISO(value: unknown): value is string {
    return typeof value === "string" && Number.isFinite(Date.parse(value));
  }
  function validRunReport(value: unknown): value is RunReport {
    if (!value || typeof value !== "object") return false;
    const report = value as Partial<RunReport>;
    return report.schemaVersion === 1 &&
      ["passed", "assertion-failed", "execution-error"].includes(report.status ?? "") &&
      Array.isArray(report.steps) &&
      typeof report.durationMs === "number" &&
      (typeof report.title === "string" || report.title === null) &&
      !!report.artifacts && typeof report.artifacts === "object";
  }

  // Restore only completed histories. An interrupted test must never be
  // displayed as passed. Corrupt/partial data is skipped rather than executed.
  async function restoreHistory(): Promise<void> {
    let dirs: string[] = [];
    try {
      dirs = (await readdir(resultsDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && RUN_ID.test(entry.name))
        .map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const restored: RunJob[] = [];
    for (const id of dirs) {
      const folder = join(resultsDir, id);
      let report: RunReport | undefined;
      let metadata: unknown;
      try {
        const parsed: unknown = JSON.parse(await readFile(join(folder, "report.json"), "utf8"));
        if (validRunReport(parsed)) report = parsed;
      } catch { /* Legacy runner error or interrupted run */ }
      try {
        metadata = JSON.parse(await readFile(join(folder, "run-metadata.json"), "utf8")) as unknown;
      } catch { /* Pre-history runs have report.json but no metadata */ }
      const details = metadata && typeof metadata === "object"
        ? metadata as Record<string, unknown> : {};
      const state = details.state === "error" ? "error" : "finished";
      if (!report && state !== "error") continue;
      const startedAt = validISO(details.startedAt) ? details.startedAt :
        report && validISO(report.startedAt) ? report.startedAt : undefined;
      if (!startedAt) continue;
      restored.push({
        id,
        fileId: typeof details.fileId === "string" && SAVED_NAME.test(details.fileId)
          ? details.fileId : "",
        state, startedAt, outputDir: folder,
        ...(typeof details.baseURL === "string" ? { baseURL: details.baseURL } : {}),
        ...(report && state === "finished" ? { report } : {}),
        ...(state === "error" && typeof details.error === "string"
          ? { error: details.error } : {}),
        ...(typeof details.suiteId === "string" && RUN_ID.test(details.suiteId)
          ? { suiteId: details.suiteId } : {}),
      });
    }
    restored.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    for (const job of restored.slice(-MAX_RUN_HISTORY)) jobs.set(job.id, job);

    let suiteDirs: string[] = [];
    try {
      suiteDirs = (await readdir(join(resultsDir, "suites"), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && RUN_ID.test(entry.name))
        .map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const restoredSuites: SuiteJob[] = [];
    for (const id of suiteDirs) {
      try {
        const parsed: unknown = JSON.parse(await readFile(
          join(resultsDir, "suites", id, "report.json"), "utf8"));
        if (!parsed || typeof parsed !== "object") continue;
        const saved = parsed as Record<string, unknown>;
        if (saved.id !== id || saved.state !== "finished" ||
            !validISO(saved.startedAt) || !validISO(saved.finishedAt) ||
            typeof saved.baseURL !== "string" ||
            !Array.isArray(saved.tests) || saved.tests.length < 1 ||
            saved.tests.length > MAX_SUITE_CASES) continue;
        const entries: SuiteEntry[] = [];
        let valid = true;
        for (const item of saved.tests) {
          if (!item || typeof item !== "object") { valid = false; break; }
          const entry = item as Record<string, unknown>;
          if (typeof entry.fileId !== "string" || !SAVED_NAME.test(entry.fileId) ||
              typeof entry.title !== "string" ||
              (entry.state !== "finished" && entry.state !== "error") ||
              (entry.runId !== undefined && (typeof entry.runId !== "string" || !RUN_ID.test(entry.runId))) ||
              (entry.verdict !== undefined &&
                !["passed", "assertion-failed", "execution-error"].includes(String(entry.verdict)))) {
            valid = false; break;
          }
          entries.push({
            fileId: entry.fileId, title: entry.title,
            state: entry.state,
            ...(typeof entry.runId === "string" ? { runId: entry.runId } : {}),
            ...(typeof entry.verdict === "string"
              ? { verdict: entry.verdict as RunReport["status"] } : {}),
            ...(typeof entry.durationMs === "number" ? { durationMs: entry.durationMs } : {}),
            ...(typeof entry.error === "string" ? { error: entry.error } : {}),
          });
        }
        if (!valid) continue;
        restoredSuites.push({
          id, state: "finished", startedAt: saved.startedAt,
          finishedAt: saved.finishedAt, baseURL: saved.baseURL,
          entries,
        });
      } catch { /* Ignore corrupt or interrupted suite snapshots */ }
    }
    restoredSuites.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    for (const suite of restoredSuites.slice(-MAX_SUITE_HISTORY)) suites.set(suite.id, suite);
  }
  await restoreHistory();

  // A website is the saved test suite, whether the user executed one
  // script or a sequential batch. Expose one unified history per website.
  // Individual reports remain available inside a batch, not in a second list.
  function historySnapshot(requestedSite = "", requestedPage = 1) {
    type HistoryEntry = {
      kind: "batch" | "single";
      id: string;
      siteUrl: string;
      startedAt: string;
      verdict: "passed" | "failed";
      title: string;
      summary: { total: number; passed: number; failed: number; errors: number };
    };
    const siteOf = (base?: string) => {
      if (!base) return "__legacy__";
      try { return websiteOrigin(base); }
      catch { return "__legacy__"; }
    };
    const entries: HistoryEntry[] = [];
    for (const suite of suites.values()) {
      if (suite.state !== "finished") continue;
      const data = suiteSnapshot(suite);
      const siteUrl = siteOf(suite.baseURL);
      entries.push({
        kind: "batch", id: suite.id, siteUrl,
        startedAt: suite.startedAt, verdict: data.verdict === "passed" ? "passed" : "failed",
        title: siteUrl, summary: {
          total: data.summary.total, passed: data.summary.passed,
          failed: data.summary.failed, errors: data.summary.errors,
        },
      });
    }
    for (const run of jobs.values()) {
      // Batch members are counted exclusively under their suite execution.
      if (run.suiteId || run.state === "running") continue;
      const siteUrl = siteOf(run.baseURL);
      const passed = run.report?.status === "passed";
      entries.push({
        kind: "single", id: run.id, siteUrl,
        startedAt: run.startedAt, verdict: passed ? "passed" : "failed",
        title: run.report?.title ?? "One test script",
        summary: { total: 1, passed: passed ? 1 : 0,
          failed: run.report && !passed ? 1 : 0,
          errors: run.state === "error" ? 1 : 0 },
      });
    }
    entries.sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
    const counts = new Map<string, number>();
    for (const entry of entries) counts.set(
      entry.siteUrl, (counts.get(entry.siteUrl) ?? 0) + 1);
    const sites = [...counts.entries()].map(([siteUrl, executions]) => ({
      siteUrl,
      label: siteUrl === "__legacy__" ? "Older / unknown website" : siteUrl,
      executions,
    }));
    const selectedSiteUrl = requestedSite || sites[0]?.siteUrl || "";
    const matching = entries.filter((entry) => entry.siteUrl === selectedSiteUrl);
    const pages = Math.max(1, Math.ceil(matching.length / HISTORY_PAGE_SIZE));
    const page = Math.min(requestedPage, pages);
    return {
      sites, selectedSiteUrl, page, pages,
      pageSize: HISTORY_PAGE_SIZE, total: matching.length,
      entries: matching.slice((page - 1) * HISTORY_PAGE_SIZE, page * HISTORY_PAGE_SIZE),
    };
  }

  async function readSaved(id: string): Promise<TestDefinition> {
    const file = await findSavedFile(savedDir, id);
    const input = JSON.parse(await readFile(file, "utf8")) as unknown;
    return parseTestDefinition(input);
  }

  function ensureNoExecutionForDeletion() {
    if (activeRun || activePreflight || [...jobs.values()].some((job) => job.state === "running")) {
      throw new Error("Cannot delete approved scripts or website suites during an active run or preflight");
    }
  }

  async function listApproved() {
    const paths = (await listSavedFiles(savedDir)).slice(0, 1000);
    const tests: Array<{
      id: string; title: string; steps: number;
      sourceUrl: string | null; siteUrl: string | null;
    }> = [];
    for (const entry of paths) {
      try {
        const definition = parseTestDefinition(
          JSON.parse(await readFile(entry.path, "utf8")) as unknown);
        const sourceUrl = definition.sourceUrl ?? null;
        tests.push({
          id: entry.id, title: definition.title, steps: definition.steps.length,
          sourceUrl, siteUrl: sourceUrl ? websiteOrigin(sourceUrl) : null,
        });
      } catch { /* Skip unreadable or invalid definitions */ }
    }
    return tests;
  }

  /**
   * A revision supersedes an approved test rather than creating another
   * visible version. Write and validate the replacement first; only then
   * delete the superseded saved file. Do not touch the original on errors.
   */
  async function saveApproved(
    definition: TestDefinition,
    replacesId?: string,
    base?: URL,
  ): Promise<{ id: string; file: string; replacedId?: string }> {
    let replacedPath: string | undefined;
    if (activeDeletion) throw new Error("Cannot save a test while deleting a website suite");
    if (replacesId) {
      if (!SAVED_NAME.test(replacesId)) throw new Error("Invalid test to replace");
      if ([...jobs.values()].some((job) => job.fileId === replacesId && job.state === "running") ||
          (activeRun && suites.get(activeRun)?.entries.some((entry) => entry.fileId === replacesId))) {
        throw new Error("Cannot replace a test while it is running in a test suite");
      }
      await readSaved(replacesId);
      replacedPath = await findSavedFile(savedDir, replacesId);
    }
    const sourceUrl = base?.href ?? definition.sourceUrl;
    const approved = parseTestDefinition(sourceUrl
      ? { ...definition, sourceUrl } : definition);
    const id = "reviewed-" + Date.now() + "-" + randomUUID().slice(0, 8) + ".json";
    const directory = sourceUrl ? websiteDirectory(savedDir, sourceUrl) : savedDir;
    const file = join(directory, id);
    await mkdir(directory, { recursive: true });
    await writeFile(file, JSON.stringify(approved, null, 2) + "\n", { flag: "wx" });
    if (replacesId && replacedPath) {
      try {
        await unlink(replacedPath);
        if (dirname(replacedPath) !== savedDir) await rmdir(dirname(replacedPath)).catch(() => {});
      } catch (error) {
        // Never leave a new duplicate if removing the superseded test failed.
        await unlink(file).catch(() => {});
        throw error;
      }
      // Stale failing executions for the replaced script should not clutter
      // current-session history. Remove their report/trace/screenshot files too.
      for (const [runId, job] of jobs) {
        if (job.fileId !== replacesId || job.state === "running") continue;
        jobs.delete(runId);
        await rm(job.outputDir, { recursive: true, force: true }).catch(() => {
          // A disk cleanup error must not roll back an already saved revision.
        });
      }
    }
    return { id, file, ...(replacesId ? { replacedId: replacesId } : {}) };
  }

  function snapshot(job: RunJob) {
    return {
      id: job.id, fileId: job.fileId, state: job.state, startedAt: job.startedAt,
      report: job.report, error: job.error,
      diagnosis: job.report ? diagnoseRun(job.report) : undefined,
      artifacts: job.report ? {
        report: "/api/runs/" + job.id + "/report.json",
        ...(job.report.artifacts.screenshot ? {
          screenshot: "/api/runs/" + job.id + "/failure.png",
        } : {}),
        ...(job.report.artifacts.trace ? {
          trace: "/api/runs/" + job.id + "/trace.zip",
        } : {}),
      } : {},
    };
  }
  return createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (path.startsWith("/api/") && !localOrigin(req)) {
        json(res, 403, { error: "Requests must come from this loopback review interface" });
        return;
      }
      if (req.method === "GET" && path === "/") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'",
        });
        res.end(html);
        return;
      }
      if (req.method === "GET" && path === "/health") {
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && path === "/api/history") {
        const query = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
        const siteUrl = query.get("siteUrl") ?? "";
        const page = Number(query.get("page") ?? 1);
        if (!Number.isSafeInteger(page) || page < 1 || page > 100_000 ||
            siteUrl.length > 2048) {
          json(res, 400, { error: "Invalid history page or website filter" });
          return;
        }
        json(res, 200, historySnapshot(siteUrl, page));
        return;
      }
      const suitePath = /^\/api\/suites\/([a-f0-9-]{36})(?:\/(report\.json))?$/.exec(path);
      if (req.method === "GET" && suitePath) {
        const suite = suites.get(suitePath[1]);
        if (!suite || !RUN_ID.test(suitePath[1])) {
          json(res, 404, { error: "Test suite run not found" });
        } else if (suitePath[2] && suite.state !== "finished") {
          json(res, 409, { error: "Test suite is still running" });
        } else {
          json(res, 200, suiteSnapshot(suite));
        }
        return;
      }
      if (req.method === "GET" && path === "/api/tests") {
        try {
          const tests = await listApproved();
          const counts = new Map<string, number>();
          for (const test of tests) {
            const key = test.siteUrl ?? "";
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
          const sites = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))
            .map(([siteUrl, scripts]) => ({ siteUrl: siteUrl || null, scripts }));
          json(res, 200, { tests, sites });
        } catch {
          json(res, 500, { error: "Could not list approved test scripts" });
        }
        return;
      }
      const traceabilityPath = /^\/api\/tests\/(reviewed-\d{13}-[a-f0-9]{8}\.json)\/traceability$/.exec(path);
      if (req.method === "GET" && traceabilityPath) {
        try {
          const definition = await readSaved(traceabilityPath[1]);
          json(res, 200, buildTraceabilityReport(definition));
        } catch {
          json(res, 404, { error: "Saved test not found or invalid" });
        }
        return;
      }
      const exportPath = /^\/api\/tests\/(reviewed-\d{13}-[a-f0-9]{8}\.json)\/export\.ts$/.exec(path);
      if (req.method === "GET" && exportPath) {
        try {
          const query = new URL(req.url ?? "/", "http://127.0.0.1");
          const base = validatedBaseURL(query.searchParams.get("baseURL"));
          const rawTimeout = query.searchParams.get("timeoutMs");
          const timeoutMs = rawTimeout === null ? 5000 : Number(rawTimeout);
          const definition = await readSaved(exportPath[1]);
          const source = generatePlaywrightSpec(definition, { baseURL: base.href, timeoutMs });
          const filename = exportPath[1].replace(/\.json$/, ".spec.ts");
          res.writeHead(200, {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Disposition": "attachment; filename=\"" + filename + "\"",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          });
          res.end(source);
        } catch (error) {
          json(res, 400, { error: error instanceof Error ? error.message : "Export unavailable" });
        }
        return;
      }
      const savedTestPath = /^\/api\/tests\/(reviewed-\d{13}-[a-f0-9]{8}\.json)$/.exec(path);
      if (req.method === "GET" && savedTestPath) {
        try {
          const definition = await readSaved(savedTestPath[1]);
          json(res, 200, { id: savedTestPath[1], definition });
        } catch {
          json(res, 404, { error: "Saved test not found" });
        }
        return;
      }
      const resultPath = /^\/api\/runs\/([a-f0-9-]{36})(?:\/(report\.json|failure\.png|trace\.zip))?$/.exec(path);
      if (req.method === "GET" && resultPath) {
        const id = resultPath[1];
        if (!RUN_ID.test(id) || !jobs.has(id)) {
          json(res, 404, { error: "Run not found" });
          return;
        }
        const job = jobs.get(id)!;
        const artifact = resultPath[2];
        if (!artifact) {
          json(res, 200, snapshot(job));
          return;
        }
        if (!job.report || job.state !== "finished" ||
            (artifact === "failure.png" && job.report.artifacts.screenshot !== "failure.png") ||
            (artifact === "trace.zip" && job.report.artifacts.trace !== "trace.zip")) {
          json(res, 404, { error: "Artifact not available" });
          return;
        }
        if (artifact === "report.json") {
          json(res, 200, job.report);
          return;
        }
        try {
          const bytes = await readFile(join(job.outputDir, artifact));
          res.writeHead(200, {
            "Content-Type": artifact.endsWith(".png") ? "image/png" : "application/zip",
            "Content-Disposition": artifact.endsWith(".zip")
              ? "attachment; filename=trace.zip" : "inline; filename=failure.png",
            "X-Content-Type-Options": "nosniff",
            "Cross-Origin-Resource-Policy": "same-origin",
            "Cache-Control": "no-store",
          });
          res.end(bytes);
        } catch {
          json(res, 404, { error: "Artifact file is unavailable" });
        }
        return;
      }
      if (req.method !== "POST" || !["/api/generate", "/api/save", "/api/run", "/api/suites", "/api/preflight", "/api/delete-test", "/api/delete-site", "/api/assign-site", "/api/history/delete-all", "/api/repair", "/api/repair-target", "/api/repair-assertion", "/api/repair-assertion-target", "/api/search-assertion-dom"].includes(path)) {
        json(res, 404, { error: "Not found" });
        return;
      }
      if (!localOrigin(req)) {
        json(res, 403, { error: "Requests must originate from this local review interface" });
        return;
      }
      let body: unknown;
      try {
        body = await readJSON(req);
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : String(error) });
        return;
      }
      if (path === "/api/history/delete-all") {
        if (activeRun || activePreflight || activeDeletion ||
            [...jobs.values()].some((job) => job.state === "running")) {
          json(res, 409, { error: "Finish the active test or preflight before clearing history" });
          return;
        }
        if (!body || typeof body !== "object" || Array.isArray(body) ||
            (body as Record<string, unknown>).confirmed !== true ||
            (body as Record<string, unknown>).confirmationText !== "DELETE ALL HISTORY") {
          json(res, 400, { error: "Explicit confirmation to delete all execution history is required" });
          return;
        }
        activeDeletion = true;
        try {
          // Only delete known generated UUID directories. Never delete
          // saved test scripts or unrelated items in the results folder.
          let directories: Dirent[];
          try { directories = await readdir(resultsDir, { withFileTypes: true }); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            directories = [];
          }
          for (const entry of directories) {
            if (!entry.isDirectory()) continue;
            if (RUN_ID.test(entry.name)) {
              await rm(join(resultsDir, entry.name), { recursive: true, force: true });
            } else if (entry.name === "suites") {
              const suiteDir = join(resultsDir, "suites");
              const suiteEntries = await readdir(suiteDir, { withFileTypes: true });
              for (const child of suiteEntries) {
                if (child.isDirectory() && RUN_ID.test(child.name)) {
                  await rm(join(suiteDir, child.name), { recursive: true, force: true });
                }
              }
              await rmdir(suiteDir).catch(() => {});
            }
          }
          jobs.clear();
          suites.clear();
          json(res, 200, {
            deleted: true,
            message: "All local execution history, screenshots and traces deleted. Saved test scripts are unchanged.",
          });
        } catch {
          json(res, 500, { error: "Could not finish clearing history; check local file permissions" });
        } finally {
          activeDeletion = false;
        }
        return;
      }
      if (path === "/api/delete-test" || path === "/api/delete-site" || path === "/api/assign-site") {
        if (activeRun || activePreflight || activeDeletion) {
          json(res, 409, { error: "Cannot delete saved scripts or suites while a browser operation or deletion is active" });
          return;
        }
        activeDeletion = true;
        try {
          if (!body || typeof body !== "object") throw new Error("Expected deletion details");
          const input = body as Record<string, unknown>;
          if (input.confirmed !== true) {
            throw new Error("Explicit deletion confirmation is required");
          }
          if (path === "/api/assign-site") {
            // Explicit migration only: never guess the originating URL for a
            // legacy file from its title or AI-written browser steps.
            if (typeof input.id !== "string" || !SAVED_NAME.test(input.id)) {
              throw new Error("Invalid legacy test script ID");
            }
            const file = await findSavedFile(savedDir, input.id);
            const definition = await readSaved(input.id);
            if (dirname(file) !== savedDir || definition.sourceUrl) {
              throw new Error("Only an unassigned legacy script can be assigned this way");
            }
            const base = validatedBaseURL(input.baseURL);
            verifyNavigations(definition, base);
            const targetFolder = websiteDirectory(savedDir, base.href);
            const target = join(targetFolder, input.id);
            const approved = parseTestDefinition({ ...definition, sourceUrl: base.href });
            await mkdir(targetFolder, { recursive: true });
            await writeFile(target, JSON.stringify(approved, null, 2) + "\n", { flag: "wx" });
            try {
              await unlink(file);
            } catch (error) {
              await unlink(target).catch(() => {});
              throw error;
            }
            json(res, 200, {
              assignedId: input.id, siteUrl: websiteOrigin(base.href),
              message: "Existing test script assigned to the selected website suite.",
            });
          } else if (path === "/api/delete-test") {
            if (typeof input.id !== "string" || !SAVED_NAME.test(input.id)) {
              throw new Error("Invalid test script ID");
            }
            const file = await findSavedFile(savedDir, input.id);
            await unlink(file);
            if (dirname(file) !== savedDir) await rmdir(dirname(file)).catch(() => {});
            json(res, 200, {
              deletedId: input.id, scriptsDeleted: 1,
              message: "Approved test script deleted. Historical run reports are retained.",
            });
          } else {
            if (typeof input.siteUrl !== "string" ||
                input.siteUrl !== websiteOrigin(input.siteUrl)) {
              throw new Error("Select a valid website test suite URL");
            }
            const folder = websiteDirectory(savedDir, input.siteUrl);
            const matching = (await listSavedFiles(savedDir))
              .filter((entry) => dirname(entry.path) === folder);
            if (!matching.length) throw new Error("Website suite is empty or does not exist");
            // Never recursively remove arbitrary contents from a directory:
            // only remove approved JSON filenames belonging to this website.
            for (const entry of matching) {
              const definition = parseTestDefinition(
                JSON.parse(await readFile(entry.path, "utf8")) as unknown);
              if (!definition.sourceUrl ||
                  websiteOrigin(definition.sourceUrl) !== input.siteUrl) {
                throw new Error("Website suite contains scripts with mismatched metadata");
              }
            }
            for (const entry of matching) await unlink(entry.path);
            await rmdir(folder).catch(() => {});
            json(res, 200, {
              deletedSiteUrl: input.siteUrl, scriptsDeleted: matching.length,
              message: "Website suite and its approved test scripts deleted; historical reports retained.",
            });
          }
        } catch (error) {
          json(res, 400, { error: error instanceof Error ? error.message : "Deletion failed" });
        } finally {
          activeDeletion = false;
        }
        return;
      }
      if (path === "/api/preflight") {
        if (activeRun || activePreflight || activeDeletion) {
          json(res, 409, { error: "Browser busy. Finish the current test or selector check first." });
          return;
        }
        let definition: TestDefinition;
        let base: URL;
        try {
          if (!body || typeof body !== "object") throw new Error("Expected a request object");
          const input = body as Record<string, unknown>;
          base = validatedBaseURL(input.baseURL);
          definition = parseTestDefinition(input.definition);
          verifyNavigations(definition, base);
        } catch (error) {
          json(res, 400, { error: error instanceof Error ? error.message : "Invalid preflight request" });
          return;
        }
        activePreflight = true;
        try {
          json(res, 200, await preflightSelectors(definition, base.href, suppliedBrowser));
        } catch (error) {
          json(res, 422, { error: error instanceof Error ? error.message : "Selector check failed" });
        } finally {
          activePreflight = false;
        }
        return;
      }
      if (path === "/api/repair") {
        try {
          if (!body || typeof body !== "object") throw new Error("Expected a request object");
          const input = body as Record<string, unknown>;
          if (typeof input.runId !== "string" || !RUN_ID.test(input.runId)) {
            throw new Error("Valid completed run ID is required");
          }
          if (typeof input.candidateIndex !== "number" ||
              !Number.isInteger(input.candidateIndex) || input.candidateIndex < 0) {
            throw new Error("Choose one of the displayed candidate elements");
          }
          const job = jobs.get(input.runId);
          if (!job || job.state !== "finished" || !job.report ||
              job.report.status !== "execution-error") {
            throw new Error("No completed ambiguous execution is available for repair");
          }
          const failed = job.report.steps.find((step) =>
            step.status === "execution-error" && !!step.ambiguity,
          );
          const ambiguity = failed?.ambiguity;
          if (!failed || !ambiguity || ambiguity.total > ambiguity.candidates.length) {
            throw new Error("No complete set of candidate choices is available for this run");
          }
          const selected = ambiguity.candidates[input.candidateIndex as number];
          if (!selected || !selected.name.trim()) {
            throw new Error("This candidate has no meaningful name; edit the locator manually");
          }
          const identical = ambiguity.candidates.filter((candidate) =>
            candidate.name === selected.name && candidate.role === selected.role);
          const isDuplicate = identical.length > 1;
          if (isDuplicate && (
              !Number.isInteger(selected.nth) || selected.nth! < 0 ||
              selected.matchCount !== identical.length ||
              identical.some((candidate) =>
                !Number.isInteger(candidate.nth) ||
                candidate.matchCount !== identical.length) ||
              new Set(identical.map((candidate) => candidate.nth)).size !== identical.length
          )) {
            throw new Error("Identical elements could not be matched reliably by position. Edit the locator manually.");
          }
          const definition = await readSaved(job.fileId);
          const step = definition.steps.find((step) => step.id === failed.id);
          if (!step || step.action.kind === "navigate" ||
              step.action.kind === "assert-url" || step.action.kind === "assert-count" ||
              step.action.target.by !== "intent" ||
              step.action.target.value !== ambiguity.intent ||
              step.action.target.role !== ambiguity.role) {
            throw new Error("The saved test changed since this execution; rerun it before repairing");
          }
          const candidateRole = selected.role;
          const groundedRole = candidateRole === "button" || candidateRole === "textbox" ||
            candidateRole === "checkbox" || candidateRole === "radio" ||
            candidateRole === "combobox" || candidateRole === "heading" ||
            candidateRole === "status" || candidateRole === "listitem"
            ? candidateRole : undefined;
          const selectedRole = ambiguity.role || groundedRole;
          if (isDuplicate) {
            if (!groundedRole || selected.nth === undefined) {
              throw new Error("Cannot repair identical elements without a verified role and position");
            }
            // The chosen ordinal was grounded in the failed run's real DOM.
            // An exact role/name locator is deterministic at replay time.
            step.action.target = {
              by: "role", role: groundedRole, name: selected.name, nth: selected.nth,
            };
          } else {
            step.action.target = {
              by: "intent",
              value: selected.name,
              ...(selectedRole ? { role: selectedRole } : {}),
            };
          }
          const repaired = parseTestDefinition(definition);
          const { id, file, replacedId } = await saveApproved(repaired, job.fileId);
          json(res, 201, {
            id, file, replacedId, repairedStepId: failed.id,
            previousIntent: ambiguity.intent,
            approvedIntent: selected.name,
            message: "Corrected test saved and failed version removed from the list; no test has been executed.",
          });
        } catch (error) {
          json(res, 400, { error: error instanceof Error ? error.message : "Invalid repair request" });
        }
        return;
      }
      if (path === "/api/repair-target") {
        try {
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            throw new Error("Expected a repair request object");
          }
          const input = body as Record<string, unknown>;
          if (typeof input.runId !== "string" || !RUN_ID.test(input.runId)) {
            throw new Error("Valid completed run ID is required");
          }
          if (typeof input.stepId !== "string" || !input.stepId.trim()) {
            throw new Error("Failed step ID is required");
          }
          if (typeof input.candidateIndex !== "number" ||
              !Number.isInteger(input.candidateIndex) || input.candidateIndex < 0) {
            throw new Error("Choose one of the displayed elements");
          }
          const job = jobs.get(input.runId);
          if (!job || job.state !== "finished" || job.report?.status !== "execution-error") {
            throw new Error("No completed locator failure exists for this run");
          }
          const failed = job.report.steps.find((step) =>
            step.id === input.stepId && step.status === "execution-error" &&
            !!step.locatorAlternatives,
          );
          const evidence = failed?.locatorAlternatives;
          if (!failed || !evidence || !evidence.candidates.length ||
              evidence.total !== evidence.candidates.length) {
            throw new Error("A complete set of live DOM alternatives is not available");
          }
          const chosen = evidence.candidates[input.candidateIndex];
          if (!chosen || !chosen.name.trim()) {
            throw new Error("Choose a named element from the failed run");
          }
          const identical = evidence.candidates.filter((candidate) =>
            candidate.name === chosen.name && candidate.role === chosen.role);
          const isDuplicate = identical.length > 1;
          if (isDuplicate && (
              !Number.isInteger(chosen.nth) || chosen.nth! < 0 ||
              chosen.matchCount !== identical.length ||
              identical.some((candidate) =>
                !Number.isInteger(candidate.nth) ||
                candidate.matchCount !== identical.length) ||
              new Set(identical.map((candidate) => candidate.nth)).size !== identical.length
          )) {
            throw new Error("Identical buttons were not verified in exact order; edit the target manually");
          }
          const definition = await readSaved(job.fileId);
          const step = definition.steps.find((entry) => entry.id === failed.id);
          if (!step || (step.action.kind !== "click" && step.action.kind !== "fill") ||
              JSON.stringify(step.action.target) !== JSON.stringify(evidence.attempted)) {
            throw new Error("The saved test no longer matches this run; rerun before repairing");
          }
          const role = chosen.role;
          if (step.action.kind === "click" && role !== "button" && role !== "checkbox" ||
              step.action.kind === "fill" && role !== "textbox") {
            throw new Error("The selected element cannot perform this action");
          }
          // A role/name locator corresponds to the user-selected, uniquely
          // resolved visible candidate. Do not accept arbitrary selectors.
          if (role !== "button" && role !== "checkbox" && role !== "textbox") {
            throw new Error("Unsupported element role");
          }
          const previousTarget = step.action.target;
          step.action.target = isDuplicate
            ? { by: "role", role, name: chosen.name, nth: chosen.nth }
            : { by: "role", role, name: chosen.name };
          const corrected = parseTestDefinition(definition);
          const { id, replacedId } = await saveApproved(corrected, job.fileId);
          json(res, 201, {
            id, replacedId, repairedStepId: step.id,
            previousTarget, approvedTarget: step.action.target,
            message: "Corrected locator saved and failed test replaced; assertions remain unchanged. Execution has not started.",
          });
        } catch (error) {
          json(res, 400, { error: error instanceof Error ? error.message : "Invalid locator repair" });
        }
        return;
      }
      if (path === "/api/search-assertion-dom") {
        try {
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            throw new Error("Expected a DOM search request");
          }
          const input = body as Record<string, unknown>;
          if (typeof input.runId !== "string" || !RUN_ID.test(input.runId) ||
              typeof input.stepId !== "string" || !input.stepId.trim()) {
            throw new Error("Valid run and failed step IDs are required");
          }
          if (typeof input.query !== "string" || !input.query.trim() ||
              input.query.trim().length > 180) {
            throw new Error("DOM search text must be 1–180 characters");
          }
          const job = jobs.get(input.runId);
          if (!job || job.state !== "finished" ||
              (job.report?.status !== "execution-error" &&
               job.report?.status !== "assertion-failed")) {
            throw new Error("Search requires a completed failing run");
          }
          const failed = job.report.steps.find((step) =>
            step.id === input.stepId && step.assertionSearchAvailable === true &&
            (step.status === "execution-error" || step.status === "assertion-failed"),
          );
          const entries = job.assertionSearchIndex?.get(input.stepId);
          if (!failed || !entries) {
            throw new Error("No searchable DOM evidence exists for this failed assertion");
          }
          const definition = await readSaved(job.fileId);
          const step = definition.steps.find((entry) => entry.id === failed.id);
          if (!step || (step.action.kind !== "assert-text" &&
              step.action.kind !== "assert-visible") ||
              (failed.status === "assertion-failed" &&
               (step.action.kind !== "assert-text" ||
                failed.expected !== step.action.expected))) {
            throw new Error("The saved assertion no longer matches the failed run");
          }
          const alternatives = searchCapturedAssertionText(
            entries, step.action.target, input.query,
          );
          alternatives.searchToken = randomUUID();
          failed.assertionAlternatives = alternatives;
          json(res, 200, { alternatives,
            message: "Search uses visible DOM evidence captured at the failure, without replaying actions." });
        } catch (error) {
          json(res, 400, { error: error instanceof Error ? error.message : "Invalid DOM search" });
        }
        return;
      }
      if (path === "/api/repair-assertion-target") {
        try {
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            throw new Error("Expected a repair request object");
          }
          const input = body as Record<string, unknown>;
          if (typeof input.runId !== "string" || !RUN_ID.test(input.runId)) {
            throw new Error("Valid completed run ID is required");
          }
          if (typeof input.stepId !== "string" || !input.stepId.trim()) {
            throw new Error("Failed assertion step ID is required");
          }
          if (typeof input.candidateIndex !== "number" ||
              !Number.isInteger(input.candidateIndex) || input.candidateIndex < 0) {
            throw new Error("Choose one of the displayed DOM matches");
          }
          const job = jobs.get(input.runId);
          if (!job || job.state !== "finished" ||
              (job.report?.status !== "execution-error" &&
               job.report?.status !== "assertion-failed")) {
            throw new Error("No completed failed assertion target is available");
          }
          const failed = job.report.steps.find((step) =>
            step.id === input.stepId &&
            (step.status === "execution-error" || step.status === "assertion-failed") &&
            !!step.assertionAlternatives,
          );
          const evidence = failed?.assertionAlternatives;
          if (!failed || !evidence || !evidence.candidates.length ||
              evidence.total !== evidence.candidates.length) {
            throw new Error("A complete set of verified live DOM matches is required");
          }
          if (evidence.searched &&
              (typeof input.searchToken !== "string" ||
               input.searchToken !== evidence.searchToken)) {
            throw new Error("DOM search results have changed; search again before approving");
          }
          const selected = evidence.candidates[input.candidateIndex];
          if (!selected || !selected.target) {
            throw new Error("Choose a verified element from the failed run");
          }
          if (evidence.candidates.some((candidate, index) =>
            index !== input.candidateIndex &&
            JSON.stringify(candidate.target) === JSON.stringify(selected.target))) {
            throw new Error("This candidate cannot be uniquely identified");
          }
          const definition = await readSaved(job.fileId);
          const step = definition.steps.find((entry) => entry.id === failed.id);
          if (!step || (step.action.kind !== "assert-visible" && step.action.kind !== "assert-text") ||
              JSON.stringify(step.action.target) !== JSON.stringify(evidence.attempted) ||
              (failed.status === "assertion-failed" &&
                (step.action.kind !== "assert-text" ||
                 step.action.expected !== failed.expected ||
                 !failed.observed || failed.observed === failed.expected ||
                 (!evidence.searched &&
                  evidence.query !== failed.expected.replace(/\s+/g, " ").trim())))) {
            throw new Error("Saved assertion differs from the failing run; rerun before repairing");
          }
          const target = selected.target;
          if (target.by !== "text" && target.by !== "role") {
            throw new Error("Only verified role and visible-text locators are accepted");
          }
          if (target.by === "role" && !target.name ||
              target.by === "text" && !target.value.trim()) {
            throw new Error("Assertion target must uniquely identify a named element");
          }
          // Only the target is changed. Expected text, provenance, assertion
          // kind and all other steps are preserved. Actual page text is never
          // promoted to a passing expectation.
          const previousTarget = step.action.target;
          step.action.target = target;
          const corrected = parseTestDefinition(definition);
          const { id, replacedId } = await saveApproved(corrected, job.fileId);
          json(res, 201, {
            id, replacedId, repairedStepId: step.id,
            previousTarget, approvedTarget: target,
            message: "Assertion target corrected from reviewed DOM evidence; expected results unchanged. No run started.",
          });
        } catch (error) {
          json(res, 400, {
            error: error instanceof Error ? error.message : "Invalid assertion locator repair",
          });
        }
        return;
      }
      if (path === "/api/repair-assertion") {
        try {
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            throw new Error("Expected a request object");
          }
          const input = body as Record<string, unknown>;
          if (typeof input.runId !== "string" || !RUN_ID.test(input.runId)) {
            throw new Error("Valid completed run ID is required");
          }
          if (typeof input.stepId !== "string" || !input.stepId.trim()) {
            throw new Error("Failed assertion step ID is required");
          }
          if (typeof input.expected !== "string" || input.expected.length > 10_000) {
            throw new Error("New expected text must contain at most 10,000 characters");
          }
          if (input.confirmed !== true) {
            throw new Error("Tester must explicitly confirm the new expectation against requirements");
          }
          const job = jobs.get(input.runId);
          if (!job || job.state !== "finished" || job.report?.status !== "assertion-failed") {
            throw new Error("This run has no completed text assertion failure to review");
          }
          const failed = job.report.steps.find((step) =>
            step.id === input.stepId && step.status === "assertion-failed" &&
            typeof step.expected === "string" && typeof step.observed === "string",
          );
          if (!failed) {
            throw new Error("Requested step is not a failed text assertion with an observed value");
          }
          const definition = await readSaved(job.fileId);
          const step = definition.steps.find((entry) => entry.id === failed.id);
          if (!step || step.action.kind !== "assert-text" ||
              step.action.expected !== failed.expected) {
            throw new Error("Saved assertion differs from the failed run; rerun before reviewing");
          }
          if (input.expected === step.action.expected) {
            throw new Error("The new expected text is unchanged");
          }
          // The page's observed value is evidence, never an automatically
          // accepted oracle. Only explicit human confirmation can change it.
          const previousExpected = step.action.expected;
          step.action.expected = input.expected;
          step.action.provenance = "human-confirmed";
          const reviewed = parseTestDefinition(definition);
          const { id, file, replacedId } = await saveApproved(reviewed, job.fileId);
          json(res, 201, {
            id, file, replacedId, revisedStepId: failed.id,
            previousExpected, newExpected: input.expected,
            observed: failed.observed,
            message: "Human-confirmed correction saved; failed test removed. No run started.",
          });
        } catch (error) {
          json(res, 400, { error: error instanceof Error ? error.message : "Invalid assertion review" });
        }
        return;
      }
      if (path === "/api/suites") {
        let definitions: Array<{ fileId: string; definition: TestDefinition }>;
        let base: URL;
        let timeoutMs: number;
        try {
          if (!body || typeof body !== "object") throw new Error("Expected a request object");
          const input = body as Record<string, unknown>;
          if (!Array.isArray(input.ids) || input.ids.length < 1 ||
              input.ids.length > MAX_SUITE_CASES ||
              !input.ids.every((id) => typeof id === "string" && SAVED_NAME.test(id)) ||
              new Set(input.ids).size !== input.ids.length) {
            throw new Error("Choose 1–" + MAX_SUITE_CASES + " unique approved saved tests");
          }
          base = validatedBaseURL(input.baseURL);
          timeoutMs = input.timeoutMs === undefined ? 5000 : Number(input.timeoutMs);
          if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) {
            throw new Error("Timeout must be between 100 and 60000 ms");
          }
          // Validate every saved script BEFORE starting any execution.
          definitions = [];
          for (const fileId of input.ids as string[]) {
            const definition = await readSaved(fileId);
            verifyNavigations(definition, base);
            if (definition.sourceUrl && websiteOrigin(definition.sourceUrl) !== base.origin) {
              throw new Error("All scripts in one website suite must match the selected URL origin");
            }
            definitions.push({ fileId, definition });
          }
        } catch (error) {
          json(res, 400, { error: error instanceof Error ? error.message : "Invalid suite request" });
          return;
        }
        if (activeRun || activePreflight || activeDeletion) {
          json(res, 409, { error: "A test or selector preflight is already running. Finish it before starting another." });
          return;
        }
        const id = randomUUID();
        const suite: SuiteJob = {
          id, state: "running", startedAt: new Date().toISOString(),
          baseURL: base.href,
          entries: definitions.map(({ fileId, definition }) => ({
            fileId, title: definition.title, state: "queued",
          })),
        };
        suites.set(id, suite);
        while (suites.size > MAX_SUITE_HISTORY) {
          const oldest = suites.keys().next().value;
          if (!oldest || oldest === id) break;
          suites.delete(oldest);
        }
        activeRun = id; // Shared execution lock with single tests and preflight.
        json(res, 202, suiteSnapshot(suite));
        void (async () => {
          try {
            for (const [index, { fileId, definition }] of definitions.entries()) {
              const entry = suite.entries[index];
              entry.state = "running";
              const run = registerRun(fileId, id, base.href);
              entry.runId = run.id;
              try {
                const report = await runTest(definition, {
                  baseURL: base.href, outputDir: run.outputDir, timeoutMs,
                  onAssertionSearchIndex: (stepId, evidence) =>
                    run.assertionSearchIndex?.set(stepId, evidence),
                }, suppliedBrowser);
                run.report = report;
                await persistRun(run, "finished").catch(() => {
                  // A full disk should not change the already produced verdict.
                });
                run.state = "finished";
                entry.verdict = report.status;
                entry.durationMs = report.durationMs;
                entry.state = "finished";
              } catch {
                run.error = "Unexpected runner error. Check local server logs.";
                await persistRun(run, "error").catch(() => {});
                run.state = "error";
                entry.error = run.error;
                entry.state = "error";
              }
              // Deliberately continue after assertion failures / execution errors.
            }
          } finally {
            suite.state = "finished";
            suite.finishedAt = new Date().toISOString();
            try {
              const suiteDir = join(resultsDir, "suites", id);
              await mkdir(suiteDir, { recursive: true });
              await writeFile(join(suiteDir, "report.json"),
                JSON.stringify(suiteSnapshot(suite), null, 2) + "\n");
            } catch {
              // An artifact-write issue must not erase completed in-memory results.
            } finally {
              // Keep the execution lock until the suite's last report write
              // has finished. Delete All History cannot race that write.
              if (activeRun === id) activeRun = null;
            }
          }
        })().catch(() => {
          // An unexpected orchestration error should not hold the execution lock.
          suite.state = "finished";
          suite.finishedAt = new Date().toISOString();
          if (activeRun === id) activeRun = null;
        });
        return;
      }
      if (path === "/api/run") {
        let fileId: string;
        let definition: TestDefinition;
        let base: URL;
        let timeoutMs: number;
        try {
          if (!body || typeof body !== "object") throw new Error("Expected a request object");
          const input = body as Record<string, unknown>;
          if (typeof input.id !== "string") throw new Error("Approved test ID is required");
          fileId = input.id;
          base = validatedBaseURL(input.baseURL);
          timeoutMs = input.timeoutMs === undefined ? 5000 : Number(input.timeoutMs);
          if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) {
            throw new Error("Timeout must be between 100 and 60000 ms");
          }
          definition = await readSaved(fileId);
          verifyNavigations(definition, base);
        } catch (error) {
          json(res, 400, { error: error instanceof Error ? error.message : "Invalid test request" });
          return;
        }
        if (activeRun || activePreflight) {
          json(res, 409, { error: "A test or selector preflight is already running. Finish it before starting another." });
          return;
        }
        const job = registerRun(fileId, undefined, base.href);
        const id = job.id;
        activeRun = id;
        // Execute only when explicitly requested, using the *saved* approved test.
        // Runs are serialized to avoid opening several Chromiums on old laptops.
        void runTest(definition, {
          baseURL: base.href, outputDir: job.outputDir, timeoutMs,
          onAssertionSearchIndex: (stepId, entries) => job.assertionSearchIndex?.set(stepId, entries),
        }, suppliedBrowser).then(async (report) => {
          job.report = report;
          await persistRun(job, "finished").catch(() => {});
          job.state = "finished";
        }).catch(async () => {
          job.error = "Unexpected runner error. Review local server logs.";
          await persistRun(job, "error").catch(() => {});
          job.state = "error";
        }).finally(() => { if (activeRun === id) activeRun = null; });
        json(res, 202, snapshot(job));
        return;
      }
      if (path === "/api/generate") {
        let input: ReturnType<typeof requestDetails>;
        try {
          input = requestDetails(body);
        } catch (error) {
          json(res, 400, { error: error instanceof Error ? error.message : String(error) });
          return;
        }
        const provider = input.provider === "groq" ? (groqOverride ?? groqProvider) : fixtureProvider();
        const model = input.provider === "groq" ? process.env.GROQ_MODEL ?? "openai/gpt-oss-20b" : "deterministic-fixture";
        try {
          const result = await generateDraft({
            baseURL: input.baseURL, requirements: input.requirements, model,
            retryMalformedOutput: input.provider === "groq",
          }, provider);
          json(res, 200, {
            definition: result.definition, needsReview: true, provider: input.provider,
            generationAttempts: result.generationAttempts,
            message: input.provider === "fixture"
              ? "Fixture is a prewritten demonstration, not AI-generated."
              : result.generationAttempts > 1
                ? "The first AI draft was invalid. A second model call corrected its JSON schema. Review every step and assertion before approving."
                : "AI-generated draft. Verify each step and inferred assertion before approving.",
          });
        } catch (error) {
          if (error instanceof GroqProviderError) {
            // Upstream 400 is NOT invalid local user input: distinguish origins.
            json(res, 502, {
              source: error.source,
              providerStatus: error.httpStatus,
              category: error.category,
              providerCode: error.providerCode,
              providerType: error.providerType,
              providerParam: error.providerParam,
              error: error.message,
              requirementsCharacters: input.requirements.length,
            });
          } else if (error instanceof GeneratedDraftValidationError) {
            json(res, 422, {
              source: error.source,
              category: error.category,
              attempts: error.attempts,
              problems: error.problems,
              error: error.message,
              requirementsCharacters: input.requirements.length,
            });
          } else {
            json(res, 422, {
              source: "generator",
              error: error instanceof Error ? error.message : "Generation failed",
              requirementsCharacters: input.requirements.length,
            });
          }
        }
        return;
      }
      try {
        const data = body as { definition?: unknown; baseURL?: unknown; replaceId?: unknown } | null;
        const base = validatedBaseURL(data?.baseURL);
        const definition = parseTestDefinition(data?.definition);
        verifyNavigations(definition, base);
        if (data?.replaceId !== undefined &&
          (typeof data.replaceId !== "string" || !SAVED_NAME.test(data.replaceId))) {
          throw new Error("Invalid saved test to replace");
        }
        const { id, file, replacedId } = await saveApproved(
          definition, data?.replaceId as string | undefined, base,
        );
        json(res, 200, {
          id, file, replacedId,
          message: replacedId
            ? "Amended test saved; previous version removed. No test has been executed."
            : "Saved approved test definition; no test has been executed.",
        });
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    })().catch(() => {
      if (!res.headersSent) json(res, 500, { error: "Internal review server error" });
      else res.end();
    });
  });
}

async function main(): Promise<void> {
  if (existsSync(".env")) loadEnvFile(".env");
  const server = await createReviewServer();
  server.listen(3100, "127.0.0.1", () => {
    console.log("Test review UI: http://127.0.0.1:3100");
    console.log("Local-only interface; no browser AI credentials required.");
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => server.close());
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
