import type { Locator, Page } from "playwright";

/** A human intention is not an AI-invented CSS selector. */
export interface IntentTarget {
  by: "intent";
  value: string;
  role?: "button" | "textbox" | "checkbox" | "heading" | "status" | "listitem";
}
export type TargetOperation = "click" | "fill" | "assert-text" | "assert-visible";

interface DomCandidate {
  index: number;
  tag: string;
  role: string;
  name: string;
  text: string;
  nearby: string;
  testId: string;
  id: string;
}
/** Page-derived alternatives offered for explicit human selection only. */
export interface AmbiguousCandidate {
  tag: string;
  role: string;
  name: string;
  nearby: string;
}
export interface AmbiguousResolution {
  intent: string;
  role?: IntentTarget["role"];
  candidates: AmbiguousCandidate[];
  total: number;
}

/** Original failed locator plus candidates discovered at the failure point. */
export type ExplicitTarget =
  | { by: "role"; role: NonNullable<IntentTarget["role"]>; name?: string }
  | { by: "label" | "text"; value: string };
export interface MissingLocatorChoices {
  attempted: ExplicitTarget;
  candidates: AmbiguousCandidate[];
  total: number;
}


/** Explicitly selected correction for a missing assertion target. */
export interface AssertionCandidate extends AmbiguousCandidate {
  /** Verified Playwright selector, grounded in the live DOM. */
  target: ExplicitTarget;
}
export interface MissingAssertionChoices {
  attempted: ExplicitTarget | IntentTarget;
  query: string;
  candidates: AssertionCandidate[];
  total: number;
}

/** Deliberately stop before any click or fill if the live DOM is ambiguous. */
export class AmbiguousIntentError extends Error {
  readonly ambiguity: AmbiguousResolution;
  constructor(ambiguity: AmbiguousResolution) {
    super(
      "Ambiguous intent " + JSON.stringify(ambiguity.intent) + ": " +
      ambiguity.total + " equally plausible elements: " +
      ambiguity.candidates.map((candidate) =>
        "<" + candidate.tag + "> role=" + JSON.stringify(candidate.role) +
        " name=" + JSON.stringify(candidate.name) +
        " nearby=" + JSON.stringify(candidate.nearby)
      ).join("; "),
    );
    this.name = "AmbiguousIntentError";
    this.ambiguity = ambiguity;
  }
}

export interface DiscoveryEvidence {
  intent: string;
  method: "live-dom";
  tag: string;
  role: string;
  name: string;
  nearby: string;
  locator: string;
  candidatesInspected: number;
}

const COMMON = new Set([
  "a", "an", "the", "this", "that", "element", "control", "button", "field",
  "input", "textbox", "box", "link", "item", "click", "fill", "enter", "type",
  "find", "verify", "assert", "check", "visible", "select", "with", "called", "named",
]);
function tokens(value: string): string[] {
  return value.toLowerCase()
    .replace(/\buser[\s_-]+name\b/g, "username")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^a-z0-9]+/g).filter(Boolean)
    .map((word) => word.endsWith("ies") && word.length > 4
      ? word.slice(0, -3) + "y"
      : word.endsWith("s") && word.length > 4 ? word.slice(0, -1) : word);
}
function keywords(value: string): string[] {
  return [...new Set(tokens(value).filter((word) => !COMMON.has(word)))];
}
function candidateScore(candidate: DomCandidate, words: string[]): number | null {
  if (words.length === 0) return 0;
  const name = new Set(tokens(candidate.name));
  const text = new Set(tokens(candidate.text));
  const context = new Set(tokens(candidate.nearby));
  const role = new Set(tokens(candidate.role));
  let points = 0;
  for (const word of words) {
    if (name.has(word)) points += 15;
    else if (text.has(word)) points += 11;
    else if (role.has(word)) points += 10;
    else if (context.has(word)) points += 4;
    else return null; // Require evidence for EVERY meaningful part of the request.
  }
  const meaningfulName = keywords(candidate.name);
  if (meaningfulName.length === words.length &&
    words.every((word) => meaningfulName.includes(word))) points += 50;
  return points;
}

