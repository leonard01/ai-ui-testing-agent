import { chromium, type Browser } from "playwright";

/** Bounded, untrusted application context supplied to a test-design model. */
export interface PageSnapshot {
  url: string;
  title: string;
  headings: string[];
  controls: Array<{ kind: string; name: string; type?: string }>;
  statusText: string[];
  sampleText: string[];
}

export function ensureAllowedNavigation(destination: string, base: URL): URL {
  const url = new URL(destination, base);
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

export async function inspectApplication(
  baseURL: string,
  suppliedBrowser?: Browser,
): Promise<PageSnapshot> {
  const destination = ensureAllowedNavigation(baseURL, new URL(baseURL));
  const browser = suppliedBrowser ?? (await chromium.launch());
  const context = await browser.newContext({ serviceWorkers: "block" });
  context.setDefaultNavigationTimeout(10_000);
  try {
    await context.route("**/*", (route) => {
      try {
        return new URL(route.request().url()).origin === destination.origin
          ? route.continue()
          : route.abort("blockedbyclient");
      } catch {
        return route.abort("blockedbyclient");
      }
    });
    const page = await context.newPage();
    await page.goto(destination.href, { waitUntil: "domcontentloaded" });
    return await page.evaluate(() => {
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
        const kind = node.getAttribute("role") ||
          (node.tagName === "INPUT"
            ? (type === "checkbox" || type === "radio" ? type : "textbox")
            : node.tagName.toLowerCase());
        return { kind, name: accessibleName(node), ...(type ? { type } : {}) };
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
  } finally {
    await context.close();
    if (!suppliedBrowser) await browser.close();
  }
}
