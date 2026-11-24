import { chromium, type Browser } from "playwright";
import { installBrowserRequestPolicy } from "./browser-request-policy.js";

/** Bounded, untrusted application context supplied to a test-design model. */
export interface PageSnapshot {
  url: string;
  title: string;
  headings: string[];
  controls: Array<{ kind: string; name: string; type?: string; placeholder?: string }>;
  statusText: string[];
  sampleText: string[];
  /** Initial navigation/inspection evidence; no full DOM or cross-origin URLs. */
  inspection?: {
    mainDocumentStatus: number | null;
    blockedCrossOriginRequests: number;
    allowedCrossOriginRequests: number;
    /** Local diagnostics: request types only, no cross-origin URLs. */
    blockedRequestKinds?: Record<string, number>;
    pageErrors: number;
    /** Local diagnostic only; never pass exception messages to a hosted model. */
    pageErrorSummaries?: string[];
  };
}

export function ensureAllowedNavigation(destination: string, base: URL): URL {
  // For this tool, a bare "/" in a test script means "open the configured
  // application entry", not necessarily the website domain root. This is
  // important for apps hosted at /todomvc/#/, /app/, etc. All other paths,
  // hashes and absolute URLs retain normal URL-resolution semantics.
  const url = destination === "/" ? new URL(base.href) : new URL(destination, base);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username || base.password ||
    !["http:", "https:"].includes(url.protocol) ||
    url.origin !== base.origin ||
    url.username || url.password
  ) {
    throw new Error("URL must remain on the configured HTTP(S) application origin");
  }
  return url;
}

/**
 * Bounded, privacy-filtered first-line error summary. Never expose stacks,
 * resource URLs, tokens or long application-controlled messages.
 */
export function summarizePageError(error: Error): string {
  const type = /^[A-Za-z][A-Za-z0-9]*Error$/.test(error.name) ? error.name : "JavaScript error";
  const safe = (error.message ?? "").split(/\r?\n/, 1)[0]
    .replace(/https?:\/\/[^\s\u0022\u0027<>]+/gi, "[URL redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email redacted]")
    .replace(/\b(password|token|secret|api[_ -]?key|authorization)\s*[:=]\s*(?:\u0022[^\u0022]*\u0022|\u0027[^\u0027]*\u0027|[^\s,;]+)/gi, "$1=[redacted]")
    .replace(/\b[A-Za-z0-9_-]{30,}\b/g, "[opaque value redacted]")
    .replace(/\s+/g, " ").trim().slice(0, 160);
  return safe ? type + ": " + safe : type;
}

export async function inspectApplication(
  baseURL: string,
  suppliedBrowser?: Browser,
): Promise<PageSnapshot> {
  const destination = ensureAllowedNavigation(baseURL, new URL(baseURL));
  const browser = suppliedBrowser ?? (await chromium.launch());
  const context = await browser.newContext({ serviceWorkers: "block" });
  context.setDefaultNavigationTimeout(10_000);
  const resourceCounts = {
    blockedCrossOriginRequests: 0,
    allowedCrossOriginRequests: 0,
    blockedRequestKinds: {} as Record<string, number>,
  };
  let pageErrors = 0;
  const pageErrorSummaries: string[] = [];
  try {
    await installBrowserRequestPolicy(context, destination.origin, resourceCounts);
    const page = await context.newPage();
    page.on("pageerror", (error) => {
      pageErrors++;
      if (pageErrorSummaries.length < 3) {
        pageErrorSummaries.push(summarizePageError(error));
      }
    });
    const mainDocument = await page.goto(destination.href, { waitUntil: "domcontentloaded" });
    const snapshot = await page.evaluate(() => {
      const clip = (value: string | null | undefined) =>
        (value ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
      const unique = (values: string[], max: number) =>
        [...new Set(values.filter(Boolean))].slice(0, max);
      const accessibleName = (element: HTMLElement) => {
        const input = element as HTMLInputElement;
        const label = input.labels?.[0]?.textContent;
        return clip(element.getAttribute("aria-label") || label ||
          element.getAttribute("placeholder") || element.textContent);
      };
      const controls = Array.from(document.querySelectorAll(
        "button,input,textarea,select,[role=button],[role=checkbox]",
      )).slice(0, 60).map((element) => {
        const node = element as HTMLElement;
        const type = node.getAttribute("type") ?? undefined;
        const placeholder = clip(node.getAttribute("placeholder"));
        const kind = node.getAttribute("role") ||
          (node.tagName === "INPUT"
            ? (type === "checkbox" || type === "radio" ? type : "textbox")
            : node.tagName.toLowerCase());
        return {
          kind, name: accessibleName(node),
          ...(type ? { type } : {}),
          ...(placeholder ? { placeholder } : {}),
        };
      });
      return {
        url: location.href,
        title: clip(document.title),
        headings: unique(Array.from(document.querySelectorAll("h1,h2,h3"))
          .map((node) => clip(node.textContent)), 20),
        controls,
        statusText: unique(Array.from(document.querySelectorAll("[role=status],[role=alert]"))
          .map((node) => clip(node.textContent)), 20),
        sampleText: unique(Array.from(document.querySelectorAll("main p,main li,form label"))
          .map((node) => clip(node.textContent)), 30),
      };
    });
    return {
      ...snapshot,
      inspection: {
        mainDocumentStatus: mainDocument?.status() ?? null,
        ...resourceCounts,
        pageErrors,
        pageErrorSummaries,
      },
    };
  } finally {
    await context.close();
    if (!suppliedBrowser) await browser.close();
  }
}
