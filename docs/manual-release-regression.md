# Manual release regression and exploratory testing

Status: proposed expanded release manifest, effective v0.3. No results are implied. The existing [cross-site live baseline](cross-site-live-baseline.md) remains the historical fixed comparison set.

## Release policy

Run the complete applicable core checklist and one primary scenario on every available application below, before every release. Add a second scenario on at least eight distinct applications (prefer those affected by changes and those not previously used), then rotate the remaining variants across releases. Target 16–20 distinct implementations and at least 12 actual runnable applications; no more than two planned live-generation scenarios per implementation in the breadth pass unless needed to reproduce a critical defect. If access or budget prevents the target, record the actual count and obtain explicit release review rather than quietly reducing scope. Keep at least four independent holdout implementations out of development tuning; replace a holdout after using it to design a fix. Reserve provider allowance for defect reproduction and repeated samples; use saved approved definitions for runner-only cases, not as a substitute for live generation. All numerical targets are proposed planning defaults, not measured capabilities.

No release with an unexplained false pass, wrong-record action, hidden functional action, assertion weakening, or approved-draft/execution mismatch. Critical failures require reproduction, correction, deterministic regression, live retest and review of neighbouring functionality. Safe unsupported behaviour is distinct from success; document it and decide explicitly whether it is acceptable for advertised functionality. Full deterministic CI must pass independently.

## Procedure and evidence

1. Record release version, commit, browser, model, response mode, reasoning effort, token cap, memory setting, site/route and scenario ID. Smoke-check authorised access and actual controls first; the matrix is a candidate manifest, not a claim of verified availability. Adapt only before the measured attempt; record the exact instruction and any variant. Use dummy data only and avoid writes to shared systems.
2. Start with clean state and memory disabled for the cold-start breadth pass. Read the draft as a tester: inspect action, locator, exact name, role, scope, prerequisite, value, assertion comparison/polarity and expected state. Record first-attempt fidelity before any edits.
3. For unsafe, incorrect or ambiguous drafts, do not approve on a real site; record safe rejection or repair. Deliberately incorrect locators are exercised only on authorised disposable demos. Verify no hidden action occurred.
4. Approve, execute headed where possible, independently observe actual browser state and compare report/trace with each approved step. Distinguish the requested action from the observed state transition. For deletion assert target absence AND neighbouring record presence; for toggles inspect checked state rather than only text.
5. Retain redacted draft JSON, original and amended instructions, response diagnostics, usage, run report, trace/screenshots, independent expected/observed state, corrections, and first-attempt outcome. Never retain credentials or secrets in shared evidence.
6. Repeat a fixed cross-site subset on at least four implementations with fresh model calls; compare results with prior release. Test memory-enabled repeats separately on at least three suitable implementations, including login and no-login/negative cases; do not pool cold and warm samples.
7. Classify each attempt: unassisted verified pass, assisted verified pass, generation failure, safe rejection, execution failure, false positive/wrong action, fidelity violation, unavailable, insufficient evidence. Keep all attempted cases in denominators; report unavailable separately. A retry does not erase a failed first attempt.
8. Stop and diagnose repeated provider errors/limits rather than repeatedly spending tokens; resume with recorded coverage gaps. No blanket pass from CI or from a runner status alone.

## Mandatory draft-to-execution fidelity checks (F)

Execute on disposable controlled demos; reuse approved definitions and edit individual fields to isolate deterministic behaviour. Where a capability is not implemented, record unsupported explicitly; do not treat it as passed.

| ID | Test | Expected |
|---|---|---|
| F01 | Exact accessible name deliberately misspelled | Fail, no alternate target clicked. |
| F02 | Correct text but incorrect explicit element role | Fail; alternatives advisory only. |
| F03 | Wrong label vs placeholder | Fail; no silent locator substitution. |
| F04 | Wrong CSS/ID/test ID/XPath | Fail; no fallback to unrelated element. |
| F05 | Two identically named controls, no ordinal | Fail with ambiguity evidence; neither activated. |
| F06 | Explicit ordinal among repeated buttons | Only specified element activated; out-of-range fails. |
| F07 | Missing prerequisite action (e.g. hover-revealed delete) | No hidden functional action. Fail or execute only the explicitly authorised locator contract; any hover must be visible in approved plan and trace. |
| F08 | Explicit hover followed by scoped click | If supported, both actions shown and separately traceable; correct item removed. Otherwise safe unsupported. |
| F09 | Named deletion near other rows, global Clear completed and duplicate item identities | Never delete wrong row or invoke bulk operation; ambiguity fails; check both target absence and other presence. |
| F10 | Intent locator vs exact role/name locator | Draft makes distinction and resolution contract clear; exact locator never relaxed; no unapproved interaction. |
| F11 | Wrong expected exact text with substring present | Fail, no automatic contains substitution. |
| F12 | Negative assertion against a present target; then absent target | Present fails, absent passes; hidden vs removed distinguished if requested. |
| F13 | Scoped assertion with matching text outside scope or hidden | Fail; no DOM-wide or hidden-text false pass. |
| F14 | Incorrect URL, count or selected state | Fail against actual state; no assertion rewriting. |
| F15 | Action mismatch (check vs click, fill vs press) | Wrong action fails or has exactly its documented semantics; no substitution. |
| F16 | Review locator/action edits then save and reload | Draft, stored JSON and execution semantics agree; edited step approval reset. |
| F17 | Compare approved draft with actual trace on passing and failing run | All functional actions authorised; actual resolved locator, action, expected/observed and errors traceable; no unexplained operations. |
| F18 | Failed-step correction suggested from evidence | No automatic application; reject retains original, approve creates reviewed amended action and rerun. |
| F19 | First failing step and subsequent steps | Report first actual failure; later actions skipped; no hidden attempts to fix workflow. |
| F20 | Export an approved test and compare with app runner | Supported action/locator semantics agree; unsupported exports clearly identified rather than silently changed. |

