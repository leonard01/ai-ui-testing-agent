import { isIP } from "node:net";
import type { Request, BrowserContext } from "playwright";

/**
 * The approved site owns the test. Ordinary websites also need public CDNs:
 * blocking every third-party script/style/image can produce an error page.
 *
 * Cross-origin *navigations* stay blocked. Only public HTTPS GET/HEAD
 * subresources are allowed; cross-origin POSTs, internal hosts and IP literals
 * remain blocked. This is a browser-request policy, not a full network
 * sandbox: DNS / proxy policy must be enforced separately in untrusted hosting.
 */
export type BrowserRequestDecision = "same-origin" | "public-subresource" | "blocked";
export interface BrowserRequestDetails {
  url: string;
  method: string;
  resourceType: string;
  isNavigationRequest: boolean;
}
const SAFE_SUBRESOURCE_TYPES = new Set([
  "script", "stylesheet", "image", "font", "media", "xhr", "fetch", "other",
]);

function publicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!host || isIP(host) !== 0) return false;
  // Avoid obvious local/intranet names; see network-sandbox note above.
  if (host === "localhost" || host === "metadata.google.internal" ||
      /\.(?:localhost|local|internal|lan|home\.arpa|test|invalid)$/.test(host)) return false;
  return host.includes(".");
}

export function classifyBrowserRequest(
  request: BrowserRequestDetails,
  approvedOrigin: string,
): BrowserRequestDecision {
  let url: URL;
  try { url = new URL(request.url); }
  catch { return "blocked"; }
  if (url.origin === approvedOrigin) return "same-origin";
  if (request.isNavigationRequest || request.resourceType === "document") return "blocked";
  if (url.protocol !== "https:" || url.username || url.password ||
      (url.port && url.port !== "443") || !publicHostname(url.hostname)) return "blocked";
  if (!["GET", "HEAD"].includes(request.method.toUpperCase()) ||
      !SAFE_SUBRESOURCE_TYPES.has(request.resourceType)) return "blocked";
  return "public-subresource";
}

export function browserRequestDecision(request: Request, approvedOrigin: string): BrowserRequestDecision {
  return classifyBrowserRequest({
    url: request.url(), method: request.method(), resourceType: request.resourceType(),
    isNavigationRequest: request.isNavigationRequest(),
  }, approvedOrigin);
}

export interface BrowserRequestCounters {
  allowedCrossOriginRequests: number;
  blockedCrossOriginRequests: number;
}

/** Also supports ordinary route mocking in browser tests via fallback(). */
export async function installBrowserRequestPolicy(
  context: BrowserContext,
  approvedOrigin: string,
  counters?: BrowserRequestCounters,
): Promise<void> {
  await context.route("**/*", (route) => {
    const decision = browserRequestDecision(route.request(), approvedOrigin);
    if (decision === "blocked") {
      if (counters) counters.blockedCrossOriginRequests++;
      return route.abort("blockedbyclient");
    }
    if (decision === "public-subresource" && counters) {
      counters.allowedCrossOriginRequests++;
    }
    return route.fallback();
  });
}
