import type { Locator, Page } from "playwright";

/** A human intention is not an AI-invented CSS selector. */
export interface IntentTarget {
  by: "intent";
  value: string;
  role?: "button" | "textbox" | "checkbox" | "radio" | "combobox" | "heading" | "status" | "listitem";
  /** Only explicitly opted-in inferred roles may recover across compatible controls. */
  rolePolicy?: "hint" | "strict";
}
export type TargetOperation = "click" | "fill" | "select-option" | "check" | "press" | "assert-text" | "assert-visible";

interface DomCandidate {
  index: number;
  tag: string;
  role: string;
  name: string;
  text: string;
  nearby: string;
  localCheckboxCount: number;
  testId: string;
  id: string;
}
/** Page-derived alternatives offered for explicit human selection only. */
export interface AmbiguousCandidate {
  tag: string;
  role: string;
  name: string;
  nearby: string;
  /** Zero-based DOM order among identical accessible role/name matches. */
  nth?: number;
  /** Total verified matches for that role/name at the failure point. */
  matchCount?: number;
}
export interface AmbiguousResolution {
  intent: string;
  role?: IntentTarget["role"];
  candidates: AmbiguousCandidate[];
  total: number;
}

/** Original failed locator plus candidates discovered at the failure point. */
export type ExplicitTarget =
  | { by: "role"; role: NonNullable<IntentTarget["role"]>; name?: string; nth?: number }
  | { by: "label" | "placeholder" | "text" | "testid" | "id" | "css" | "xpath"; value: string };
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
  /** Present when the tester changed the DOM search term in the UI. */
  searched?: boolean;
  searchToken?: string;
}

/** Transient, pre-verified DOM evidence retained only in local run memory. */
export interface AssertionSearchEntry extends AssertionCandidate {
  text: string;
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
  requestedRole?: string;
  roleRecovery?: "exact-compatible-role";
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
      click: "button, a[href], input[type=submit], input[type=button], input[type=checkbox], input[type=radio], [role=button], [role=link], [role=checkbox], [role=radio]",
      fill: "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]), textarea, [contenteditable=true], [role=textbox]",
      press: "input:not([type=hidden]), textarea, select, button, a[href], [contenteditable=true], [role=textbox]",
      "select-option": "select, [role=combobox]",
      check: "input[type=checkbox], input[type=radio], [role=checkbox], [role=radio]",
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
        el.tagName === "INPUT" && input.type === "radio" ? "radio" :
        el.tagName === "SELECT" ? "combobox" :
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
        localCheckboxCount: el.parentElement?.querySelectorAll('input[type="checkbox"],[role="checkbox"]').length ?? 0,
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
  // A strict-mode violation can come from multiple *identically named*
  // role matches (Google's two "Google Search" submit buttons, for example).
  // A generic alternative search would discard both as non-unique. Instead,
  // preserve their verified Playwright order for explicit human selection.
  // Never automatically click the first match: positions are fragile.
  if (operation === "click" && attempted.by === "role" &&
      (attempted.role === "button" || attempted.role === "checkbox") &&
      attempted.name?.trim() && attempted.nth === undefined) {
    const exact = page.getByRole(attempted.role,
      { name: attempted.name, exact: true });
    const count = await exact.count();
    if (count > 1) {
      const options: AmbiguousCandidate[] = [];
      if (count <= 12) {
        for (let nth = 0; nth < count; nth++) {
          const item = exact.nth(nth);
          if (!await item.isVisible()) continue;
          const context = await item.evaluate((element) => {
            const clip = (text: string | null | undefined) =>
              (text ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
            return {
              tag: element.tagName.toLowerCase(),
              nearby: clip(element.parentElement?.textContent),
            };
          });
          options.push({
            tag: context.tag, role: attempted.role, name: attempted.name,
            nearby: context.nearby, nth, matchCount: count,
          });
        }
      }
      // An incomplete set cannot be used for positional repair, but it is
      // still reported so the reviewer can manually edit the original step.
      return { attempted, candidates: options, total: count };
    }
  }
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

/**
 * Capture only short, visible, leaf-level rendered text at the instant an
 * assertion fails. The runner closes the browser afterwards, so the UI
 * searches this bounded in-memory snapshot rather than replaying actions.
 * Candidate selectors are checked for uniqueness while the page still lives.
 * Never capture form values, hidden content, scripts, or editable controls.
 */
export async function captureAssertionSearchIndex(page: Page): Promise<AssertionSearchEntry[]> {
  const possible = await page.evaluate(() => {
    const norm = (v: string) => v.replace(/\s+/g, " ").trim();
    const result: Array<{tag: string; role: string; name: string; text: string; nearby: string}> = [];
    const nodes = document.querySelectorAll<HTMLElement>("body *");
    for (const el of Array.from(nodes).slice(0, 12000)) {
      if (result.length >= 350) break;
      if (el.closest('[hidden],[inert],[aria-hidden="true"],script,style,noscript,template,svg,input,textarea,select,option,[contenteditable],[role="textbox"]')) continue;
      if (!el.getClientRects().length) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility !== "visible") continue;
      const text = norm(el.innerText || "");
      if (!text || text.length > 180) continue;
      if (Array.from(el.children).some((child) =>
        norm((child as HTMLElement).innerText || "") === text &&
        !!(child as HTMLElement).getClientRects().length)) continue;
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role") ||
        (/^h[1-6]$/.test(tag) ? "heading" :
         tag === "li" ? "listitem" :
         tag === "button" ? "button" : "");
      result.push({
        tag, role, name: (el.getAttribute("aria-label") || text).slice(0, 180),
        text, nearby: norm((el.parentElement as HTMLElement | null)?.innerText || "").slice(0, 180),
      });
    }
    return result;
  });
  const entries: AssertionSearchEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of possible) {
    let target: ExplicitTarget | undefined;
    if (candidate.role === "button" || candidate.role === "textbox" ||
        candidate.role === "checkbox" || candidate.role === "heading" ||
        candidate.role === "status" || candidate.role === "listitem") {
      const locator = page.getByRole(candidate.role, { name: candidate.name, exact: true });
      if (await locator.count() === 1 && await locator.isVisible() &&
          (await locator.innerText()).replace(/\s+/g, " ").trim() === candidate.text) {
        target = { by: "role", role: candidate.role, name: candidate.name };
      }
    }
    if (!target) {
      const locator = page.getByText(candidate.text, { exact: true });
      if (await locator.count() === 1 && await locator.isVisible() &&
          (await locator.innerText()).replace(/\s+/g, " ").trim() === candidate.text) {
        target = { by: "text", value: candidate.text };
      }
    }
    if (!target) continue;
    const key = JSON.stringify(target);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ ...candidate, target });
  }
  return entries;
}