## Cross-site matrix (A)

Each row is an independent application candidate (not every route counted separately). Primary and variant are separate short scenarios. Pick actual names from live page before freezing instructions if a demo changes. Sites and capabilities have not been verified in this edit; access restrictions, frames, shadow DOM and unsupported controls are exploratory findings, not licence to bypass safeguards. No purchases, actual financial actions, or writes to shared data.

| ID | Application | URL | Primary scenario | Variation |
|---|---|---|---|---|
| A01 | Local bundled demo | Configured local demo URL | Create two tasks; verify both; delete one; verify absence and other remains. | Run fresh, then rerun saved test; compare draft and actual actions. |
| A02 | Playwright TodoMVC | https://demo.playwright.dev/todomvc/ | Add Alpha and Beta; delete Alpha; verify Alpha absent and Beta visible. | Complete Beta; filter Active then Completed; independently verify scope. |
| A03 | SauceDemo | https://www.saucedemo.com/ | Log in with public standard_user / secret_sauce; add Backpack and Bike Light; remove Backpack; verify cart contents. | Sort by price; open product; return; inspect order independently. |
| A04 | Selenium web form | https://www.selenium.dev/selenium/web/web-form.html | Fill text, select Two, check checkbox; submit; verify Received! | Use radio, textarea and disabled input negative attempt. |
| A05 | The Internet | https://the-internet.herokuapp.com/ | Open Dynamic Loading Example 2; Start; verify Hello World! | Add Element twice; delete one by explicit ordinal; verify count. |
| A06 | UI Testing Playground | https://uitestingplayground.com/ | Open Dynamic ID; click the designated button without invented ID. | Open Text Input; enter unique label; click update; verify new button label. |
| A07 | Practice Test Automation | https://practicetestautomation.com/practice-test-login/ | Log in using published demo credentials; verify success message. | Fresh session with invalid password; verify error and no success. |
| A08 | DemoQA | https://demoqa.com/ | Open Text Box; fill dummy name/email/address; submit; verify rendered output. | Open Radio Button; select available choice; attempt disabled choice separately. |
| A09 | Automation Exercise | https://automationexercise.com/ | Search a product; verify result cards contain requested term. | Open product details; verify title and price; no checkout or payment. |
| A10 | OpenCart demo (LambdaTest) | https://ecommerce-playground.lambdatest.io/ | Search for a product visible on page; verify result identity. | Open two product cards or sort results; independently verify correct card/order. |
| A11 | jQuery UI | https://jqueryui.com/ | Open accordion demo; expand a named section; verify displayed panel. | Open tabs demo; select a named tab; verify panel. Record iframe limitations. |
| A12 | W3Schools Tryit | https://www.w3schools.com/html/tryit.asp?filename=tryhtml_form_submit | Fill example form using dummy data; inspect target frame; avoid editing source. | Verify explicit iframe targeting or safe unsupported rejection. |
| A13 | MDN interactive examples | https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/select | Inspect select example; choose a named option if interactive. | Try keyboard navigation; verify actual selection or report unsupported frame. |
| A14 | Bootstrap documentation | https://getbootstrap.com/docs/5.3/components/modal/ | Launch example modal; verify its heading; close via button; verify absence. | Close via Escape; distinguish visible versus hidden DOM. |
| A15 | Material UI documentation | https://mui.com/material-ui/react-switch/ | Toggle example switch; independently confirm changed state. | Use disabled switch example; confirm safe failure or no state change. |
| A16 | React Aria examples | https://react-spectrum.adobe.com/react-aria/ComboBox.html | Open interactive combobox example; type a visible option; select it. | Verify selected value; test ambiguity or keyboard selection. |
| A17 | Angular Material examples | https://material.angular.dev/components/checkbox/overview | Toggle available checkbox; verify state independently. | Exercise indeterminate or disabled variant if present. |
| A18 | Web Components / Shoelace examples | https://shoelace.style/components/dialog | Open example dialog; verify visible content; close. | Check keyboard dismissal and shadow DOM handling; safe rejection if unsupported. |
| A19 | OrangeHRM demo | https://opensource-demo.orangehrmlive.com/ | Use only published demo login credentials; verify dashboard. | Navigate read-only to directory and search a visible record; no shared-data edits. |
| A20 | Parabank demo | https://parabank.parasoft.com/parabank/index.htm | Use read-only navigation to About Us or Services; verify heading. | Attempt invalid dummy login; verify error; no registration, transfers or financial actions. |