/**
 * Collect only elements relevant to the action, on the LIVE page at execution time.
 * Avoids DOM dumps, page-wide AI guesses, and values of sensitive input fields.
 */
async function inspectCandidates(page: Page, operation: TargetOperation): Promise<{
  selector: string; candidates: DomCandidate[];
}> {
  return page.evaluate((op) => {
    const selectorByOperation = {
      click: "button, a[href], input[type=submit], input[type=button], input[type=checkbox], [role=button], [role=link], [role=checkbox]",
      fill: "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]), textarea, [contenteditable=true], [role=textbox]",
      "assert-text": "[role=status], [role=alert], li, p, span, label, h1, h2, h3, td, strong, button, [data-testid]",
      "assert-visible": "[role=status], [role=alert], li, p, span, label, h1, h2, h3, td, strong, button, a[href], input, [data-testid]",
    } as const;
    const selector = selectorByOperation[op];
    const trim = (value: string | null | undefined, limit = 130) =>
      (value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
    const all = Array.from(document.querySelectorAll<HTMLElement>(selector)).slice(0, 250);
    const candidates = all.flatMap((el, index) => {
      if (!el.getClientRects().length || el.closest("[hidden], [inert]")) return [];
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") return [];
      const input = el as HTMLInputElement;
      const explicitRole = el.getAttribute("role");
      const role = explicitRole || (
        el.tagName === "BUTTON" || (el.tagName === "INPUT" && ["submit", "button"].includes(input.type)) ? "button" :
        el.tagName === "A" ? "link" :
        el.tagName === "INPUT" && input.type === "checkbox" ? "checkbox" :
        el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? "textbox" :
        /^H[1-6]$/.test(el.tagName) ? "heading" :
        el.tagName === "LI" ? "listitem" : ""
      );
      const labelledBy = (el.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
      const label = input.labels?.[0]?.textContent;
      const ownText = trim(el.innerText || el.textContent);
      const name = trim(el.getAttribute("aria-label") || labelledBy || label ||
        el.getAttribute("placeholder") || el.getAttribute("title") ||
        (el.tagName === "INPUT" ? input.value && ["submit", "button"].includes(input.type) ? input.value : "" : ownText));
      // Prefer immediate grouping over the whole form/page; imperfect forms often
      // have a sibling span/label next to an unlabeled input.
      const nearby = trim((el.parentElement as HTMLElement | null)?.innerText, 180);
      return [{
        index, tag: el.tagName.toLowerCase(), role, name, text: ownText,
        nearby, testId: trim(el.getAttribute("data-testid"), 100),
        id: trim(el.id, 100),
      }];
    });
    return { selector, candidates };
  }, operation);
}

/**
 * Diagnose a failed *explicit* click or fill locator against the live DOM.
 * Only offer role/name pairs that Playwright confirms uniquely identify
 * a visible element. A user must select; this does NOT click or fill.
 * Potentially sensitive input values and arbitrary page text are excluded.
 */
export async function findLocatorAlternatives(
  page: Page,
  attempted: ExplicitTarget,
  operation: "click" | "fill",
): Promise<MissingLocatorChoices> {
  const requested = attempted.by === "role" ? attempted.name ?? "" : attempted.value;
  const terms = keywords(requested);
  const { candidates } = await inspectCandidates(page, operation);
  const allowed = operation === "fill" ? new Set(["textbox"]) :
    new Set(["button", "checkbox"]);
  const ranked = candidates.flatMap((candidate) => {
    if (!allowed.has(candidate.role) || !candidate.name) return [];
    const score = terms.length ? candidateScore(candidate, terms) : 0;
    if (score === null) return [];
    return [{ candidate, score }];
  }).sort((a, b) => b.score - a.score);
  const matches: AmbiguousCandidate[] = [];
  // Only expose a small, bounded, verified candidate set to the reviewer.
  for (const { candidate } of ranked.slice(0, 24)) {
    const role = candidate.role as "button" | "checkbox" | "textbox";
    const locator = page.getByRole(role, { name: candidate.name, exact: true });
    if (await locator.count() !== 1 || !await locator.isVisible()) continue;
    if (matches.some((x) => x.role === role && x.name === candidate.name)) continue;
    matches.push({
      tag: candidate.tag, role, name: candidate.name, nearby: candidate.nearby,
    });
  }
  return {
    attempted,
    candidates: matches.slice(0, 12),
    // A full list is required for one-click repair; do not hide plausible choices.
    total: matches.length + (ranked.length > 24 ? ranked.length - 24 : 0),
  };
}

/**
 * Search the page's actual visible text, rather than just an allowlist of
 * semantic elements. Product names frequently live in plain <div>s, and
 * an assertion can point to the WRONG existing element (not only a missing
 * one). We propose exact visible text matches, never rewrite expectations.
 *
 * Do not read input values, hidden DOM, script/style content or arbitrary
 * text dumps. A candidate must be visible and uniquely addressable by
 * Playwright before it reaches the review UI.
 */
export async function findAssertionAlternatives(
  page: Page,
  attempted: ExplicitTarget | IntentTarget,
  operation: "assert-text" | "assert-visible",
  expected?: string,
  searchExpectedText = false,
): Promise<MissingAssertionChoices> {
  const query = searchExpectedText && operation === "assert-text" ? expected ?? "" :
    attempted.by === "role" ? attempted.name || (operation === "assert-text" ? expected ?? "" : "") :
    attempted.value;
  const norm = (value: string) => value.replace(/\s+/g, " ").trim();
  const request = norm(query);
  if (!request) return { attempted, query: "", candidates: [], total: 0 };

  const domMatches = await page.evaluate((requested) => {
    const normalized = (v: string) => v.replace(/\s+/g, " ").trim();
    const clip = (v: string, limit: number) => normalized(v).slice(0, limit);
    const result: Array<{
      tag: string; role: string; name: string; text: string; nearby: string;
    }> = [];
    // Collect leaf-most visible elements whose own rendered content is the
    // requested text. Ancestor wrappers with the same content are excluded.
    const nodes = document.querySelectorAll<HTMLElement>("body *");
    for (const el of Array.from(nodes).slice(0, 12_000)) {
      if (el.closest('[hidden],[inert],[aria-hidden="true"],script,style,noscript,template,svg,input,textarea,[contenteditable="true"]')) continue;
      if (!el.getClientRects().length) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility !== "visible") continue;
      const displayed = normalized(el.innerText || "");
      if (displayed !== requested) continue;
      const hasExactChild = Array.from(el.children).some((child) =>
        normalized((child as HTMLElement).innerText || "") === requested &&
        !!(child as HTMLElement).getClientRects().length,
      );
      if (hasExactChild) continue;
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role") ||
        (/^h[1-6]$/.test(tag) ? "heading" :
         tag === "li" ? "listitem" :
         tag === "button" ? "button" : "");
      const name = clip(el.getAttribute("aria-label") || el.innerText || "", 130);
      result.push({
        tag, role, name, text: clip(el.innerText || "", 130),
        nearby: clip((el.parentElement as HTMLElement | null)?.innerText || "", 180),
      });
      if (result.length > 60) break;
    }
    return result;
  }, request);

  const proposed: AssertionCandidate[] = [];
  for (const candidate of domMatches) {
    let target: ExplicitTarget | undefined;
    const role = candidate.role;
    if (role === "button" || role === "textbox" || role === "checkbox" ||
        role === "heading" || role === "status" || role === "listitem") {
      const locator = page.getByRole(role, { name: candidate.name, exact: true });
      if (candidate.name && await locator.count() === 1 && await locator.isVisible() &&
          norm((await locator.innerText()) || "") === request) {
        target = { by: "role", role, name: candidate.name };
      }
    }
    if (!target) {
      const locator = page.getByText(candidate.text, { exact: true });
      if (await locator.count() === 1 && await locator.isVisible() &&
          norm((await locator.innerText()) || "") === request) {
        target = { by: "text", value: candidate.text };
      }
    }
    if (!target || proposed.some((c) => JSON.stringify(c.target) === JSON.stringify(target))) continue;
    proposed.push({ tag: candidate.tag, role: candidate.role,
      name: candidate.name, nearby: candidate.nearby, target });
  }
  return {
    attempted, query: request,
    candidates: proposed.slice(0, 12),
    total: proposed.length + (domMatches.length > 60 ? 1 : 0),
  };
}

function cssAttribute(value: string): string {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/**
 * Resolve an intent against CURRENT DOM evidence. No model call is needed for
 * uniquely supported matches. If 0 or >1 equally plausible candidates remain,
 * return a diagnostic rather than clicking/filling an arbitrary element.
 */
export async function discoverTarget(
  page: Page,
  target: IntentTarget,
  operation: TargetOperation,
  timeoutMs: number,
): Promise<{ locator: Locator; evidence: DiscoveryEvidence }> {
  const request = keywords(target.value);
  if (!request.length && !target.role) {
    throw new Error("Intent needs a meaningful description or an explicit role");
  }
  const deadline = Date.now() + timeoutMs;
  let detail = "No matching visible elements";
  while (true) {
    const { selector, candidates } = await inspectCandidates(page, operation);
    const considered = candidates.filter((c) => !target.role || c.role === target.role);
    const ranked = considered.flatMap((candidate) => {
      const score = candidateScore(candidate, request);
      return score === null ? [] : [{ candidate, score }];
    }).sort((a, b) => b.score - a.score);
    if (ranked.length) {
      const bestScore = ranked[0].score;
      const top = ranked.filter((entry) => entry.score === bestScore);
      if (top.length !== 1) {
        throw new AmbiguousIntentError({
          intent: target.value, role: target.role, total: top.length,
          candidates: top.slice(0, 20).map(({ candidate }) => ({
            tag: candidate.tag, role: candidate.role,
            name: candidate.name, nearby: candidate.nearby,
          })),
        });
      }
      const match = top[0].candidate;
      // Stable attributes preferred; positional fallback is resolved afresh
      // each run, never stored as a brittle cross-run selector.
      const options = [
        ...(match.testId ? [{
          locator: page.getByTestId(match.testId),
          label: "data-testid=" + JSON.stringify(match.testId),
        }] : []),
        ...(match.id ? [{
          locator: page.locator("[id=" + cssAttribute(match.id) + "]"),
          label: "id=" + JSON.stringify(match.id),
        }] : []),
        {
          locator: page.locator(selector).nth(match.index),
          label: "current-DOM " + match.tag + " index=" + match.index,
        },
      ];
      for (const option of options) {
        if (await option.locator.count() === 1 && await option.locator.isVisible()) {
          return {
            locator: option.locator,
            evidence: {
              intent: target.value, method: "live-dom",
              tag: match.tag, role: match.role, name: match.name,
              nearby: match.nearby, locator: option.label,
              candidatesInspected: candidates.length,
            },
          };
        }
      }
      detail = "Matching element was no longer visible";
    } else {
      detail = "No visible " + (target.role ?? operation) + " element matched " +
        JSON.stringify(target.value) + ". Candidates: " +
        considered.slice(0, 5).map((c) => c.name || c.nearby || "<" + c.tag + ">").join("; ");
    }
    if (Date.now() >= deadline) throw new Error("Could not resolve intent: " + detail);
    await page.waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now())));
  }
}
