/**
 * Result cards only: never use page-wide text or the search input as proof
 * that the requested query returned a matching result.
 *
 * This is conservative and deliberately does not guess a generic `main` or
 * `body` locator. Sites with unrecognised markup must expose a supported
 * result region/card or fail visibly rather than produce a false pass.
 */
export const SEARCH_RESULT_ITEM_SELECTOR = [
  '[data-testid="search-result"]',
  '[data-testid^="search-result-"]',
  '[data-testid*="result-item"]',
  '[data-testid*="product-card"]',
  '[data-test="search-result"]',
  '[role="feed"] > [role="article"]',
  'main article',
  '[role="main"] article',
  '[role="main"] [role="listitem"]',
  'main [role="listitem"]',
  '[aria-label*="results" i] article',
  '[aria-label*="results" i] li',
  '[id*="results" i] article',
  '[id*="results" i] li',
  '[class*="search-results" i] article',
  '[class*="search-results" i] li',
  '[class*="search-results" i] [class*="item"]',
  '[class*="results-list" i] li',
  '.srp-results .s-item:not([class*="__"])',
  '#b_results > li.b_algo',
  '#search .MjjYud:has(h3)',
  '#rso .MjjYud:has(h3)',
].join(", ");

export function isExplicitSearchResultIntent(requirements: string): boolean {
  return /\b(?:search|searching|searched|query|lookup)\b/i.test(requirements) &&
    /\b(?:results?|returns?|returned|items?|products?|listings?)\b/i.test(requirements);
}

/** For a search query, a tautological text locator must be scoped to results. */
export function shouldScopeSearchResultAssertion(
  requirements: string,
  action: { expected?: string; target?: { by: string; value?: string } },
  searchedValues: string[],
): boolean {
  if (!isExplicitSearchResultIntent(requirements)) return false;
  const expected = (action.expected ?? "").trim().toLocaleLowerCase();
  if (!expected || !searchedValues.some(value => value.trim().toLocaleLowerCase() === expected)) {
    return false;
  }
  // We only promote the matching query; unrelated site-status assertions
  // remain unchanged and ordinary non-search tests are unaffected.
  return true;
}
