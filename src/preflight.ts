import { chromium, type Browser, type Locator, type Page } from "playwright";
import type { TestAction, TestDefinition } from "./domain.js";
import { ensureAllowedNavigation } from "./inspect.js";
import { parseTestDefinition } from "./schema.js";

type Target = Exclude<TestAction, { kind: "navigate" | "assert-url" }>["target"];
export type PreflightStatus = "matched" | "initial-match" | "warning" | "deferred";

export interface PreflightFinding {
  stepId: string;
  stepNumber: number;
  status: PreflightStatus;
  message: string;
  matches?: number;
  /** Informational only: never applied to a test or assertion automatically. */
  suggestedTarget?: Exclude<Target, { by: "intent" }>;
}

export interface PreflightReport {
  inspectedURL: string;
  /** This preflight never plays test actions or makes an AI request. */
  readOnly: true;
  findings: PreflightFinding[];
  summary: { matched: number; warnings: number; deferred: number };
}

function locator(page: Page, target: Exclude<Target, { by: "intent" }>): Locator {
  if (target.by === "role") {
    return page.getByRole(target.role, { name: target.name, exact: true });
  }
  if (target.by === "label") return page.getByLabel(target.value, { exact: true });
  return page.getByText(target.value, { exact: true });
}

/**
 * Locate an obvious alternative on the INITIAL page. This is a suggestion, not
 * proof of intent: a later step might target something created during the run.
 */
async function obviousAlternative(
  page: Page,
  target: Exclude<Target, { by: "intent" }>,
): Promise<PreflightFinding["suggestedTarget"]> {
  if (target.by === "label") {
    for (const role of ["button", "checkbox"] as const) {
      const candidate = page.getByRole(role, { name: target.value, exact: true });
      if (await candidate.count() === 1 && await candidate.isVisible()) {
        return { by: "role", role, name: target.value };
      }
    }
  }
  if (target.by === "role" && target.name) {
    const candidate = page.getByText(target.name, { exact: true });
    if (await candidate.count() === 1 && await candidate.isVisible()) {
      return { by: "text", value: target.name };
    }
  }
  return undefined;
}

async function isFillable(target: Locator): Promise<boolean> {
  return target.evaluate((element) => {
    if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly;
    if (element instanceof HTMLInputElement) {
      return !element.disabled && !element.readOnly &&
        !["hidden", "checkbox", "radio", "file", "button", "submit", "reset"].includes(element.type);
    }
    return element instanceof HTMLElement && element.isContentEditable;
  });
}

/**
 * Check the CURRENT starting page only, without running user steps.
 *
 * A target that appears after a fill/click may not exist yet; missing targets
 * in that section are deferred, never declared broken. A grounded alternate
 * that already exists on the starting page is shown as a non-blocking warning.
 * Neither expected results nor locators are modified.
 */
