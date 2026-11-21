import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { generateDraft } from "./generation.js";
import { fixtureProvider } from "./local-providers.js";
import { groqProvider, GroqProviderError } from "./hosted-providers.js";
import { parseTestDefinition } from "./schema.js";
import { ensureAllowedNavigation } from "./inspect.js";
import { runTest } from "./runner.js";
import type { Browser } from "playwright";
import type { RunReport, TestDefinition } from "./domain.js";

const MAX_BODY_BYTES = 110_000;
const MAX_REQUIREMENTS_CHARS = 12_000;
const SAVED_NAME = /^reviewed-\d{13}-[a-f0-9]{8}\.json$/;
const RUN_ID = /^[a-f0-9-]{36}$/;
const MAX_RUN_HISTORY = 20;

type RunJob = {
  id: string;
  fileId: string;
  state: "running" | "finished" | "error";
  startedAt: string;
  outputDir: string;
  report?: RunReport;
  error?: string;
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
export async function createReviewServer(outputDir = "generated", suppliedBrowser?: Browser) {
  const html = await readFile(new URL("../demo/review.html", import.meta.url));
  const savedDir = resolve(outputDir);
  const resultsDir = resolve(outputDir === "generated" ? "run-results" : join(outputDir, "run-results"));
  const jobs = new Map<string, RunJob>();
  let activeRun: string | null = null;

  async function readSaved(id: string): Promise<TestDefinition> {
    if (!SAVED_NAME.test(id)) throw new Error("Invalid approved test filename");
    const input = JSON.parse(await readFile(join(savedDir, id), "utf8")) as unknown;
    return parseTestDefinition(input);
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
      if (req.method === "GET" && path === "/api/tests") {
        try {
          const names = (await readdir(savedDir))
            .filter((name) => SAVED_NAME.test(name)).sort().reverse().slice(0, 100);
          const saved: Array<{ id: string; title: string; steps: number }> = [];
          for (const id of names) {
            try {
              const definition = await readSaved(id);
              saved.push({ id, title: definition.title, steps: definition.steps.length });
            } catch { /* Skip invalid or unreadable files */ }
          }
          json(res, 200, { tests: saved });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") json(res, 200, { tests: [] });
          else json(res, 500, { error: "Could not list approved tests" });
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
      if (req.method !== "POST" || !["/api/generate", "/api/save", "/api/run"].includes(path)) {
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
        if (activeRun) {
          json(res, 409, { error: "A test is already running. Finish it before starting another." });
          return;
        }
        const id = randomUUID();
        const job: RunJob = {
          id, fileId, state: "running", startedAt: new Date().toISOString(),
          outputDir: join(resultsDir, id),
        };
        jobs.set(id, job);
        if (jobs.size > MAX_RUN_HISTORY) {
          const oldest = jobs.keys().next().value;
          if (oldest && oldest !== id) jobs.delete(oldest);
        }
        activeRun = id;
        // Execute only when explicitly requested, using the *saved* approved test.
        // Runs are serialized to avoid opening several Chromiums on old laptops.
        void runTest(definition, {
          baseURL: base.href, outputDir: job.outputDir, timeoutMs,
        }, suppliedBrowser).then((report) => {
          job.report = report;
          job.state = "finished";
        }).catch(() => {
          job.state = "error";
          job.error = "Unexpected runner error. Review local server logs.";
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
        const provider = input.provider === "groq" ? groqProvider : fixtureProvider();
        const model = input.provider === "groq" ? process.env.GROQ_MODEL ?? "openai/gpt-oss-20b" : "deterministic-fixture";
        try {
          const result = await generateDraft({
            baseURL: input.baseURL, requirements: input.requirements, model,
          }, provider);
          json(res, 200, {
            definition: result.definition, needsReview: true, provider: input.provider,
            message: input.provider === "fixture"
              ? "Fixture is a prewritten demonstration, not AI-generated."
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
        const data = body as { definition?: unknown; baseURL?: unknown } | null;
        const base = validatedBaseURL(data?.baseURL);
        const definition = parseTestDefinition(data?.definition);
        verifyNavigations(definition, base);
        const id = "reviewed-" + Date.now() + "-" + randomUUID().slice(0, 8) + ".json";
        const file = join(savedDir, id);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(definition, null, 2) + "\n", { flag: "wx" });
        json(res, 200, { id, file, message: "Saved approved test definition; no test has been executed." });
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
