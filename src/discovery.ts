import type { Locator, Page } from "playwright";

/** A human intention is not an AI-invented CSS selector. */
export interface IntentTarget {
  by: "intent";
  value: string;
  role?: "button" | "textbox" | "checkbox" | "radio" | "combobox" | "heading" | "status" | "listitem";
  /** Legacy compatibility field; all declared roles are now strict. */
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
  testId: string;
  id: string;
  href?: string;
  attributeId?: string;
  attributeTestId?: string;
  repairContext?: string;
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
  /** Explicit DOM-verified fallback, for human-reviewed repairs only. */
  target?: ExplicitTarget;
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
  /** Full verified rendered text, not diagnostic output or accessible name. */
  text?: string;
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
async function inspectCandidates(page: Page, operation: TargetOperation, repairOnly = false): Promise<{
  selector: string; candidates: DomCandidate[];
}> {
  return page.evaluate(({op, repairOnly}) => {
    const selectorByOperation = {
      click: "button, a[href], input[type=submit], input[type=button], input[type=checkbox], input[type=radio], [role=button], [role=link], [role=checkbox], [role=radio]",
      fill: "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]), textarea, [contenteditable=true], [role=textbox]",
      press: "input:not([type=hidden]), textarea, select, button, a[href], [contenteditable=true], [role=textbox]",
      "select-option": "select, [role=combobox]",
      check: "input[type=checkbox], input[type=radio], [role=checkbox], [role=radio]",
      "assert-text": "[role=status], [role=alert], li, p, span, label, h1, h2, h3, td, strong, button, [data-testid]",
      "assert-visible": "[role=status], [role=alert], li, p, span, label, h1, h2, h3, td, strong, button, a[href], input, [data-testid]",
    } as const;
    // Nonsemantic controls are considered only for human-reviewed click repairs.
    // Inline handlers or a local pointer cursor combined with a description
    // provide evidence for suggestions, never proof of interactive behaviour.
    const selector = selectorByOperation[op] + (repairOnly && op === "click"
      ? ", span[onclick], div[onclick], i[onclick], svg[onclick], span[title], div[title], i[title], svg[title], span[aria-label], div[aria-label], i[aria-label], svg[aria-label]" : "");
    const trim = (value: string | null | undefined, limit = 130) =>
      (value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
    const all = Array.from(document.querySelectorAll<HTMLElement>(selector)).slice(0, 250);
    const candidates = all.flatMap((el, index) => {
      if (!el.getClientRects().length || el.closest('[hidden], [inert], [aria-hidden="true" i]')) return [];
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") return [];
      const input = el as HTMLInputElement;
      const explicitRole = el.getAttribute("role");
      // A pointer cursor alone, a title alone or a focusable decorative
      // element is insufficient. Require an identifying description and
      // a locally introduced pointer cursor for nonsemantic suggestions.
      const locallyPointing = style.cursor === "pointer" &&
        (!!el.parentElement && getComputedStyle(el.parentElement).cursor !== "pointer");
      const described = !!(el.getAttribute("title")?.trim() || el.getAttribute("aria-label")?.trim());
      const plausibleControl = repairOnly && op === "click" &&
        (el.hasAttribute("onclick") || (locallyPointing && described));
      const role = explicitRole || (
        el.tagName === "BUTTON" || (el.tagName === "INPUT" && ["submit", "button"].includes(input.type)) ? "button" :
        el.tagName === "A" ? "link" :
        el.tagName === "INPUT" && input.type === "checkbox" ? "checkbox" :
        el.tagName === "INPUT" && input.type === "radio" ? "radio" :
        el.tagName === "SELECT" ? "combobox" :
        el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? "textbox" :
        /^H[1-6]$/.test(el.tagName) ? "heading" :
        el.tagName === "LI" ? "listitem" :
        plausibleControl ? "clickable" : ""
      );
      const labelledBy = (el.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
      const label = input.labels?.[0]?.textContent;
      const ownText = trim(el.innerText || el.textContent);
      // Execution must compare the complete name, not the bounded diagnostic text.
      const name = (el.getAttribute("aria-label") || labelledBy || label ||
        el.getAttribute("placeholder") || el.getAttribute("title") ||
        (el.tagName === "INPUT" ? input.value && ["submit", "button"].includes(input.type) ? input.value : "" : el.innerText || el.textContent) || "")
        .replace(/\s+/g, " ").trim();
      // Prefer immediate grouping over the whole form/page; imperfect forms often
      // have a sibling span/label next to an unlabeled input.
      const nearby = trim((el.parentElement as HTMLElement | null)?.innerText, 180);
      let repairContext: string | undefined;
      if (repairOnly && op === "click") {
        if (el.closest('[aria-disabled="true"],[aria-hidden="true"],[disabled]')) return [];
        // Only visible rendered text, never input values or hidden descendants.
        const visibleText = (root: Element): string => {
          const parts: string[] = [];
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          let visited = 0, length = 0;
          while (walker.nextNode() && visited++ < 250 && length < 600) {
            const node = walker.currentNode;
            const parent = node.parentElement;
            if (!parent || parent.closest('script,style,noscript,template,svg,[hidden],[inert],[aria-hidden="true"],input,textarea,select,[contenteditable]:not([contenteditable="false"])')) continue;
            if (getComputedStyle(parent).visibility !== "visible" || !parent.getClientRects().length) continue;
            const text = (node.textContent ?? "").trim();
            if (text) { parts.push(text); length += text.length; }
          }
          return trim(parts.join(" "),180);
        };
        // Stop before shared page regions or a container with competing
        // same-action controls. Generic nested divs need no special classes.
        // Treat native and nonsemantic controls alike, but ignore descendants
        // of the current control and decorative matches.
        const competing = (other: Element) => {
          if (other === el || el.contains(other) || other.contains(el) ||
              other.closest('[hidden],[inert],[aria-hidden="true"]') ||
              !other.getClientRects().length || getComputedStyle(other).visibility !== "visible") return false;
          const tag = other.tagName.toLowerCase();
          const otherRole = other.getAttribute("role");
          const native = ["button","a","input"].includes(tag) ||
            ["button","link","checkbox","radio"].includes(otherRole ?? "");
          const descriptive = !!(other.getAttribute("title")?.trim() || other.getAttribute("aria-label")?.trim());
          const pointer = getComputedStyle(other).cursor === "pointer" &&
            !!other.parentElement && getComputedStyle(other.parentElement).cursor !== "pointer";
          if (!native && !other.hasAttribute("onclick") && !(descriptive && pointer)) return false;
          // Any competing control is a conservative boundary unless the
          // ancestor itself is a semantic record (handled below).
          return true;
        };
        repairContext = visibleText(el);
        let ancestor = el.parentElement;
        for (let depth = 0; ancestor && depth < 6; depth++, ancestor = ancestor.parentElement) {
          if (ancestor.matches('html,body,main,[role="main"],table,tbody,thead,tfoot,ul,ol,nav,[role="navigation"],[role="list"],[role="feed"]')) break;
          const record = ancestor.matches('tr,[role="row"],li,[role="listitem"],article,[role="group"]');
          if (!record && Array.from(ancestor.querySelectorAll(selector)).some(competing)) break;
          const context = visibleText(ancestor);
          if (context) repairContext = context;
          if (record) break;
        }
      }
      return [{
        index, tag: el.tagName.toLowerCase(), role, name, text: ownText,
        nearby, testId: el.getAttribute("data-testid") ?? "",
        id: el.id,
        href: el.tagName === "A" ? el.getAttribute("href") ?? undefined : undefined,
        attributeId: el.id || undefined,
        attributeTestId: el.getAttribute("data-testid") ?? undefined,
        repairContext,
      }];
    });
    return { selector, candidates };
  }, {op: operation, repairOnly});
}

/**
 * Diagnose a failed *explicit* click, fill or keyboard locator against the live DOM.
 * Only offer role/name pairs that Playwright confirms uniquely identify
 * a visible element. A user must select; this does NOT click or fill.
 * Potentially sensitive input values and arbitrary page text are excluded.
 */
export async function findLocatorAlternatives(
  page: Page,
  attempted: ExplicitTarget,
  operation: "click" | "fill" | "press",
  instruction?: string,
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
        // Collect context for the exact Playwright match set in one DOM
        // snapshot. Never cross into a container holding a competing match.
        const contexts = await exact.evaluateAll(elements => elements.map(element => {
          const clip = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 180);
          const visibleText = (root: Element): string => {
            const parts: string[] = [];
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let visited = 0;
            let length = 0;
            while (walker.nextNode() && visited++ < 250 && length < 600) {
              const node = walker.currentNode;
              const parent = node.parentElement;
              if (!parent || parent.closest('script,style,noscript,template,[hidden],[inert],[aria-hidden="true"],input,textarea,select,[contenteditable]:not([contenteditable="false"])')) continue;
              const style = getComputedStyle(parent);
              if (style.visibility !== "visible" || !parent.getClientRects().length) continue;
              const text = (node.textContent ?? "").trim();
              if (text) {
                parts.push(text);
                length += text.length;
              }
            }
            return clip(parts.join(" "));
          };
          let nearby = visibleText(element);
          let ancestor = element.parentElement;
          for (let depth = 0; ancestor && depth < 6; depth++, ancestor = ancestor.parentElement) {
            if (ancestor.matches('html,body,main,[role="main"],[role="list"],[role="feed"],table,tbody,thead,tfoot,ul,ol,nav,[role="navigation"]') ||
                elements.some(other => other !== element && ancestor!.contains(other))) break;
            const text = visibleText(ancestor);
            if (text) nearby = text;
            // Semantic item boundaries are strong evidence of local grouping.
            if (ancestor.matches('article,li,tr,[role="row"],[role="listitem"],[role="group"]')) break;
          }
          return {tag: element.tagName.toLowerCase(), nearby};
        }));
        // If the match set changed during collection, avoid positional advice.
        if (contexts.length !== count || await exact.count() !== count) {
          return { attempted, candidates: [], total: await exact.count() };
        }
        for (let nth = 0; nth < count; nth++) {
          const item = exact.nth(nth);
          if (!await item.isVisible()) continue;
          const context = contexts[nth];
          options.push({
            tag: context.tag, role: attempted.role, name: attempted.name,
            nearby: context.nearby, nth, matchCount: count,
          });
        }
      }
      // An incomplete set cannot be used for positional repair, but it is
      // still reported so the reviewer can manually edit the original step.
      // Advisory only: promote a single full contextual match. Partial
      // matches and ties are deliberately not ranked; keep original nth.
      if (instruction && options.length === count) {
        const actionWords = new Set(keywords(attempted.name));
        const contextWords = keywords(instruction).filter(word => !actionWords.has(word));
        if (contextWords.length) {
          const matching = options.filter(candidate => {
            const nearby = new Set(keywords(candidate.nearby));
            return contextWords.every(word => nearby.has(word));
          });
          if (matching.length === 1) {
            const best = matching[0];
            return { attempted, candidates: [best, ...options.filter(candidate => candidate !== best)], total: count };
          }
        }
      }
      return { attempted, candidates: options, total: count };
    }
  }
  const requested = attempted.by === "role" ? attempted.name ?? "" : attempted.value;
  const terms = keywords(requested);
  const instructionTerms = keywords(instruction ?? "");
  const { selector, candidates } = await inspectCandidates(page, operation, true);
  const allowed = operation === "fill" ? new Set(["textbox"]) :
    operation === "press" ? new Set(["textbox", "button", "checkbox", "radio", "link", "combobox"]) :
    new Set(["button", "checkbox", "radio", "link", "clickable"]);
  const ranked = candidates.flatMap((candidate) => {
    if (!allowed.has(candidate.role)) return [];
    // Attribute evidence is advisory, not a change to execution scoring.
    const attributes = new Set(keywords(candidate.id + " " + candidate.testId));
    const primary = candidateScore(candidate, terms);
    if (primary === null && !terms.every(word => attributes.has(word))) return [];
    const score = (primary ?? 0) + terms.filter(word => attributes.has(word)).length * 8 +
      instructionTerms.filter(word => attributes.has(word)).length * 8 +
      (candidate.repairContext ? instructionTerms.filter(word => keywords(candidate.repairContext!).includes(word)).length * 4 : 0);
    return [{ candidate, score }];
  }).sort((a, b) => b.score - a.score);
  const matches: AmbiguousCandidate[] = [];
  for (const { candidate } of ranked.slice(0, 24)) {
    const source = page.locator(selector).nth(candidate.index);
    const role = candidate.role;
    const proposals: Array<{target: ExplicitTarget; locator: Locator}> = [];
    // Keep existing named-role repair behaviour for supported roles.
    if (candidate.name && (role === "button" || role === "checkbox" || role === "textbox" || role === "radio" || (operation === "press" && role === "combobox"))) {
      proposals.push({target:{by:"role",role,name:candidate.name},
        locator:page.getByRole(role,{name:candidate.name,exact:true})});
    }
    const safeAttribute = (value: string | undefined): value is string =>
      !!value && value.length <= 500 && !/[\u0000-\u001f\u007f]/.test(value);
    if (safeAttribute(candidate.attributeId)) {
      proposals.push({target:{by:"id",value:candidate.attributeId},
        locator:page.locator("css=[id="+JSON.stringify(candidate.attributeId)+"]")});
    }
    if (safeAttribute(candidate.attributeTestId)) {
      proposals.push({target:{by:"testid",value:candidate.attributeTestId},
        locator:page.getByTestId(candidate.attributeTestId)});
    }
    // Use only simple relative/hash paths; do not copy query strings,
    // credentials or arbitrary external URLs into diagnostic suggestions.
    if (role === "link" && safeAttribute(candidate.href) && /^(?:#[a-zA-Z0-9_-]+|\/[a-zA-Z0-9_./-]+)$/.test(candidate.href) && !candidate.href.startsWith("//")) {
      const value = 'a[href='+cssAttribute(candidate.href)+']';
      proposals.push({target:{by:"css",value},locator:page.locator("css="+value)});
    }
    for (const {target, locator} of proposals) {
      if (await locator.count() !== 1 || await source.and(locator).count() !== 1 ||
          !await locator.isVisible() || !await locator.isEnabled()) continue;
      if (matches.some(x => x.target ? JSON.stringify(x.target) === JSON.stringify(target) :
          target.by === "role" && x.role === target.role && x.name === target.name)) break;
      matches.push({tag:candidate.tag,role,name:candidate.name,nearby:candidate.repairContext ?? candidate.nearby,
        ...(target.by === "role" && role !== "radio" && role !== "combobox" ? {} : {target})});
      break;
    }
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
    // Collect exact and partial visible text matches, preferring the smallest
    // matching element over wrappers that merely repeat descendant content.
    // Bound the scan and locator text; never use truncated text as a locator.
    const excluded = '[hidden],[inert],[aria-hidden="true"],script,style,noscript,template,svg,input,textarea,select,option,[contenteditable],[role="textbox"]';
    const visible = (node: HTMLElement) => !node.closest(excluded) &&
      !!node.getClientRects().length && getComputedStyle(node).visibility === "visible";
    const contains = (value: string) => value.includes(requested);
    const nodes = document.querySelectorAll<HTMLElement>("body *");
    for (const el of Array.from(nodes).slice(0, 12_000)) {
      if (!visible(el)) continue;
      const displayed = normalized(el.innerText || "");
      if (!contains(displayed) || displayed.length > 180) continue;
      // Do not suggest broad page regions for a partial match. Descendant
      // matches take precedence even when their full text differs.
      if (displayed !== requested && el.matches('main,section,article,nav,header,footer,aside,form,table,ul,ol,[role="main"],[role="region"],[role="navigation"],[role="list"]')) continue;
      const hasMatchingChild = Array.from(el.children).some(child =>
        child instanceof HTMLElement && visible(child) &&
        contains(normalized(child.innerText || "")),
      );
      if (hasMatchingChild) continue;
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role") ||
        (/^h[1-6]$/.test(tag) ? "heading" :
         tag === "li" ? "listitem" :
         tag === "button" ? "button" : "");
      const name = clip(el.getAttribute("aria-label") || el.innerText || "", 130);
      result.push({
        tag, role, name, text: displayed,
        nearby: clip((el.parentElement as HTMLElement | null)?.innerText || "", 180),
      });
    }
    // Exact matches take precedence, including those later in DOM order.
    return result.sort((a,b) => Number(b.text === requested) - Number(a.text === requested)).slice(0,61);
  }, request);

  const proposed: AssertionCandidate[] = [];
  for (const candidate of domMatches) {
    let target: ExplicitTarget | undefined;
    const role = candidate.role;
    if (role === "button" || role === "textbox" || role === "checkbox" ||
        role === "heading" || role === "status" || role === "listitem") {
      const locator = page.getByRole(role, { name: candidate.name, exact: true });
      if (candidate.name && await locator.count() === 1 && await locator.isVisible() &&
          norm((await locator.innerText()) || "") === candidate.text) {
        target = { by: "role", role, name: candidate.name };
      }
    }
    if (!target) {
      const locator = page.getByText(candidate.text, { exact: true });
      if (await locator.count() === 1 && await locator.isVisible() &&
          norm((await locator.innerText()) || "") === candidate.text) {
        target = { by: "text", value: candidate.text };
      }
    }
    if (!target || proposed.some((c) => JSON.stringify(c.target) === JSON.stringify(target))) continue;
    proposed.push({ tag: candidate.tag, role: candidate.role,
      name: candidate.name, nearby: candidate.nearby, text: candidate.text, target });
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
    // Legacy role hints are retained in saved definitions but cannot relax a declared role.
    const considered = candidates.filter((c) => !target.role || c.role === target.role);
    // Execution accepts exact normalized names, never relevance scores or borrowed context.
    // Keep candidateScore for read-only repair suggestions.
    const exactName = (value: string) => value.replace(/\s+/g, " ").trim();
    const top = considered.filter(candidate =>
      exactName(candidate.name) === exactName(target.value)
    ).map(candidate => ({candidate}));
    // Relevance may populate human repair choices, but never an executable match.
    const suggestions = top.length === 0 ? considered.filter(candidate =>
      request.length > 0 && candidateScore(candidate, request) !== null
    ).map(candidate => ({candidate})) : [];
    const ambiguous = top.length > 1 ? top : suggestions.length > 1 ? suggestions : [];
    if (top.length || ambiguous.length) {
      if (ambiguous.length) {
        const options: AmbiguousCandidate[] = [];
        for (const { candidate } of ambiguous.slice(0, 20)) {
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
          intent: target.value, role: target.role, total: ambiguous.length,
          candidates: options,
        });
      }
      const match = top[0].candidate;
      // Re-resolve by exact name at action time, never by DOM index or ID alone.
      // Keep the operation's candidate set and accessibility exclusion as constraints.
      const eligible = page.locator(selector).and(page.locator(':not([hidden], [inert], [aria-hidden="true" i], [hidden] *, [inert] *, [aria-hidden="true" i] *)'));
      const role = match.role as Parameters<Page["getByRole"]>[0];
      const semantic = match.role
        ? page.getByRole(role, { name: target.value, exact: true })
        : page.getByText(target.value, { exact: true });
      const locator = eligible.and(semantic).filter({ visible: true });
      if (await locator.count() === 1 && await locator.isVisible()) {
        return {
          locator,
          evidence: {
            intent: target.value, method: "live-dom",
            tag: match.tag, role: match.role, name: match.name,
            nearby: match.nearby,
            locator: (match.role ? "exact role " + match.role + " name " : "exact text ") + JSON.stringify(target.value),
            candidatesInspected: candidates.length,
          },
        };
      }
      detail = "Matching element was no longer visible";
    } else {
      detail = "No visible " + (target.role ?? operation) + " element matched " +
        JSON.stringify(target.value) + ". Candidates: " +
        considered.slice(0, 5).map((c) => (c.name || c.nearby || "<" + c.tag + ">").slice(0, 130)).join("; ");
    }
    if (Date.now() >= deadline) throw new Error("Could not resolve intent: " + detail);
    await page.waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now())));
  }
}


