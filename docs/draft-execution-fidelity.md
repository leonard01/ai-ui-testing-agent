# Draft-to-execution fidelity audit — v0.3 P0

Audited current branch after functional CI #1042. This document is an architectural release blocker, not evidence that the fixes are implemented.

## Contract

AI interpretation, site knowledge and discovery may propose actions before approval. The approved structured definition is the execution contract. Descriptions must accurately render that contract. The runner may resolve an explicitly declared locator and perform ordinary Playwright actionability/waiting, but must not introduce another functional action, relax an explicit locator, use prose to change a locator, or weaken an assertion. Failure-time discovery is advisory; accepting a correction creates a new reviewable draft. Export must preserve the same functional semantics or reject unsupported definitions explicitly.

## Findings and disposition

| ID | Source | Finding | Disposition |
|---|---|---|---|
| DF01 | src/discovery.ts resolveNamedDeletion | Hidden row hover before click; deletion class heuristic; positional candidate after hover | Remove hidden interaction; explicit hover and scoped target in approved draft; reject ambiguity |
| DF02 | src/runner.ts fill/press branch | Missing exact label silently substituted with placeholder | Fail original locator and offer reviewed repair |
| DF03 | src/runner.ts recoverAmbiguousCartClick | Ambiguous exact button locator narrowed using free-form step description | Fail ambiguity; scope must be structured and approved |
| DF04 | src/discovery.ts rolePolicy hint | Button hint can resolve exact named link | Explicitly disclose permitted roles or replace with reviewed exact role; strict role never relaxed |
| DF05 | src/discovery.ts candidateScore, resolveCartAction | Intent scoring uses name, nearby context, token normalization and specialised cart rules | Define precise approved resolution contract; no hidden workflow changes; avoid generic scoring for strict selectors; investigate wrong-record risk |
| DF06 | src/runner.ts search-results assert-text | Specialised container selection, case-insensitive containment regardless of nominal target and match | Make scope, comparison, case policy explicit; validate contradictory fields |
| DF07 | src/runner.ts assert-visible | Existential visible match, not unique target | Explicitly describe at least one visible match; preserve exact locator and ordinal |
| DF08 | src/export.ts | Separate intent resolver lacks latest deletion path; internal exact-locator fallbacks not mirrored; text assertion timing differs | Shared semantic contract; parity tests; fail unsupported export rather than silently diverge |
| DF09 | src/schema.ts | No hover action, scoped target composition, or dedicated negative visibility action | Add only necessary reviewable primitives with schema/UI/runner/export support; count zero remains explicit absence, not equivalent to hidden |
| DF10 | demo/review.html describeTarget/describeAction | Intent phrase hides runtime resolution details; search scope and visibility cardinality incompletely displayed | Render action, locator strategy, exactness, scope, ordinal, match/polarity and prerequisites; no inference from description |
| DF11 | src/runner.ts catch branches | DOM alternatives and suggested Enter are advisory, not executed | Retain; regression verifies no action occurs until approved |

## Implementation order

1. Reproduce DF01–03 with deterministic negative tests that inspect actual DOM state and report failure; keep existing approved repair paths. Test description cannot rescue ambiguous exact target. Remove silent exact-locator fallbacks and hidden hover. Keep incremental JSON recovery.
2. Define explicit hover/scoped locator schema and human-readable draft representation; support runner, review editor, validation, preflight, export and diagnostics together. Do not reintroduce specific AI instruction-to-step mapping.
3. Constrain intent resolution to its declared semantics, including role policy and contextual scope. Audit existing cart and completion heuristics and avoid site-specific rules. Do not replay unapproved steps during generation. Later-state unknowns remain reviewable unresolved targets, not evidence of a valid action.
4. Record approved step action/locator contract and resolved locator/action evidence per result, with secrets redacted. Ensure descriptions cannot alter behaviour.
5. Establish parity and negative assertion tests (hidden versus absent, scoped false positives, exact versus contains, visibility cardinality). Preserve existing valid semantics explicitly.
6. Run targeted tests then full deterministic regression; independently retest TodoMVC, SauceDemo, incremental AI and expanded manual release suite. Do not claim success from fixture counts alone.

## Acceptance

Incorrect exact names/roles/locators fail; ambiguous clicks fail without changing state; missing hover does not cause a hidden hover; explicit hover then scoped click affects only named record; wrong expectations fail; subsequent steps skipped on failure; repair remains advisory; export and runner agree on supported operations. All functional actions traceable to approved steps. Historical scripts requiring old fallbacks must be flagged for review, not silently migrated. No release until unresolved fidelity violations are addressed. See [manual release regression](manual-release-regression.md).


## Sequencing decision — v0.3

Complete and validate the execution-fidelity fixes before changing the AI generation architecture. Live incremental reinterpretation is temporarily disabled at the UI and API boundaries; injected mock-provider tests remain enabled to retain historical regression coverage. This gate must be removed before v0.3 publication, after acceptance of the replacement.

Second workstream, only after fidelity acceptance: replace specialised incremental reconciliation with standard test generation in continuation-fragment mode. Use new instructions and relevant read-only preceding context (not an assumed live post-prefix state); avoid automatic navigation or repeated prerequisites. Validate fragment actions through the shared generation contract, then deterministically splice structured steps into a single test definition executing in the same browser context. Preserve unaffected steps, IDs, approvals, original requirements and mappings; explicitly flag invalidated mappings for review. Never silently remove requirements. Do not concatenate independent Playwright tests or raw source. Compare against the legacy approach using live first-attempt success, retry success, token usage, latency and verified correctness. Re-enable reinterpretation only after targeted, full deterministic and live manual validation. Both workstreams are required for v0.3; do not merge or release with the temporary gate active.
