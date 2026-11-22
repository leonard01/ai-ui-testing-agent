import type { TestAction, TestDefinition } from "./domain.js";
import { ensureAllowedNavigation } from "./inspect.js";
import { parseTestDefinition } from "./schema.js";

/** Generating source is deterministic and never launches a browser or contacts a model. */
export interface PlaywrightExportOptions {
  baseURL: string;
  /** Default time limit for each Playwright action or assertion. */
  timeoutMs?: number;
}

type Target = Exclude<TestAction, { kind: "navigate" | "assert-url" }>["target"];

const INTENT_RUNTIME = String.raw`
// This helper is bundled into the exported file: it imports nothing from
// AI UI Testing Agent. Intent targets resolve against the CURRENT page.
// Prefer explicit role/label/text locators when you can edit a stable locator.
type IntentRole = "button" | "textbox" | "checkbox" | "radio" | "combobox" |
  "heading" | "status" | "listitem";
type IntentOperation = "click" | "fill" | "check" | "select-option" | "press" |
  "assert-text" | "assert-visible";
type IntentQuery = { value: string; role?: IntentRole };
type Candidate = {
  index: number; role: string; name: string; text: string;
  nearby: string; testId: string; id: string; tag: string;
};
const STOP_WORDS = new Set([
  "a", "an", "the", "this", "that", "element", "control", "button", "field",
  "input", "textbox", "box", "link", "item", "click", "fill", "enter", "type",
  "find", "verify", "assert", "check", "visible", "select", "with", "called", "named",
]);
function words(value: string): string[] {
  return value.toLowerCase()
    .replace(/\buser[\s_-]+name\b/g, "username")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^a-z0-9]+/).filter(Boolean)
    .map((word) => word.endsWith("ies") && word.length > 4
      ? word.slice(0, -3) + "y"
      : word.endsWith("s") && word.length > 4 ? word.slice(0, -1) : word);
}
function terms(value: string): string[] {
  return [...new Set(words(value).filter((word) => !STOP_WORDS.has(word)))];
}
function candidateScore(candidate: Candidate, query: string[]): number | null {
  if (!query.length) return 0;
  const name = new Set(words(candidate.name));
  const text = new Set(words(candidate.text));
  const nearby = new Set(words(candidate.nearby));
  const role = new Set(words(candidate.role));
  let score = 0;
  for (const word of query) {
    if (name.has(word)) score += 15;
    else if (text.has(word)) score += 11;
    else if (role.has(word)) score += 10;
    else if (nearby.has(word)) score += 4;
    else return null;
  }
  const nameTerms = terms(candidate.name);
  if (nameTerms.length === query.length &&
      query.every((word) => nameTerms.includes(word))) score += 50;
  return score;
}
async function intentLocator(
  page: Page,
  intent: IntentQuery,
  operation: IntentOperation,
): Promise<Locator> {
  const query = terms(intent.value);
  if (!query.length && !intent.role) {
    throw new Error("Intent needs a meaningful name or an explicit role");
  }
  const deadline = Date.now() + STEP_TIMEOUT;
  while (true) {
    const { selector, candidates } = await page.evaluate((op) => {
      const selectors: Record<IntentOperation, string> = {
        click: "button, a[href], input[type=submit], input[type=button], input[type=checkbox], input[type=radio], [role=button], [role=link], [role=checkbox], [role=radio]",
        fill: "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]), textarea, [contenteditable=true], [role=textbox]",
        press: "input:not([type=hidden]), textarea, select, button, a[href], [contenteditable=true], [role=textbox]",
        check: "input[type=checkbox], input[type=radio], [role=checkbox], [role=radio]",
        "select-option": "select, [role=combobox]",
        "assert-text": "[role=status], [role=alert], li, p, span, label, h1, h2, h3, td, strong, button, [data-testid]",
        "assert-visible": "[role=status], [role=alert], li, p, span, label, h1, h2, h3, td, strong, button, a[href], input, [data-testid]",
      };
      const selector = selectors[op];
      const clean = (value: string | null | undefined, max = 130) =>
        (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(selector))
        .slice(0, 250).flatMap((el, index) => {
          if (!el.getClientRects().length || el.closest("[hidden], [inert]")) return [];
          const style = getComputedStyle(el);
          if (style.visibility === "hidden" || style.display === "none") return [];
          const input = el as HTMLInputElement;
          const explicit = el.getAttribute("role");
          const role = explicit || (
            el.tagName === "BUTTON" || (el.tagName === "INPUT" &&
              ["submit", "button"].includes(input.type)) ? "button" :
            el.tagName === "A" ? "link" :
            el.tagName === "INPUT" && input.type === "checkbox" ? "checkbox" :
            el.tagName === "INPUT" && input.type === "radio" ? "radio" :
            el.tagName === "SELECT" ? "combobox" :
            el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? "textbox" :
            /^H[1-6]$/.test(el.tagName) ? "heading" :
            el.tagName === "LI" ? "listitem" : ""
          );
          const labelledBy = (el.getAttribute("aria-labelledby") ?? "")
            .split(/\s+/).filter(Boolean)
            .map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
          const label = input.labels?.[0]?.textContent;
          const text = clean(el.innerText || el.textContent);
          const name = clean(el.getAttribute("aria-label") || labelledBy || label ||
            el.getAttribute("placeholder") || el.getAttribute("title") ||
            (el.tagName === "INPUT" ? input.value &&
              ["submit", "button"].includes(input.type) ? input.value : "" : text));
          const nearby = clean(el.parentElement?.innerText, 180);
          return [{
            index, tag: el.tagName.toLowerCase(), role, name, text, nearby,
            testId: clean(el.getAttribute("data-testid"), 100),
            id: clean(el.id, 100),
          }];
        });
      return { selector, candidates };
    }, operation);
    const ranked = candidates
      .filter((candidate) => !intent.role || candidate.role === intent.role)
      .flatMap((candidate) => {
        const score = candidateScore(candidate, query);
        return score === null ? [] : [{ candidate, score }];
      }).sort((a, b) => b.score - a.score);
    if (ranked.length) {
      const best = ranked[0].score;
      const tied = ranked.filter((entry) => entry.score === best);
      if (tied.length !== 1) {
        throw new Error("Ambiguous intent " + JSON.stringify(intent.value) +
          ": " + tied.length + " equally plausible elements. Refine the target.");
      }
      const selected = tied[0].candidate;
      const choices = [
        ...(selected.testId ? [page.getByTestId(selected.testId)] : []),
        ...(selected.id ? [page.locator("[id=" + JSON.stringify(selected.id) + "]")] : []),
        page.locator(selector).nth(selected.index),
      ];
      for (const choice of choices) {
        if (await choice.count() === 1 && await choice.isVisible()) return choice;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error("Could not resolve intent " + JSON.stringify(intent.value) +
        " against the current page; use an explicit locator if necessary");
    }
    await page.waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now())));
  }
}
`;