/** Search already-verified page evidence by editable text, not model guesses. */
export function searchCapturedAssertionText(
  entries: AssertionSearchEntry[],
  attempted: ExplicitTarget | IntentTarget,
  rawQuery: string,
): MissingAssertionChoices {
  const query = rawQuery.replace(/\s+/g, " ").trim();
  const requested = query.toLocaleLowerCase();
  const matches = entries.filter((entry) =>
    entry.text.toLocaleLowerCase().includes(requested) ||
    entry.name.toLocaleLowerCase().includes(requested),
  ).sort((a, b) => {
    const score = (entry: AssertionSearchEntry) =>
      entry.text.toLocaleLowerCase() === requested ? 3 :
      entry.text.toLocaleLowerCase().startsWith(requested) ? 2 : 1;
    return score(b) - score(a);
  });
  return {
    attempted, query, searched: true,
    candidates: matches.slice(0, 12).map(({tag, role, name, nearby, target}) =>
      ({tag, role, name, nearby, target})),
    total: matches.length,
  };
}


/**
 * Shopping instructions name both an object and an action. Never treat
 * "Add Sauce Labs Backpack" as the accessible name of an Add to cart button.
 * Resolve the product TITLE first, then look for a single button in its
 * closest logical container. This is bounded, live-DOM-only, and fail-closed.
 */
function cartProductPhrase(value: string): { product: string; explicitCart: boolean } | null {
  const input = value.replace(/\s+/g, " ").trim();
  const match = /^(?:add|put)\s+(.+)$/i.exec(input);
  if (!match) return null;
  const explicitCart = /\s+(?:to|in|into)\s+(?:(?:my|the)\s+)?(?:cart|basket)$/i.test(match[1]);
  const product = match[1]
    .replace(/\s+(?:to|in|into)\s+(?:(?:my|the)\s+)?(?:cart|basket)$/i, "")
    .replace(/^(?:the|a)\s+/i, "").trim();
  if (!product || /^(?:to|in|into)\s+(?:(?:my|the)\s+)?(?:cart|basket)$/i.test(product))
    return null;
  return { product, explicitCart };
}

