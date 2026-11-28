/**
 * Result cards only: never use page-wide text or the search input as proof
 * that the requested query returned a matching result.
 *
 * This is conservative and deliberately does not guess a generic `main` or
 * `body` locator. Sites with unrecognised markup must expose a supported
 * result region/card or fail visibly rather than produce a false pass.
 */
// New structural candidates require positive result-region evidence. A table
// or repeated card layout elsewhere on the page is not a search result.
const RESULT_REGION = ':is([aria-label*="results" i], [id*="results" i], [class*="search-results" i], [class*="results-list" i])';
const GENERIC_RECORD = 'div:has(> :is(h2,h3,h4,[role="heading"])):has(a[href],button,[role="button"])';

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
  // Data rows, never header-only rows.
  RESULT_REGION + ' tr:not(thead *):has(> td)',
  RESULT_REGION + ' [role="row"]:has(> :is([role="cell"],[role="gridcell"]))',
  // Repeated sibling records with their own heading and action. Do not use
  // the enclosing results region or a lone arbitrary div as evidence.
  RESULT_REGION + ' ' + GENERIC_RECORD + ':has(+ ' + GENERIC_RECORD + ')',
  RESULT_REGION + ' ' + GENERIC_RECORD + ' + ' + GENERIC_RECORD,
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
