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
