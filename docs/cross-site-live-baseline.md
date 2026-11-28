# v0.3 cross-site live baseline

This is a fixed manual benchmark, complementary to deterministic regression, not the future stochastic framework (#139). Freeze new locator heuristics until the SauceDemo generation failures are classified and a cross-site baseline exists. No provider calls in default CI.

## Protocol
Use fresh browser state and fresh drafts; record commit, model, response policy, reasoning effort, memory state, timestamp and scenario ID. Keep these settings constant for comparisons. Record first attempt before correction; retain original instructions, raw model response (copy before next generation), draft, usage export and run report. Redact secrets. Independently inspect actual interactions and expected state; do not equate runner pass with correctness. Classify generation failure, safe rejection, incorrect execution/false positive, unassisted verified pass, assisted pass, unavailable environment, or insufficient evidence. Keep failures in denominators; report unavailable separately. Do not regenerate merely to obtain a pass. Stop on common provider/access failures and diagnose first. Repeat a fixed subset before/after significant generation or resolver changes. Do not assume one sample establishes causality.

## Fix acceptance
Reproduce first; classify universal, conditional or site-specific; prefer minimal generalisable changes and isolate app-specific knowledge in appropriate configuration/memory rather than core heuristics. Establish cross-site pre-change evidence, add deterministic positive and negative tests, run full regression and repeat the live benchmark; compare outcomes and investigate any deterioration before accepting. Record exceptions explicitly.

## Candidate fixed scenarios
These are proposed manual instructions, not verified site capabilities or measured results. Smoke-check page access and controls before freezing the manifest; if unavailable, record why and version any substitution. Use only authorised public demo environments and dummy data. Do not execute real transactions. Negative state can be independently inspected even when generation support is incomplete.

| ID | URL | Instructions / independent observation |
|---|---|---|
| XS01 | https://demo.playwright.dev/todomvc/ | Add "Review report"; verify visible. |
| XS02 | same | Add "Review report" and "Prepare presentation"; verify both visible. |
| XS03 | same | Add "Review report"; mark completed; select Completed filter; verify visible; independently check completion and filter. |
| XS04 | same | Add "Alpha" and "Beta"; complete Alpha; select Active; verify Beta visible; independently check Alpha excluded. |
| XS05 | same | Add "Alpha" and "Beta"; delete Alpha; verify Beta remains; independently check Alpha absent. |
| XS06 | https://www.saucedemo.com/ | Log in; add Sauce Labs Backpack; open cart; verify Backpack visible. |
| XS07 | same | Log in; add Backpack and Bike Light; open cart; verify both visible. |
| XS08 | same | Log in; add both; open cart; remove Backpack; verify Bike Light visible; independently check Backpack absent. |
| XS09 | same | Log in; sort price low to high; open Sauce Labs Onesie; verify title; return to products; independently check sorting. |
| XS10 | same | Log in; open cart without adding products; verify Your Cart heading; independently check empty cart. |
| XS11 | https://www.selenium.dev/selenium/web/web-form.html | Enter "Example" into Text input; verify value independently. |
| XS12 | same | Select Two from Dropdown (select); verify selected value independently. |
| XS13 | same | Check Default checkbox; verify checked state independently. |
| XS14 | same | Select Default radio; verify selected state independently. |
| XS15 | same | Enter dummy text and submit form; verify Received! message. |
| XS16 | https://the-internet.herokuapp.com/dynamic_loading/1 | Click Start; verify Hello World! visible. |
| XS17 | https://the-internet.herokuapp.com/dynamic_loading/2 | Click Start; verify Hello World! visible. |
| XS18 | https://the-internet.herokuapp.com/add_remove_elements/ | Click Add Element twice; verify two Delete buttons (or independently count). |
| XS19 | same | Click Add Element; click Delete; verify Add Element visible; independently check Delete absent. |
| XS20 | https://the-internet.herokuapp.com/checkboxes | Check first checkbox; verify state independently; record ambiguity if not resolvable. |
| XS21 | https://the-internet.herokuapp.com/ | Open Dropdown; verify Dropdown List heading. |
| XS22 | https://the-internet.herokuapp.com/dropdown | Select Option 2; independently verify selected value. |
| XS23 | https://the-internet.herokuapp.com/ | Open Checkboxes; verify Checkboxes heading. |
| XS24 | https://the-internet.herokuapp.com/ | Open Inputs; enter 42; independently verify value. |
| XS25 | https://the-internet.herokuapp.com/ | Open Dynamic Loading; open Example 2; verify Start visible. |

## Current evidence
LIVE-004–007: user reported all four generation failures, no execution. Cause unknown; preserve raw response/error and usage evidence. XS06–09 correspond to those workflows; do not relabel unverified failures as benchmark results without recording settings and evidence. No new heuristics until investigated.


## Release priority update — 27 November 2026
After the current contextual recovery, candidate context and ranking work, freeze new resolver heuristics and prioritise site independence as a v0.3 release-validation objective. The existing 25 scenarios remain useful as a familiar-site regression baseline but are not sufficient evidence of generalisation.

- Target at least ten distinct application implementations overall, including at least six previously unused applications; do not count multiple routes on one application as independent sites. Cover different frameworks, semantic and non-semantic markup, repeated cards/rows, forms, navigation, dynamic state, and multi-step workflows.
- Verify authorised demo access and actual capabilities before freezing a versioned scenario manifest. Select comparable scenario families on different implementations, plus unfamiliar workflows. Keep a holdout subset unused during resolver development; if a holdout is used to tune a fix, replace it for subsequent independent assessment.
- Separate cold-start (no prior application memory) from warm-start (verified application memory available); never pool these results. Repeat a fixed subset with fresh model calls to observe variability, subject to provider budget. Report actual sample sizes, not extrapolated reliability guarantees.
- Report generation success, requirement fidelity, independent unassisted execution correctness, false positives/wrong actions, safe rejection, assisted success, human correction effort, token use and latency by application and scenario family. Do not count unavailable environments as execution passes or silently discard failed attempts.
- Treat cross-site deterioration and false positives as release-review blockers; classify and reproduce defects before fixing. Prefer general DOM relationships and evidence over site-specific hardcoding. Record exceptions and agree final acceptance thresholds after reviewing initial evidence, not by retroactively redefining successes.
- This is a manual live validation expansion for v0.3, not implementation of the v0.4 stochastic evaluation framework (#139) or optional exploration (#148).


## Deterministic assertion validation — 28 November 2026

- Baseline commit `ba57ce0`: 235 unit tests, 12 independent smoke tests and 265 full browser regression tests passed in CI run [46105566799](https://github.com/leonard01/ai-ui-testing-agent/actions/runs/46105566799).
- Partial-text discovery reproduction `b95b5dd`: 39 passed, two expected failures in the targeted suite. The hidden/input-content exclusion test passed.
- Fix `53469a1`: 28 sanity and 41 targeted discovery/repair tests passed in [46106863867](https://github.com/leonard01/ai-ui-testing-agent/actions/runs/46106863867). Suggestions preserve the original assertion type and expected text; partial matches are case-sensitive and candidate text is bounded to 180 characters. These are advisory locator suggestions, not automatically weakened comparisons.
- Request full deterministic regression before closing Sprint 2; do not equate these controlled-fixture results with independent cross-site or live model correctness. Live holdout evaluation remains outstanding.


## Sprint 3 deterministic recovery validation — 28 November 2026

- Direct failed-step editing (#152) validated with action-type correction, explicit assertion change confirmation, approval reset, unaffected step preservation and rerun.
- Failure-time searchable element picker (#153) validated through capture, step-scoped search API, selection without silent action changes, amendment and rerun. Evidence is in memory, limited to 20 runs and 30 minutes of search availability; lazy pruning on subsequent activity. The unavailable-evidence UI fallback was tested by simulating the API error, not by exercising actual TTL expiry or eviction.
- Unified assertion recovery (#154) validated with partial visible paragraph matches, hidden candidate exclusion, unchanged expected text, explicit comparison approval, and successful rerun. Explicit equality protection is a conservative lexical guard, not comprehensive semantic requirement interpretation. Search-result-scoped failures cannot use page-wide quick repair or accept diagnostics as observed text.
- Targeted CI [46113222657](https://github.com/leonard01/ai-ui-testing-agent/actions/runs/46113222657) at `f8c9e97`: 235 unit, 37 sanity and 44 feature regression tests passed. These suites may overlap; not a count of unique tests.
- Full deterministic regression requested by this commit. No claim of full regression success until CI completes.
- Remaining limitations: full independent live holdout validation, dedicated evidence retention expiry/eviction tests, possible hidden-element text assertion false pass (requires isolated reproduction), and existing amendment lifecycle that replaces prior saved version and can remove its associated run history. Recovery candidate visibility does not imply text assertion visibility. No complete privacy redaction guarantee for visible page content.

### Sprint 3 full regression sign-off

CI [46114169042](https://github.com/leonard01/ai-ui-testing-agent/actions/runs/46114169042) at `ad172f8`: 235 unit, 12 independent smoke and 280 browser tests passed (527 test executions, not necessarily unique tests). The earlier full runs exposed a positional test selector and an exact accessible-name mismatch; semantic test selectors and explicit accessible labels resolved these. Deterministic Sprint 3 sign-off is complete; the limitations above and independent live acceptance remain outstanding.


## Release-wide exploratory regression — mandatory from v0.3

The fixed XS01–25 benchmark above is retained for longitudinal comparison; do not run all 25 on every release at the expense of cross-site breadth. The [manual release regression suite](manual-release-regression.md) is the broader release gate. Run its mandatory fidelity checks and site matrix, rotate independent holdouts, and record the exact manifest and outcomes for every release. A deterministic green CI or a passing execution report cannot substitute for a verified draft-to-execution causal link.

The approved draft must describe the executable operation and locator contract accurately. No hidden functional interaction, action substitution, selector relaxation or assertion weakening is acceptable. Discovery may propose changes for review, not silently execute them. Any discrepancy between approved draft and actual execution, wrong-record action, or false pass blocks release. The existing contextual deletion resolver requires review against this rule; its passing fixture tests do not close the defect. 