async function productTitles(page: Page, product: string): Promise<string[]> {
  return page.evaluate((raw) => {
    const clean = (value: string) => value.replace(/\s+/g, " ").trim();
    const query = clean(raw).toLocaleLowerCase();
    const found: string[] = [];
    // Titles may be <div>, <span> or headings, not necessarily semantic headings.
    // Reject ancestor text that merely contains an entire product list.
    for (const node of Array.from(document.querySelectorAll<HTMLElement>("body *")).slice(0, 12000)) {
      if (node.closest('script,style,noscript,template,[hidden],[inert],[aria-hidden="true"],input,textarea,select,[contenteditable="true"]')) continue;
      if (!node.getClientRects().length || getComputedStyle(node).visibility !== "visible") continue;
      const value = clean(node.innerText || "");
      if (value.length < 3 || value.length > 120 || value.split(" ").length > 10) continue;
      const lowered = value.toLocaleLowerCase();
      if (lowered !== query && !lowered.endsWith(" " + query)) continue;
      // An interactive title can identify an item, but do not mistake
      // an action caption such as "Remove Example Backpack" for its title.
      // For interactive content require the exact visible item name.
      if (node.closest('button,[role="button"],a[href],[role="link"]') && lowered !== query) continue;
      // Prefer the exact, leaf-most visible name rather than wrappers.
      if (Array.from(node.children).some((child) =>
        clean((child as HTMLElement).innerText || "").toLocaleLowerCase() === lowered &&
        !!(child as HTMLElement).getClientRects().length)) continue;
      found.push(value);
      if (found.length > 20) break;
    }
    return found;
  }, product);
}