export async function preflightSelectors(
  input: unknown,
  baseURL: string,
  suppliedBrowser?: Browser,
): Promise<PreflightReport> {
  const definition: TestDefinition = parseTestDefinition(input);
  const base = new URL(baseURL);
  ensureAllowedNavigation(base.href, base);
  for (const step of definition.steps) {
    if (step.action.kind === "navigate") ensureAllowedNavigation(step.action.url, base);
    if (step.action.kind === "assert-url") ensureAllowedNavigation(step.action.expected, base);
  }
  const first = definition.steps[0].action;
  if (first.kind !== "navigate") throw new Error("First step must navigate");
  const firstURL = ensureAllowedNavigation(first.url, base);
  const browser = suppliedBrowser ?? await chromium.launch();
  const context = await browser.newContext({ serviceWorkers: "block" });
  context.setDefaultNavigationTimeout(10_000);
  try {
    await context.route("**/*", (route) => {
      try {
        return new URL(route.request().url()).origin === base.origin
          ? route.continue() : route.abort("blockedbyclient");
      } catch {
        return route.abort("blockedbyclient");
      }
    });
    const page = await context.newPage();
    await page.goto(firstURL.href, { waitUntil: "domcontentloaded" });
    // No script actions are replayed. We inspect a single isolated page load.
    const findings: PreflightFinding[] = [];
    let stateMayHaveChanged = false;
    let navigatedAgain = false;
    for (const [index, step] of definition.steps.entries()) {
      const action = step.action;
      if (action.kind === "navigate") {
        if (index > 0) navigatedAgain = true;
        continue;
      }
      if (action.kind === "assert-url") continue; // URL has no locator to preflight.
      const item = (status: PreflightStatus, message: string, extra: Partial<PreflightFinding> = {}) => {
        findings.push({ stepId: step.id, stepNumber: index + 1, status, message, ...extra });
      };
      if (navigatedAgain) {
        item("deferred", "This step follows another navigation. Check its target during execution.");
      } else if (action.target.by === "intent") {
        item("deferred", "Intent resolution depends on the live DOM at this step; no action was replayed.");
      } else {
        const target = action.target;
        const found = locator(page, target);
        const count = await found.count();
        if (action.kind === "assert-count") {
          item(stateMayHaveChanged ? "deferred" :
            count === action.expected ? "matched" : "warning",
            stateMayHaveChanged
              ? "Element count depends on earlier actions. Check during execution."
              : "Starting-page match count is " + count + "; expected " + action.expected + ".",
            { matches: count });
        } else if (count === 0) {
          const suggestedTarget = await obviousAlternative(page, target);
          if (suggestedTarget) {
            item("warning", "Original locator matches nothing on the starting page; a different locator does match: " +
              (suggestedTarget.by === "role"
                ? suggestedTarget.role + ' named "' + suggestedTarget.name + '"'
                : 'visible text "' + suggestedTarget.value + '"') +
              ". Review the locator before approving; later page state may differ.",
              { matches: 0, suggestedTarget });
          } else if (stateMayHaveChanged) {
            item("deferred", "Not present on the starting page; this step follows a state-changing action.");
          } else {
            item("warning", "Locator matches no elements on the starting page. It may be incorrect or load later.",
              { matches: 0 });
          }
        } else if (count > 1) {
          item(stateMayHaveChanged ? "deferred" : "warning",
            "Locator matches " + count + " elements on the starting page, not a unique target." +
            (stateMayHaveChanged ? " It may differ after earlier actions." : ""),
            { matches: count });
        } else if (!await found.isVisible()) {
          item(stateMayHaveChanged ? "deferred" : "warning",
            "Target exists but is hidden on the starting page" +
            (stateMayHaveChanged ? "; earlier actions might reveal it." : "."),
            { matches: 1 });
        } else if (action.kind === "fill" && !await isFillable(found)) {
          item("warning", "This locator points to an element that cannot be filled on the starting page.",
            { matches: 1 });
        } else if (action.kind === "select-option" &&
            !await found.evaluate((element) => element instanceof HTMLSelectElement)) {
          item("warning", "Select-option requires a native select element.", { matches: 1 });
        } else if ((action.kind === "check" || action.kind === "uncheck") &&
            !await found.evaluate((element) => element instanceof HTMLInputElement &&
              (element.type === "checkbox" || element.type === "radio"))) {
          item("warning", "Check/uncheck requires a checkbox or radio input.", { matches: 1 });
        } else {
          item(stateMayHaveChanged ? "initial-match" : "matched",
            stateMayHaveChanged
              ? "Unique and visible on the starting page; recheck at execution time after earlier actions."
              : "Unique and visible on the starting page.",
            { matches: 1 });
        }
      }
      if (["click", "fill", "select-option", "check", "uncheck", "press"].includes(action.kind))
        stateMayHaveChanged = true;
    }
    return {
      inspectedURL: page.url(),
      readOnly: true,
      findings,
      summary: {
        matched: findings.filter((finding) =>
          finding.status === "matched" || finding.status === "initial-match").length,
        warnings: findings.filter((finding) => finding.status === "warning").length,
        deferred: findings.filter((finding) => finding.status === "deferred").length,
      },
    };
  } finally {
    await context.close();
    if (!suppliedBrowser) await browser.close();
  }
}