function literal(value: string | number | object): string {
  return JSON.stringify(value);
}

function targetExpression(target: Target, operation: string): string {
  if (target.by === "role") {
    const base = "page.getByRole(" + literal(target.role) + ", " +
      (target.name === undefined ? "{ exact: true }" :
        "{ name: " + literal(target.name) + ", exact: true }") + ")";
    return "nth" in target && target.nth !== undefined
      ? base + ".nth(" + target.nth + ")" : base;
  }
  if (target.by === "label") {
    return "page.getByLabel(" + literal(target.value) + ", { exact: true })";
  }
  if (target.by === "placeholder") {
    return "page.getByPlaceholder(" + literal(target.value) + ", { exact: true })";
  }
  if (target.by === "text") {
    return "page.getByText(" + literal(target.value) + ", { exact: true })";
  }
  return "await intentLocator(page, " +
    literal({ value: target.value, ...(target.role ? { role: target.role } : {}) }) +
    ", " + literal(operation) + ")";
}

function portablePath(raw: string, base: URL): string {
  const destination = ensureAllowedNavigation(raw, base);
  // Preserve the path/query/hash, but allow TEST_BASE_URL to point to another
  // environment (staging, CI, localhost) without stale absolute URLs.
  return destination.pathname + destination.search + destination.hash;
}
function exportAction(action: TestAction, base: URL): string[] {
  if (action.kind === "navigate") {
    return ["await page.goto(sameOriginURL(" + literal(portablePath(action.url, base)) +
      "), { waitUntil: 'domcontentloaded' });"];
  }
  if (action.kind === "assert-url") {
    return [
      "// Assertion provenance: " + action.provenance,
      "await expect(page).toHaveURL(sameOriginURL(" + literal(portablePath(action.expected, base)) +
      "), { timeout: STEP_TIMEOUT });",
    ];
  }
  const operation = action.kind === "uncheck" ? "check" : action.kind === "assert-count"
    ? "assert-visible" : action.kind;
  const locator = targetExpression(action.target, operation);
  const lines = ["const target = " + locator + ";"];
  if (action.kind === "click") lines.push("await target.click();");
  else if (action.kind === "fill") {
    lines.push("await target.fill(" + literal(action.value) + ");");
  } else if (action.kind === "check") lines.push("await target.check();");
  else if (action.kind === "uncheck") lines.push("await target.uncheck();");
  else if (action.kind === "select-option") {
    lines.push("await target.selectOption(" + literal(action.value) + ");");
  } else if (action.kind === "press") {
    lines.push("await target.press(" + literal(action.key) + ");");
  } else if (action.kind === "assert-count") {
    lines.push("// Assertion provenance: " + action.provenance);
    lines.push("await expect(target).toHaveCount(" + action.expected +
      ", { timeout: STEP_TIMEOUT });");
  } else if (action.kind === "assert-text") {
    lines.push("// Assertion provenance: " + action.provenance);
    lines.push("await expect(target).toHaveCount(1, { timeout: STEP_TIMEOUT });");
    lines.push("await expect(target)." + (action.match === "contains" ? "toContainText(" : "toHaveText(") + literal(action.expected) +
      ", { timeout: STEP_TIMEOUT });");
  } else if (action.kind === "assert-visible") {
    lines.push("// Assertion provenance: " + action.provenance);
    lines.push("await expect(target).toHaveCount(1, { timeout: STEP_TIMEOUT });");
    lines.push("await expect(target).toBeVisible({ timeout: STEP_TIMEOUT });");
  }
  return lines;
}