/** Bounded, read-only element evidence. Never reads form values or raw HTML. */
export interface ElementSearchEntry extends AssertionSearchEntry {
  actions: Array<"click"|"fill"|"check"|"uncheck"|"select-option"|"press"|"assert-visible"|"assert-text">;
}
export async function captureElementSearchIndex(page: Page): Promise<ElementSearchEntry[]> {
  const selector = "body *";
  const candidates = await page.locator(selector).evaluateAll(nodes => {
    const norm = (s: string) => s.replace(/\s+/g," ").trim().slice(0,180);
    const excluded = '[hidden],[inert],[aria-hidden="true"],script,style,noscript,template,svg,option,[contenteditable]';
    const visible = (el: Element) => !el.closest(excluded) && !!el.getClientRects().length &&
      getComputedStyle(el).visibility === "visible" && getComputedStyle(el).display !== "none";
    const safeText = (el: Element) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let value = "", count = 0;
      while(walker.nextNode() && count++ < 150 && value.length < 360) {
        const node = walker.currentNode;
        const parent = node.parentElement;
        if(parent && !parent.closest("input,textarea,select,[contenteditable]") && visible(parent)) value += " " + node.textContent;
      }
      return norm(value);
    };
    const result: Array<{index:number;tag:string;role:string;name:string;text:string;nearby:string;id:string;testid:string;actions:ElementSearchEntry["actions"]}> = [];
    for (let index=0; index<Math.min(nodes.length,12000) && result.length<350; index++) {
      const el=nodes[index] as HTMLElement;
      if(!visible(el)) continue;
      const tag=el.tagName.toLowerCase();
      const inputType=tag==="input"?(el.getAttribute("type")||"text").toLowerCase():"";
      if(inputType==="hidden" || inputType==="password") continue;
      const role=el.getAttribute("role") || (tag==="button" || ["button","submit","reset"].includes(inputType)?"button":
        inputType==="radio"?"radio":inputType==="checkbox"?"checkbox":tag==="select"?"combobox":
        tag==="textarea" || ["text","email","search","tel","url","number"].includes(inputType)?"textbox":
        tag==="a" && el.hasAttribute("href")?"link":/^h[1-6]$/.test(tag)?"heading":tag==="li"?"listitem":"");
      const control=["input","textarea","select","button","a"].includes(tag)||["button","textbox","checkbox","radio","combobox","link"].includes(role);
      const id=(el.id||"").slice(0,180),testid=(el.getAttribute("data-testid")||"").slice(0,180);
      if(!control && !id && !testid && !/^h[1-6]$|^p$|^li$|^span$/.test(tag)) continue;
      const text=tag==="input"||tag==="textarea"||tag==="select"?"":safeText(el);
      const labels = "labels" in el ? Array.from((el as HTMLInputElement).labels || []).map(safeText).join(" ") : "";
      const labelled = (el.getAttribute("aria-labelledby")||"").split(/\s+/).map(id=>document.getElementById(id)).filter((x):x is HTMLElement=>!!x).map(safeText).join(" ");
      const name=norm(el.getAttribute("aria-label")||labelled||labels||text||el.getAttribute("placeholder")||el.getAttribute("title")||"");
      if(!control && !text) continue;
      const record=el.closest("article,li,tr,[role=row],[role=group],[role=listitem]");
      const nearby=record?safeText(record):"";
      const actions:ElementSearchEntry["actions"]=["assert-visible"];
      if(text) actions.push("assert-text");
      if(!el.closest('[disabled],[aria-disabled="true"]')) {
        if(role==="button"||role==="link"||role==="radio"||role==="checkbox") actions.push("click");
        if(tag==="input" && (inputType==="radio"||inputType==="checkbox")) actions.push("check");
        if(tag==="input" && inputType==="checkbox") actions.push("uncheck");
        if(role==="textbox" && ["input","textarea"].includes(tag) && !el.hasAttribute("readonly")) actions.push("fill","press");
        if(tag==="select") actions.push("select-option");
      }
      result.push({index,tag,role,name,text,nearby,id,testid,actions});
    }
    return result;
  });
  const entries: ElementSearchEntry[]=[];
  const seen=new Set<string>();
  const roles=["button","textbox","checkbox","radio","combobox","heading","status","listitem"];
  for(const {index,id,testid,...candidate} of candidates) {
    const source=page.locator(selector).nth(index);
    const options:Array<{target:ExplicitTarget;locator:Locator}>=[];
    if(id) options.push({target:{by:"id",value:id},locator:page.locator("[id="+JSON.stringify(id)+"]")});
    if(testid) options.push({target:{by:"testid",value:testid},locator:page.getByTestId(testid)});
    if(roles.includes(candidate.role) && candidate.name) {
      const role=candidate.role as NonNullable<IntentTarget["role"]>;
      options.push({target:{by:"role",role,name:candidate.name},locator:page.getByRole(role,{name:candidate.name,exact:true})});
    }
    if(candidate.text) options.push({target:{by:"text",value:candidate.text},locator:page.getByText(candidate.text,{exact:true})});
    for(const {target,locator} of options) {
      try {
        if(await locator.count()!==1 || await source.and(locator).count()!==1 || !await locator.isVisible()) continue;
        const key=JSON.stringify(target);
        if(!seen.has(key)) {seen.add(key);entries.push({...candidate,target});}
        break;
      } catch { /* Invalid or stale locator: do not offer it. */ }
    }
  }
  return entries;
}

export function searchCapturedElements(entries: ElementSearchEntry[], rawQuery: string): ElementSearchEntry[] {
  const query=rawQuery.trim().toLocaleLowerCase();
  if(!query) return [];
  const score=(entry:ElementSearchEntry)=>{
    const value=entry.target.by==="role"?entry.target.name||"":entry.target.value;
    const direct=[entry.name,entry.text,value,entry.role,entry.tag].map(v=>v.toLocaleLowerCase());
    if(direct.includes(query)) return 4;
    if(direct.some(v=>v.startsWith(query))) return 3;
    if(direct.some(v=>v.includes(query))) return 2;
    return entry.nearby.toLocaleLowerCase().includes(query)?1:0;
  };
  return entries.filter(entry=>score(entry)>0).sort((a,b)=>score(b)-score(a)).slice(0,30);
}
