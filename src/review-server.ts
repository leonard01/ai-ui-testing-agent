import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { generateDraft } from "./generation.js";
import { fixtureProvider } from "./local-providers.js";
import { groqProvider } from "./hosted-providers.js";
import { parseTestDefinition } from "./schema.js";
import { ensureAllowedNavigation } from "./inspect.js";

const MAX_BODY_BYTES = 110_000;
const MAX_REQUIREMENTS_CHARS = 12_000;

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
  return !origin || origin === "http://" + host;
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

/**
 * Lightweight loopback-only test review UI. No API keys are sent to the browser.
 * Saving an approved draft never executes it. Safe for local development only:
 * there is deliberately no public-network listener or user authentication.
 */
export async function createReviewServer(outputDir = "generated") {
  const html = await readFile(new URL("../demo/review.html", import.meta.url));
  return createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (req.method === "GET" && path === "/") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
        });
        res.end(html);
        return;
      }
      if (req.method === "GET" && path === "/health") {
        json(res, 200, { ok: true });
        return;
      }
      if (req.method !== "POST" || !["/api/generate", "/api/save"].includes(path)) {
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
          json(res, 422, { error: error instanceof Error ? error.message : "Generation failed" });
        }
        return;
      }
      try {
        const data = body as { definition?: unknown; baseURL?: unknown } | null;
        if (typeof data?.baseURL !== "string") throw new Error("Application URL is required");
        const base = new URL(data.baseURL);
        ensureAllowedNavigation(base.href, base);
        const definition = parseTestDefinition(data.definition);
        for (const step of definition.steps) {
          if (step.action.kind === "navigate") {
            ensureAllowedNavigation(step.action.url, base);
          }
        }
        const file = join(resolve(outputDir), "reviewed-" + Date.now() + "-" + randomUUID().slice(0, 8) + ".json");
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(definition, null, 2) + "\n", { flag: "wx" });
        json(res, 200, { file, message: "Saved approved test definition; no test has been executed." });
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