/**
 * Convert a validated approved-style JSON test to a portable Playwright spec.
 * It is a standalone file: the only import is from @playwright/test.
 *
 * Callers must ensure only approved/saved definitions can be downloaded from
 * the UI. This pure function also supports local/CLI integration tests.
 */
export function generatePlaywrightSpec(
  input: unknown,
  options: PlaywrightExportOptions,
): string {
  const definition: TestDefinition = parseTestDefinition(input);
  const base = new URL(options.baseURL);
  ensureAllowedNavigation(base.href, base);
  for (const step of definition.steps) {
    if (step.action.kind === "navigate") ensureAllowedNavigation(step.action.url, base);
    if (step.action.kind === "assert-url") ensureAllowedNavigation(step.action.expected, base);
  }
  const timeout = options.timeoutMs ?? 5000;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 60000) {
    throw new Error("Export timeout must be an integer between 100 and 60000 ms");
  }
  const header = [
    "// Standalone Playwright TypeScript test generated from a reviewed JSON test.",
    "// No imports from AI UI Testing Agent and no hosted AI calls.",
    "// Install @playwright/test and Chromium in your own Playwright project.",
    "// Override the original application URL with TEST_BASE_URL if necessary.",
    "// Review test data before sharing or committing: inputs may contain secrets.",
    'import { test, expect, type Page, type Locator } from "@playwright/test";',
    "",
    "const DEFAULT_BASE_URL = " + literal(base.href) + ";",
    "const BASE_URL = new URL(process.env.TEST_BASE_URL ?? DEFAULT_BASE_URL);",
    "const STEP_TIMEOUT = " + timeout + ";",
    "if (![\"http:\", \"https:\"].includes(BASE_URL.protocol) || BASE_URL.username || BASE_URL.password) {",
    '  throw new Error("TEST_BASE_URL must be an HTTP(S) URL without credentials");',
    "}",
    "function sameOriginURL(value: string): string {",
    "  const destination = new URL(value, BASE_URL);",
    "  if (![\"http:\", \"https:\"].includes(destination.protocol) ||",
    "      destination.origin !== BASE_URL.origin || destination.username || destination.password) {",
    '    throw new Error("Test navigation must stay on the configured application origin");',
    "  }",
    "  return destination.href;",
    "}",
    "",
  ];
  const usesIntent = definition.steps.some((step) =>
    "target" in step.action && step.action.target.by === "intent");
  if (usesIntent) header.push(INTENT_RUNTIME);
  const lines = [
    ...header,
    "test(" + literal(definition.title) + ", async ({ page }) => {",
    "  test.setTimeout(" + Math.max(30_000, definition.steps.length * (timeout + 2000)) + ");",
    "  page.setDefaultTimeout(STEP_TIMEOUT);",
    "  page.setDefaultNavigationTimeout(STEP_TIMEOUT);",
    '  await page.route("**/*", (route) => {',
    "    try {",
    "      return new URL(route.request().url()).origin === BASE_URL.origin",
    '        ? route.continue() : route.abort("blockedbyclient");',
    "    } catch {",
    '      return route.abort("blockedbyclient");',
    "    }",
    "  });",
  ];
  for (const [index, step] of definition.steps.entries()) {
    lines.push("  await test.step(" +
      literal((index + 1) + ". " + step.description) +
      ", async () => {");
    for (const actionLine of exportAction(step.action, base)) {
      lines.push("    " + actionLine);
    }
    lines.push("  });");
  }
  lines.push("});", "");
  return lines.join("\n");
}
