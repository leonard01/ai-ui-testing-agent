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
import { assertCredentialsReviewed } from "./credential-guard.js";
import { coverageWarnings } from "./requirement-preservation.js";
import { ensureAllowedNavigation } from "./inspect.js";
import { installBrowserRequestPolicy } from "./browser-request-policy.js";
import { SEARCH_RESULT_ITEM_SELECTOR } from "./search-results.js";
import { AmbiguousIntentError, discoverTarget, recoverAmbiguousCartClick, findLocatorAlternatives, findAssertionAlternatives, captureAssertionSearchIndex, type AssertionSearchEntry } from "./discovery.js";
import type { RunReport, TestAction, StepResult } from "./domain.js";

export interface RunOptions {
  baseURL: string;
  outputDir: string;
  headed?: boolean;
  timeoutMs?: number;
  onAssertionSearchIndex?: (stepId: string, entries: AssertionSearchEntry[]) => void;
}
type Target = Exclude<TestAction, { kind: "navigate" | "assert-url" }>["target"];
function locate(page: Page, target: Target): Locator {
  if (target.by === "role") {
    const matches = page.getByRole(target.role, { name: target.name, exact: true });
    return "nth" in target && target.nth !== undefined ? matches.nth(target.nth) : matches;
  }
  if (target.by === "label")
    return page.getByLabel(target.value, { exact: true });
  if (target.by === "placeholder")
    return page.getByPlaceholder(target.value, { exact: true });
  if (target.by === "text")
    return page.getByText(target.value, { exact: true });
  if (target.by === "testid") return page.getByTestId(target.value);
  if (target.by === "id") return page.locator("css=[id=" + JSON.stringify(target.value) + "]");
  if (target.by === "css") return page.locator("css=" + target.value);
  if (target.by === "xpath") return page.locator("xpath=" + target.value);
  throw new Error("Intent targets must be grounded using live DOM discovery");
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
function navigationURL(url: string, base: URL): string {
  // Use the same application-aware resolver as preflight and export, while
  // retaining the established runner error for invalid/cross-origin targets.
  try {
    return ensureAllowedNavigation(url, base).href;
  } catch {
    throw new Error("Navigation must stay on the configured HTTP(S) application origin");
  }
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
    // Fail before opening a browser if a draft placeholder reached the runner.
    assertCredentialsReviewed(definition);
    report.testId = definition.id;
    report.title = definition.title;
    const unresolvedCoverage = coverageWarnings(definition);
    if (unresolvedCoverage.length) report.coverageWarnings = unresolvedCoverage.map(row=>({id:row.id,text:row.text,issue:row.issue || "No valid executable step mapping."}));
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
    for (const step of definition.steps) {
      if (step.action.kind === "navigate") navigationURL(step.action.url, base);
      if (step.action.kind === "assert-url") navigationURL(step.action.expected, base);
    }
    await mkdir(outputDir, { recursive: true });
    browser =
      suppliedBrowser ?? (await chromium.launch({ headless: !options.headed }));
    context = await browser.newContext({ serviceWorkers: "block" });
    context.setDefaultTimeout(timeout);
    context.setDefaultNavigationTimeout(timeout);
    await installBrowserRequestPolicy(context, base.origin);
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
        actionKind: step.action.kind,
        // Page-root assertions are allowed, but can accidentally match text
        // in another product/card. Preserve this as advisory run evidence.
        ...((step.action.kind === "assert-text" && step.action.scope !== "search-results") ||
          step.action.kind === "assert-visible" || step.action.kind === "assert-count"
          ? { domWideAssertion: true } : {}),
        status: "skipped",
        durationMs: 0,
      };
      report.steps.push(result);
      if (report.status !== "passed") continue;
      const stepStarted = performance.now();
      let checkingAssertion = false;
      try {
        const action = step.action;
        if (action.kind === "navigate") {
          await page.goto(navigationURL(action.url, base), {
            waitUntil: "domcontentloaded",
          });
        } else if (action.kind === "assert-url") {
          checkingAssertion = true;
          result.expected = navigationURL(action.expected, base);
          const deadline = performance.now() + timeout;
          while (true) {
            result.observed = page.url();
            if (result.observed === result.expected) break;
            const remaining = deadline - performance.now();
            if (remaining <= 0) {
              throw new Error("URL assertion failed: expected " +
                JSON.stringify(result.expected) + ", observed " + JSON.stringify(result.observed));
            }
            await delay(Math.min(50, remaining));
          }
        } else if (action.kind === "assert-text" && action.scope === "search-results") {
          // Never let the query echoed in the input, page heading or navigation
          // satisfy a search-result requirement. Inspect result CARDS only.
          checkingAssertion = true;
          result.expected = action.expected;
          result.textMatch = "contains";
          const expected = normalize(action.expected);
          const cards = page.locator(SEARCH_RESULT_ITEM_SELECTOR);
          const escaped = expected.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
          const matches = cards.filter({ hasText: new RegExp(escaped, "i") });
          const deadline = performance.now() + timeout;
          let found = false;
          while (true) {
            const count = await cards.count();
            const matchedCount = await matches.count();
            for (let i = 0; i < Math.min(matchedCount, 30); i++) {
              const candidate = matches.nth(i);
              if (!await candidate.isVisible()) continue;
              result.observed = normalize(await candidate.innerText()).slice(0, 500);
              found = true;
              break;
            }
            if (found) break;
            result.observed = count === 0
              ? "No identifiable search-result cards on the page"
              : count + " result card(s) found, but none contains " + JSON.stringify(expected);
            const remaining = deadline - performance.now();
            if (remaining <= 0) {
              throw new Error("Search-result assertion failed: " + result.observed +
                ". The query shown elsewhere on the page is not a returned result.");
            }
            await delay(Math.min(100, remaining));
          }
        } else {
          let target: Locator;
          if (action.target.by === "intent") {
            const { locator, evidence } = await discoverTarget(
              page, action.target,
              action.kind === "uncheck" ? "check" :
                action.kind === "assert-count" ? "assert-visible" : action.kind,
              timeout,
            );
            result.resolution = evidence;
            target = locator;
          } else {
            target = locate(page, action.target);
            // A generic role locator can lose item context retained in the
            // step description. Narrow only ambiguous clicks; never override
            // an explicit positional choice or change the stored definition.
            if (action.kind === "click" && action.target.by === "role" &&
                action.target.role === "button" && action.target.name &&
                action.target.nth === undefined) {
              const recovered = await recoverAmbiguousCartClick(
                page, target, action.target.name, step.description,
              );
              if (recovered) {
                target = recovered.locator;
                result.resolution = recovered.evidence;
              }
            }
            // Backward compatibility for reviewed scripts whose AI draft
            // confused visible placeholder text with a real HTML label.
            // Never guess among several matches or change a saved locator.
            if ((action.kind === "fill" || action.kind === "press") &&
                action.target.by === "label" && await target.count() === 0) {
              const alternative = page.getByPlaceholder(action.target.value, { exact: true });
              if (await alternative.count() === 1 && await alternative.isVisible()) {
                target = alternative;
                result.resolution = {
                  intent: action.target.value, method: "live-dom",
                  tag: await alternative.evaluate(el => el.tagName.toLowerCase()),
                  role: "textbox", name: action.target.value,
                  nearby: "", locator: "exact placeholder fallback " +
                    JSON.stringify(action.target.value),
                  candidatesInspected: 1,
                };
              }
            }
          }
          if (action.kind === "click") await target.click();
          else if (action.kind === "fill") await target.fill(action.value);
          else if (action.kind === "check") await target.check();
          else if (action.kind === "uncheck") await target.uncheck();
          else if (action.kind === "select-option") await target.selectOption(action.value);
          else if (action.kind === "press") await target.press(action.key);
          else if (action.kind === "assert-count") {
            // Zero elements is a valid expectation; do not require an attached target.
            checkingAssertion = true;
            result.expected = String(action.expected);
            const deadline = performance.now() + timeout;
            while (true) {
              const count = await target.count();
              result.observed = String(count);
              if (count === action.expected) break;
              const remaining = deadline - performance.now();
              if (remaining <= 0) {
                throw new Error("Count assertion failed: expected " +
                  action.expected + ", observed " + count);
              }
              await delay(Math.min(50, remaining));
            }
          } else {
            // Missing or ambiguous targets are execution errors.
            await target.waitFor({ state: "attached", timeout });
            if ((await target.count()) !== 1)
              throw new Error(
                "Assertion target must identify exactly one element",
              );
            checkingAssertion = true;
            if (action.kind === "assert-text") {
              result.expected = action.expected;
              result.textMatch = action.match ?? "exact";
              const expectedText = normalize(action.expected);
              const deadline = performance.now() + timeout;
              while (true) {
                const remaining = deadline - performance.now();
                // Never pass a nearly expired 1ms timeout to Playwright. Such
                // calls obscure a real expected/observed assertion mismatch.
                // A small floor permits one final DOM read before reporting.
                if (remaining <= 0 && result.observed !== undefined) {
                  throw new Error(
                    `Text assertion failed${action.match === "contains" ? " (contains)" : ""}: expected ${JSON.stringify(action.expected)}, observed ${JSON.stringify(result.observed)}`,
                  );
                }
                const readTimeout = Math.max(150, Math.ceil(remaining));
                result.observed = normalize(
                  (await target.textContent({ timeout: readTimeout })) ?? "",
                );
                if (action.match === "contains"
                  ? result.observed.includes(expectedText) : result.observed === expectedText) break;
                const timeLeft = deadline - performance.now();
                if (timeLeft <= 0) {
                  throw new Error(
                    `Text assertion failed${action.match === "contains" ? " (contains)" : ""}: expected ${JSON.stringify(action.expected)}, observed ${JSON.stringify(result.observed)}`,
                  );
                }
                await delay(Math.min(50, timeLeft));
              }
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
        if (error instanceof AmbiguousIntentError) {
          // Evidence comes from the live DOM, not an AI guess or error parsing.
          // Execution deliberately stops without acting on any candidate.
          result.ambiguity = error.ambiguity;
        } else if (page && step.action.kind === "assert-text" &&
          step.action.scope !== "search-results" &&
          result.status === "assertion-failed") {
          try {
            // A selector may resolve successfully but point to the wrong
            // element (e.g. "Add to cart" instead of "Sauce Labs Backpack").
            // Search for the unchanged EXPECTED text, not the locator name,
            // and offer the tester exact DOM-backed alternatives.
            const alternatives = await findAssertionAlternatives(
              page, step.action.target, "assert-text", step.action.expected, true,
            );
            result.assertionAlternatives = alternatives; // Keep original locator/query even with no suggested matches.
          } catch {
            // Keep the failed assertion even if diagnostic search fails.
          }
        } else if (page && (step.action.kind === "click" || step.action.kind === "fill") &&
          step.action.target.by !== "intent" && result.status === "execution-error" &&
          /Timeout.*exceeded|strict mode violation|waiting for getBy/i.test(message(error))) {
          try {
            const currentLocator = locate(page, step.action.target);
            // Only propose a replacement when the declared target no longer
            // resolves to exactly one element. Never override app action failures.
            if (await currentLocator.count() !== 1) {
              const alternatives = await findLocatorAlternatives(
                page, step.action.target, step.action.kind,
              );
              if (alternatives.candidates.length) result.locatorAlternatives = alternatives;
            } else if (step.action.kind === "click" &&
                /intercepts pointer events|intercepting pointer events/i.test(message(error))) {
              // The target exists and is unique: changing its index cannot
              // fix a popup obscuring the click. Keep this distinct from a
              // missing/ambiguous selector and never force a click.
              result.blockedClick = { reason: "pointer-interception" };
              const button = await currentLocator.elementHandle();
              if (button && step.action.target.by === "role" &&
                  step.action.target.role === "button" &&
                  /search/i.test(step.action.target.name ?? "")) {
                for (let i = report.steps.length - 2; i >= 0; i--) {
                  const prior = definition.steps[i];
                  if (prior.action.kind !== "fill" ||
                      prior.action.target.by === "intent" ||
                      report.steps[i]?.status !== "passed") continue;
                  const field = locate(page, prior.action.target);
                  if (await field.count() !== 1 || !await field.isVisible()) continue;
                  const input = await field.elementHandle();
                  if (!input) continue;
                  const sameForm = await button.evaluate((element, textField) => {
                    if (!(element instanceof HTMLInputElement) ||
                        element.type !== "submit" ||
                        !(textField instanceof HTMLInputElement) ||
                        !["text", "search"].includes(textField.type)) return false;
                    return !!element.form && element.form === textField.form;
                  }, input);
                  if (sameForm) {
                    result.blockedClick.submitWithEnter = {
                      sourceStepId: prior.id, target: prior.action.target,
                    };
                    break;
                  }
                }
              }
            }
          } catch {
            // Preserve the original failure even if optional discovery fails.
          }
        } else if (page && (step.action.kind === "assert-text" ||
            step.action.kind === "assert-visible") &&
          result.status === "execution-error") {
          try {
            // The assertion can fail because the model guessed an inaccessible
            // role/name (not only an explicit Playwright selector). Suggest
            // other verified targets when the original matches NOTHING.
            // Never override a real invisible element or change expectations.
            const missing = step.action.target.by === "intent" ||
              await locate(page, step.action.target).count() === 0;
            if (missing) {
              const alternatives = await findAssertionAlternatives(
                page, step.action.target, step.action.kind,
                step.action.kind === "assert-text" ? step.action.expected : undefined,
              );
              result.assertionAlternatives = alternatives; // Keep original locator/query even with no suggested matches.
            }
          } catch {
            // Candidate discovery is best-effort; retain the original error.
          }
        }
        if (page && (step.action.kind === "assert-text" && step.action.scope !== "search-results" ||
            step.action.kind === "assert-visible") && options.onAssertionSearchIndex) {
          try {
            const index = await captureAssertionSearchIndex(page);
            options.onAssertionSearchIndex(step.id, index);
            result.assertionSearchAvailable = true;
          } catch {
            // Failed assertion and its screenshot remain available.
          }
        }
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
