import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Locator,
} from "playwright";
import { parseTestDefinition } from "./schema.js";
import { discoverTarget } from "./discovery.js";
import type { RunReport, TestAction, StepResult } from "./domain.js";

export interface RunOptions {
  baseURL: string;
  outputDir: string;
  headed?: boolean;
  timeoutMs?: number;
}
type Target = Exclude<TestAction, { kind: "navigate" }>["target"];
function locate(page: Page, target: Target): Locator {
  if (target.by === "role")
    return page.getByRole(target.role, { name: target.name, exact: true });
  if (target.by === "label")
    return page.getByLabel(target.value, { exact: true });
  if (target.by === "text")
    return page.getByText(target.value, { exact: true });
  throw new Error("Intent targets must be grounded using live DOM discovery");
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
function navigationURL(url: string, base: URL): string {
  const destination = new URL(url, base);
  if (
    !["http:", "https:"].includes(destination.protocol) ||
    destination.origin !== base.origin ||
    destination.username ||
    destination.password
  ) {
    throw new Error(
      "Navigation must stay on the configured HTTP(S) application origin",
    );
  }
  return destination.href;
}

/** Validate first. Each run owns a fresh context; an injected browser remains caller-owned. */
export async function runTest(
  input: unknown,
  options: RunOptions,
  suppliedBrowser?: Browser,
): Promise<RunReport> {
  const started = performance.now();
  const report: RunReport = {
    schemaVersion: 1,
    testId: null,
    title: null,
    status: "execution-error",
    startedAt: new Date().toISOString(),
    durationMs: 0,
    steps: [],
    artifacts: {},
    evidenceErrors: [],
  };
  const outputDir = resolve(options.outputDir);
  let browser: Browser | undefined,
    context: BrowserContext | undefined,
    page: Page | undefined;
  let tracing = false;
  try {
    const definition = parseTestDefinition(input);
    report.testId = definition.id;
    report.title = definition.title;
    const timeout = options.timeoutMs ?? 5000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60000)
      throw new Error("timeoutMs must be an integer between 1 and 60000");
    const base = new URL(options.baseURL);
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password
    )
      throw new Error("baseURL must be an HTTP(S) URL without credentials");
    for (const step of definition.steps)
      if (step.action.kind === "navigate") navigationURL(step.action.url, base);
    await mkdir(outputDir, { recursive: true });
    browser =
      suppliedBrowser ?? (await chromium.launch({ headless: !options.headed }));
    context = await browser.newContext({ serviceWorkers: "block" });
    context.setDefaultTimeout(timeout);
    context.setDefaultNavigationTimeout(timeout);
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === base.origin
        ? route.continue()
        : route.abort("blockedbyclient"),
    );
    await context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
    });
    tracing = true;
    page = await context.newPage();
    report.status = "passed";
    for (const step of definition.steps) {
      const result: StepResult = {
        id: step.id,
        description: step.description,
        status: "skipped",
        durationMs: 0,
      };
      report.steps.push(result);
      if (report.status !== "passed") continue;
      const stepStarted = performance.now();
      let checkingAssertion = false;
      try {
        const action = step.action;
        if (action.kind === "navigate")
          await page.goto(navigationURL(action.url, base), {
            waitUntil: "domcontentloaded",
          });
        else {
          const target = action.target.by === "intent"
            ? await (async () => {
              const { locator, evidence } = await discoverTarget(page, action.target, action.kind, timeout);
              result.resolution = evidence;
              return locator;
            })()
            : locate(page, action.target);
          if (action.kind === "click") await target.click();
          else if (action.kind === "fill") await target.fill(action.value);
          else {
            // Missing or ambiguous targets are execution errors.
            await target.waitFor({ state: "attached", timeout });
            if ((await target.count()) !== 1)
              throw new Error(
                "Assertion target must identify exactly one element",
              );
            checkingAssertion = true;
            if (action.kind === "assert-text") {
              result.expected = action.expected;
              const deadline = performance.now() + timeout;
              do {
                result.observed = normalize(
                  (await target.textContent({
                    timeout: Math.max(1, deadline - performance.now()),
                  })) ?? "",
                );
                if (result.observed === normalize(action.expected)) break;
                if (performance.now() >= deadline)
                  throw new Error(
                    `Text assertion failed: expected ${JSON.stringify(action.expected)}, observed ${JSON.stringify(result.observed)}`,
                  );
                await delay(50);
              } while (true);
            } else {
              result.expected = "visible";
              await target.waitFor({ state: "visible", timeout });
              result.observed = "visible";
            }
          }
        }
        result.status = "passed";
      } catch (error) {
        result.status = checkingAssertion
          ? "assertion-failed"
          : "execution-error";
        result.error = message(error);
        report.status = result.status;
      } finally {
        result.durationMs = Math.round(performance.now() - stepStarted);
      }
    }
  } catch (error) {
    report.status = "execution-error";
    report.error = message(error);
  } finally {
    if (report.status !== "passed" && page) {
      try {
        await page.screenshot({
          path: join(outputDir, "failure.png"),
          fullPage: true,
          timeout: 3000,
        });
        report.artifacts.screenshot = "failure.png";
      } catch (error) {
        report.evidenceErrors.push(`Screenshot: ${message(error)}`);
      }
    }
    if (context && tracing) {
      try {
        await context.tracing.stop(
          report.status === "passed"
            ? {}
            : { path: join(outputDir, "trace.zip") },
        );
        if (report.status !== "passed") report.artifacts.trace = "trace.zip";
      } catch (error) {
        report.evidenceErrors.push(`Trace: ${message(error)}`);
      }
    }
    try {
      await context?.close();
    } catch (error) {
      report.evidenceErrors.push(`Context cleanup: ${message(error)}`);
    }
    if (!suppliedBrowser) {
      try {
        await browser?.close();
      } catch (error) {
        report.evidenceErrors.push(`Browser cleanup: ${message(error)}`);
      }
    }
    report.durationMs = Math.round(performance.now() - started);
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      join(outputDir, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
  }
  return report;
}