## Application workflow and variation checklist (W)

Spread these across the matrix; combine compatible checks into the same session rather than spending a separate model request per check. Every applicable W item must have evidence per release.

| ID | Area | Variations / expected |
|---|---|---|
| W01 | New Test | Required fields empty, whitespace, duplicate name; generation disabled or clear error; new form resets. |
| W02 | URL selection | Typed URL vs saved URL; source is unambiguous; nested/hash URL preserved; invalid and blocked sites diagnosed. |
| W03 | Instruction complexity | One action, action+assertion, 5–10 steps, multiple independent requirements, varied phrasing, ambiguity. |
| W04 | Requirement mapping | All covered, missing, extra, later-state; warnings concise; linked step review; amendment preserves unrelated requirements. |
| W05 | Draft editing | Change locator type/role/value, action type, expectation; invalid fields rejected; edited step needs review. |
| W06 | Approval | Individual/select all; missing approvals; no save/run until required approvals and credential review. |
| W07 | Incremental reinterpretation | Middle and final step, replace remainder, single-step where supported, add verification, discard, retry same instruction; compare unaffected IDs, values and approvals. |
| W08 | Incremental failure | Malformed JSON, schema error, missing reconciliation, budget exhaustion, transient provider error; bounded attempts; no partial overwrite; raw/technical diagnostics available. |
| W09 | Memory | Cold/warm login, explicit credential overrides, no-login intent, unrelated site, memory disabled; inserted steps visible and scoped. |
| W10 | Credentials | Public demo credentials explicit, placeholder review, wrong credentials; never silently substitute or leak secrets. |
| W11 | Persistence | Save draft with partial approvals, reload, edit, save approved, save as new vs overwrite; original instructions preserved. |
| W12 | Suites | Multiple sites, suite filtering/all, duplicate names, delete individual vs suite, multi-test run and failure isolation. |
| W13 | Execution | Headed run, timeout, first failure, subsequent skipped, expected/observed, screenshot/trace, rerun fresh state. |
| W14 | Repair | Direct edit action/locator, DOM search by name/text, ambiguity selection, no candidates, amend matching occurrences, explicit approval before rerun. |
| W15 | Assertions | Exact vs contains, visible vs absent, multiple independent terms, count, URL, wrong role, scoped vs DOM-wide; unsupported AND/NOT variants recorded. |
| W16 | Dynamic UI | Delayed visibility, repeated controls, hover, filters, modals, tabs, nested frames, shadow DOM; unsupported behaviours reported clearly. |
| W17 | History | Pass/fail filter, pagination, selected run evidence, delete all confirmation; no misleading counts. |
| W18 | Navigation/workspaces | New/existing, instructions/draft/results and back navigation preserve state; unsaved draft indicator. |
| W19 | AI diagnostics | Input/output/total tokens, response mode, reasoning, first/retry raw responses, provider error category; no stale result. |
| W20 | Robustness | Network/timeout/rate limit/auth/403; no fabricated successful draft; recover after valid request. Use controlled simulation where live failure is not reproducible. |
| W21 | Export | Export supported test, review locator and assertion fidelity; explicit unsupported operations. |
| W22 | Exploratory | Unscripted variation of one action/locator/wording per available site; record original and variation with observed behaviour. |

## Rotating exploration charters

Assign at least one charter to each site; cover every charter across the release. Vary one dimension at a time when diagnosing. Suggested 10–15 minute timebox per exploratory session (adjust to available time and quota).

| Charter | Explore |
|---|---|
| C1 | Semantic labels vs placeholders vs text vs icons; exactness and duplicate identities. |
| C2 | Dynamic state, hover, disabled controls, loading, disappearing targets, focus and keyboard. |
| C3 | Repeated records, contextual controls, scoped assertions and wrong-record protection. |
| C4 | Alternative instruction wording, implicit routine prerequisites, contradictory or ambiguous requests. |
| C5 | Incremental edits, requirement preservation, repair and rerun across unfamiliar sites. |
| C6 | Memory isolation, credentials, saved/reopened test and state reset. |
| C7 | Negative assertions, exact/contains, hidden vs absent, incorrect expected state. |
| C8 | Provider/access errors, token usage, diagnostics, user-visible recovery and export fidelity. |

## Release record template

| Release/commit | Model/settings | Sites attempted / runnable | Live generation attempts | Fidelity checks | Workflow checks | Holdouts | CI | Decision |
|---|---|---|---|---|---|---|---|---|
| | | | | | | | | |

| Scenario + variant | Site | Cold/warm | Exact instructions / approved draft ref | Independent observed state + trace | Outcome (first attempt / final) | Corrections / tokens / latency | Defect or evidence link |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

Report separate counts for first-attempt verified passes, assisted passes, failures by category, unavailable environments, and fidelity violations. Include coverage gaps and any explicitly accepted unsupported functionality. Record reasons for deferrals and link critical defects before sign-off. Do not declare completion from this template alone.