async function resolveCartAction(
  page: Page,
  target: IntentTarget,
): Promise<{
  claimed: boolean;
  detail?: string;
  resolved?: { locator: Locator; evidence: DiscoveryEvidence };
}> {
  const parsed = cartProductPhrase(target.value);
  if (!parsed || (target.role && target.role !== "button")) return { claimed: false };
  const actions = page.getByRole("button", { name: /^add to (?:cart|basket)$/i });
  const buttonCount = await actions.count();
  if (!buttonCount && !parsed.explicitCart) return { claimed: false };
  const names = await productTitles(page, parsed.product);
  if (!parsed.explicitCart && names.length === 0) return { claimed: false };
  if (names.length !== 1) {
    return { claimed: true, detail: names.length
      ? "Product " + JSON.stringify(parsed.product) + " matched multiple visible titles; no action was taken"
      : "Product " + JSON.stringify(parsed.product) + " was not found as a unique visible title" };
  }
  const title = page.getByText(names[0], { exact: true });
  if (await title.count() !== 1 || !await title.isVisible()) {
    return { claimed: true, detail: "Product " + JSON.stringify(names[0]) +
      " did not have a unique, visible title locator" };
  }
  let container = title;
  for (let depth = 0; depth < 8; depth++) {
    container = container.locator("..");
    // Never escape a recognised product card into its product list or page.
    // A sold-out card can lack Add to cart while a neighbouring card has one.
    const boundary = await container.evaluate((node) =>
      node.matches('main,body,html,[role="main"],[role="list"],[role="feed"]'));
    if (boundary) break;
    const scoped = container.getByRole("button", { name: /^add to (?:cart|basket)$/i });
    const count = await scoped.count();
    // One button inside the nearest matching container is meaningful evidence.
    if (count === 1 && await scoped.isVisible() && await scoped.isEnabled()) {
      const name = await scoped.innerText();
      const nearby = await scoped.evaluate((element) =>
        (element.parentElement?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 180));
      return {
        claimed: true,
        resolved: {
          locator: scoped,
          evidence: {
            intent: target.value, method: "live-dom",
            tag: "button", role: "button", name: name.trim(), nearby,
            locator: "product " + JSON.stringify(names[0]) +
              " → closest card's unique Add to cart button",
            candidatesInspected: buttonCount,
          },
        },
      };
    }
    if (count > 1) break; // Reached an enclosing multi-product list: never choose first.
    if (await container.evaluate((node) =>
      node.matches('article,li,[role="listitem"],.inventory_item,.product-card,.product_item,[data-testid="product-card"],[data-testid="product-item"]'))) break;
  }
  return { claimed: true, detail: "No unique enabled Add to cart button within product " +
    JSON.stringify(names[0]) + "; no action was taken" };
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
    if (operation === "click") {
      const scoped = await resolveCartAction(page, target);
      if (scoped.claimed) {
        if (scoped.resolved) return scoped.resolved;
        detail = scoped.detail ?? "Product-scoped cart action could not be verified";
        if (Date.now() >= deadline) throw new Error("Could not resolve intent: " + detail);
        await page.waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now())));
        continue;
      }
    }
    const { selector, candidates } = await inspectCandidates(page, operation);
    // Only an opted-in button hint may recover to a link, and only with an
    // exact accessible name and no competing exact action. Never relax
    // checkbox, input, or explicit role constraints.
    if (operation === "click" && target.role === "button" && target.rolePolicy === "hint") {
      const exactName = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
      const name = exactName(target.value);
      const exact = candidates.filter(c => exactName(c.name) === name);
      if (exact.length === 1 && exact[0].role === "link") {
        const link = page.getByRole("link", { name: exact[0].name, exact: true });
        if (await link.count() === 1 && await link.isVisible() && await link.isEnabled()) {
          return { locator: link, evidence: {
            intent: target.value, method: "live-dom", tag: exact[0].tag,
            role: "link", name: exact[0].name, nearby: exact[0].nearby,
            locator: "exact accessible link name " + JSON.stringify(exact[0].name),
            candidatesInspected: candidates.length, requestedRole: "button",
            roleRecovery: "exact-compatible-role",
          }};
        }
      }
    }
    const considered = candidates.filter((c) => !target.role || c.role === target.role);
    const ranked = considered.flatMap((candidate) => {
      // A named checkbox may borrow context from its own row, but a global
      // control must not inherit the names of items it operates on collectively.
      if ((operation === "click" || operation === "check") && candidate.role === "checkbox" &&
          /\b(?:all|every)\b/i.test(candidate.name) &&
          !/\b(?:all|every)\b/i.test(target.value)) return [];
      // An exact visible action with a different role is evidence of a role
      // mismatch, not permission to execute a partially matching action.
      // Keep explicit roles authoritative and fail closed instead.
      if (operation === "click" && target.role && request.length &&
          candidates.some(other => other.role !== target.role &&
            keywords(other.name).length === request.length &&
            request.every(word => keywords(other.name).includes(word))) &&
          !(keywords(candidate.name).length === request.length &&
            request.every(word => keywords(candidate.name).includes(word)))) return [];
      // A generic item toggle may have an accessible name without the
      // item's title. Require an exact local item phrase and a single
      // checkbox in that immediate group; never borrow page-wide text.
      let score = candidateScore(candidate, request);
      if (score === null && (operation === "click" || operation === "check") &&
          candidate.role === "checkbox" &&
          (!candidate.name || /^(?:toggle|complete|mark)(?: (?:todo|task|item))?$/i.test(candidate.name)) &&
          request[0] === "complete" && request.length > 1 &&
          candidate.localCheckboxCount === 1) {
        const itemWords = request.slice(1);
        const nearbyWords = keywords(candidate.nearby);
        if (nearbyWords.join(" ") === itemWords.join(" ")) score = itemWords.length * 4;
      }
      return score === null ? [] : [{ candidate, score }];
    }).sort((a, b) => b.score - a.score);
    if (ranked.length) {
      const bestScore = ranked[0].score;
      const top = ranked.filter((entry) => entry.score === bestScore);
      if (top.length !== 1) {
        const options: AmbiguousCandidate[] = [];
        for (const { candidate } of top.slice(0, 20)) {
          const option: AmbiguousCandidate = {
            tag: candidate.tag, role: candidate.role,
            name: candidate.name, nearby: candidate.nearby,
          };
          // Only offer a positional correction if Playwright's EXACT role/name
          // results match the inspected live DOM elements in order. A user
          // must explicitly choose this fragile but sometimes necessary index.
          const roles = ["button", "checkbox", "radio", "textbox", "combobox",
            "heading", "status", "listitem"] as const;
          if (candidate.name && roles.some((role) => role === candidate.role)) {
            const same = candidates.filter((other) =>
              other.role === candidate.role && other.name === candidate.name);
            if (same.length > 1) {
              const nth = same.findIndex((entry) => entry.index === candidate.index);
              const locator = page.getByRole(candidate.role as typeof roles[number],
                { name: candidate.name, exact: true });
              if (nth >= 0 && await locator.count() === same.length) {
                const inspected = await page.locator(selector)
                  .nth(candidate.index).elementHandle();
                const matched = await locator.nth(nth).elementHandle();
                if (inspected && matched &&
                    await inspected.evaluate((element, expected) =>
                      element === expected, matched)) {
                  option.nth = nth;
                  option.matchCount = same.length;
                }
              }
            }
          }
          options.push(option);
        }
        throw new AmbiguousIntentError({
          intent: target.value, role: target.role, total: top.length,
          candidates: options,
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
