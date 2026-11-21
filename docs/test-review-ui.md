# Natural-language test review UI (early MVP)

This is a **local-only** test-draft builder, not a deployed SaaS application. It runs on your computer, while GroqCloud handles model inference remotely. The browser never receives the API key.

## Start

From the repository root, with Node.js 22+ and Playwright Chromium installed:

```bash
git pull --ff-only
npm ci
npm run build
```

Put your actual GroqCloud key in ignored `.env`:

```dotenv
GROQ_API_KEY="gsk_your_key"
```

Start the application under test in terminal 1:

```bash
npm run demo
```

Start the review UI in terminal 2:

```bash
npm run review
```

Open **http://127.0.0.1:3100/** in a browser.

## Use

1. Set the application URL (initially `http://127.0.0.1:3000`).
2. Write plain-English actions and expected results, e.g. **"Add a task called Prepare interview, check that it appears, complete it, then delete it."**
3. Optionally import a **.txt or .md** file. Its text is appended to the textarea; you can revise it before submission. Input is capped at 12,000 characters.
4. Select **GroqCloud** (real hosted model, using free-tier limits) or **Fixture** (prewritten nine-step test for debugging; does *not* generate new steps from the entered request).
5. Click **Generate draft**. The server inspects the specified page in a headless Chromium session, sends the selected instructions and bounded snapshot to the chosen model, and validates the returned JSON with the existing schema.
6. Inspect the **human-readable plan**. Each card shows the real operation, target, value or expectation and assertion provenance. Inferred assertions and suspicious named listitem locators are flagged.
7. Change fields via **Edit fields** if needed, including switching a locator between accessible role/name, form label and visible text. For example, replace an incorrect form-label locator for the **Add** button with role **button**, accessible name **Add**. Then individually confirm each step represents your intended behaviour. Saved tests can be reopened into the editor using **Edit selected saved test in review form**; manually editing JSON files is not necessary.
8. Click **Approve and save JSON test**. This saves an ordinary, framework-neutral file under `generated/`. It **does not execute** the test.
9. In **3. Execute and diagnose**, choose your saved test (newly saved tests are selected automatically), choose a 5/10/15-second per-step timeout, and click **Run selected test**.
10. The local server launches headless Playwright for that explicitly saved test, with **one browser execution at a time** to reduce pressure on slower laptops.
11. The UI polls for completion, then shows per-step results, expected and observed text, locator-discovery evidence, and the first failure's likely category. When available, click **Open failure screenshot**, **Download Playwright trace** or **View full JSON report**.

After restarting the UI server, the saved test dropdown repopulates from `generated/reviewed-*.json`. The UI retains execution reports on disk in `run-results/`. The current prototype does not reload historical reports after a server restart; use the saved JSON report files for those historical runs.

## Run multiple approved tests as a suite (new feature branch)

After saving at least two test definitions, use **3. Execute and diagnose → Run a test suite**:

1. Tick one or more saved tests (up to 10), or use **Select first 10**.
2. Set the application URL and step timeout, then click **Run selected suite**.
3. Watch the live progress indicator and per-case **queued / running / passed / assertion-failed / execution-error** verdicts.
4. For any completed case, choose **View details** to open its existing step results, expected/observed values, screenshot, trace and repair options.
5. Open **suite JSON report** for a consolidated verdict. A copy is written under `run-results/suites/<suite-id>/report.json`.

**Execution guarantees:** The server validates every selected saved test and all its same-origin navigation/URL assertions *before* it starts the suite; it rejects invalid or duplicate IDs, unknown files and oversized selections. Tests run sequentially, never in parallel, with a fresh isolated browser context per test. A failed test does not stop the next one. While a suite is running, a second suite, single test, selector preflight or replacement of one of its queued tests is rejected. This limits browser contention on older laptops.

No AI model is contacted when replaying approved cases, and review approvals/expectations are never silently modified. Current-session suite results can be opened from the dashboard, but suite history is not loaded into the UI after a server restart; the saved JSON summary remains available on disk. This is a bounded first version, not a persistent test management system.

## Broader browser actions and assertions (development branch)

Generated and reviewed JSON cases may now include:

- `select-option`: native single-value dropdown selection (the JSON `value` is an option's HTML value)
- `check` / `uncheck`: set checkbox state (or check a radio input), without toggling blindly
- `press`: send a supported single key to an element, such as `Enter`, `Tab` or an arrow key
- `assert-url`: verify the exact same-origin URL, resolving relative URLs against the application base
- `assert-count`: verify an exact number of matched DOM elements, including zero. Use explicit role/name, label or text targets (not intent); no additional visibility filter is applied

The **Edit fields** interface displays each action in readable language and permits its fields to be changed without editing JSON. It does not yet offer an action-type conversion menu; use generation to create new action kinds. All assertions still require reviewed provenance. Count and URL mismatches remain test failures; locator preflight is only advisory and cannot prove actions will succeed after state changes.

Broader browser actions are merged into `main` via PR #12.

## Read-only selector preflight (on main)

Before confirming and saving a generated or edited draft, click **Check selectors (read-only)** below the step list. The local server opens just the first navigation URL in a fresh, isolated Chromium context and checks explicit role/name, label and visible-text locators. No test click, fill or assertion is executed, no AI model is contacted, and no test fields are modified.

- **Matched** means one visible element was found on the starting page. **Initial-match** means one was found there but earlier steps may change it before execution.
- **Warning** means a selector did not match, was ambiguous, was hidden, or referred to a non-fillable field on the starting page. Where a different selector uniquely resolves (e.g. a button named Add rather than a form label Add), it is displayed as a *suggestion*, never automatically applied.
- **Deferred** means preflight cannot safely determine the runtime target: for example, intent-based targets, missing elements after state changes, or steps after a subsequent navigation.

These are advisory results: a successful preflight cannot prove later execution will pass, and an initial-page warning after a click/fill may reflect legitimate dynamic state. The test still needs human review, and changes to fields clear the previous findings. No browser trace or screenshots are captured during preflight. It shares the same HTTP(S) same-origin navigation and request restrictions as the runner, and an active preflight cannot run simultaneously with a test execution.

## Saving revisions without duplicates

The saved-test dropdown shows **only the active revised script** after an edit or human-assisted repair. Each amendment is validated and written first; only then is the superseded saved test deleted. If the save fails, the original file stays available. Completed run reports associated with the replaced test are cleared from the current server session, along with their failure screenshots and traces. Previously archived artifacts from an older server session are not displayed in the dropdown and are not automatically scanned or deleted. A new test generated from scratch remains a separate test.

## No manual JSON editing: repairing existing saved tests

The Test Builder is the supported editing interface. **Never require someone to open or hand-edit a JSON test file.** Users can choose an approved saved test under **Execute and diagnose**, click **Edit selected saved test in review form**, change descriptions, targets, inputs or expected text using the existing field editors, explicitly reconfirm the steps, and save an amended approved test. After the replacement is safely written, the superseded test is removed from the saved-test list. The local `GET /api/tests/<approved-id>` route only exposes a validated saved test (not arbitrary files).

For a failed explicit locator such as `getByLabel("Add")`, the runner now inspects the **live page at the failure point**. When it finds visible, uniquely accessible candidates matching the requested action, the failed step displays **Choose a replacement element** with role, accessible name and nearby text. The tester can select **button named Add** and click **Save corrected locator and rerun from start**; the server accepts only the recorded candidate, saves a new revision with that step's role/name locator, removes the failed saved version, preserves the other steps and all assertions, and reruns from step 1. **No JSON editing or extra AI call is needed.**

The runner does not silently click or change targets. If the candidate list is incomplete or no unique candidate can be validated, use **Edit selected saved test in review form** instead. If a chosen locator fails on a later run, the error and evidence remain visible. The server rejects arbitrary candidate indexes and invalid run/step IDs.

## Editing a failed assertion's DOM search text

The **Find assertion target in captured DOM** panel now has a **Search visible DOM text** input. It defaults to the expected text for a mismatch (for example, `Sauce Labs Backpack`), but the tester can type another phrase (such as `Backpack` or `Add to cart`) and click **Search captured DOM**. The UI replaces the suggestion list with grounded matches, ordered by exact, prefix, then substring match, while showing each element's tag, role and nearby context. An empty result means no uniquely addressable match was captured; shorter text may help.

The runner captures a bounded index of **visible, non-editable DOM text** at the moment the assertion fails, verifying that every suggested role/name or exact-text selector matches one visible element. The local server retains that index **in memory only**, not in the downloadable report, and removes it when the superseded failed run is cleaned up. Searching this evidence does **not** replay login, clicks, form submissions, or any other test steps, and costs no AI tokens. Search is deliberately limited to the captured failed-page state; if the site changes later, rerun the test for fresh DOM evidence.

Only an explicitly chosen **verified** candidate can be saved. The server checks that the selected result belongs to the most recent search using a short-lived token, and it preserves the assertion's `expected` value, kind and provenance. Searching for a different phrase is **not** the same as editing the expected assertion result: that uses the separate human-confirmed assertion editor. If more matches exist than can be shown, refine the search to proceed. A successful amendment replaces the old saved test and begins a new run from step 1.

## Text mismatch: find the expected value elsewhere on the page

A text assertion can resolve a locator successfully but read the **wrong element**: for example, the generated target returns `Add to cart` while the actual expected text `Sauce Labs Backpack` is visible in a separate product-name `<div>`. This remains a genuine **assertion failure**. The runner now searches *all eligible visible DOM text elements* (not just a fixed list of spans, headings, labels or statuses), prioritizing **exact rendered text matches**. It excludes hidden/script/input content and verifies the proposed Playwright selector uniquely identifies a visible element.

The UI shows **Find assertion target in live DOM** even when the original selector was found but returned the wrong text. The user can choose the actual product-name element. The saved correction replaces only the assertion's selector, leaving expected text and provenance intact. The previous failed saved test and its current-session run artifacts are removed after successful replacement; rerun begins at step 1.

If the expected text is *not present* in the live DOM, the test stays failed and the app does not offer unrelated text as a false positive. The reviewer can investigate whether navigation, authentication, application state, timing or the expectation is wrong. This feature requires no Groq call and does **not** silently rewrite assertions to pass. Text rendered only in images/canvas, CSS pseudo-elements, hidden frames or duplicate indistinguishable elements may require future visual or scoped selector support.

## Failed assertion locator: live DOM text search

When a visibility or text assertion cannot locate its original target (for example `getByRole("heading", { name: "Products" })`), the runner searches **visible DOM elements on the page at failure time**, including spans, headings, text containers and status regions. A screenshot or the initial page snapshot is not sufficient for dynamic post-login content. The search uses the missing locator's name/text, ranks exact matches first and proposes only elements whose Playwright role/name or exact visible-text locator is unique and currently visible. It never searches input field values or blindly clicks anything.

The failed step now presents **Find assertion target in live DOM**, with each candidate's tag, role, name, nearby text and the verified selector. If the shop renders `<span class="title">Products</span>` instead of a heading, the UI can offer **Visible text "Products"**. The tester chooses and clicks **Save corrected assertion target and rerun**. A validated replacement test is saved, the failed saved version is removed from the dropdown, and the test starts again at step 1. The endpoint `POST /api/repair-assertion-target` accepts **only the selected candidate recorded in a completed failing run**; arbitrary text/selector input is rejected.

This changes **only the assertion's locator**; the action remains `assert-visible` or `assert-text`, and the expected text and provenance remain exactly as approved. If no matching text is actually present (e.g. a failed login), the UI does not fabricate a target or silently accept the assertion. Open **Edit selected saved test in review form** to investigate or change selectors without editing JSON. This is deterministic, no additional AI model call.

## Human-assisted locator choice

When a step such as `Complete` matches both `Complete preparing a presentation` and `Complete reviewing documentation`, the failure report now includes a structured `ambiguity` array with candidates from the **live DOM**. The UI renders them as selectable options. A tester can pick the intended control and explicitly save a repaired test definition **without editing JSON**.

The original execution stops without taking the ambiguous action. Approval creates a **new** `generated/reviewed-*.json` file and removes the superseded saved version; the chosen correction is then tested by a **fresh Playwright run from step 1**, not a resume of the stopped browser. Follow-up failures are still possible, and their expected values are never rewritten to make them pass.

The local API `POST /api/repair` takes a completed `runId` and a candidate index, validates them against the recorded run, and rejects unknown, missing, truncated or identically named candidate selections. It does not accept arbitrary new selectors. This does not provide full interactive debugging or approval while a session is paused: that is a future milestone.

## Human-reviewed failed text assertions

When the browser successfully finds an element but its text does not match the expected text, **the test fails** and the UI displays **Review failed text assertion**. The reviewer can compare the original expected value with the actual observed text, edit the expected text, and optionally copy the observed text **as a draft only**. The reviewer must explicitly check **I verified this new expected text against the intended requirements** before saving; the UI does not silently turn the actual text into an oracle.

**Save reviewed assertion and rerun from start** calls the local `POST /api/repair-assertion` endpoint with a completed failing run ID, the failed step ID, the revised expected string and explicit human confirmation. The server verifies that the run really failed at that exact **assert-text** step, the original saved test has not changed, and the new text differs from the old expectation. It then saves an amended reviewed JSON file, changes only that assertion's `expected` and `provenance` to `human-confirmed`, removes the superseded saved test, and starts a fresh run from step 1. The original stays available if saving fails. The feature does not modify the web application, suppress other failures or change expected values automatically.

For the two-task demo, `1 tasks, 1 completed` versus observed `1 task, 1 completed` is a test-expected-text mismatch due to singular grammar. However, **observed behaviour alone does not prove correctness**: when an assertion catches a genuine application bug, keep it failing and investigate the application instead. Literal text can depend on task counts, localization, user data, dynamic timestamps or application state. This workflow supports intentional human review of such dynamic values; richer assertion types (e.g. semantic or image validation) are not implemented yet.

## When Groq produces invalid test JSON

GroqCloud's JSON object mode helps ensure syntactically valid JSON, but it does **not** ensure that each `steps[]` entry conforms to our test schema. A common failure for longer scenarios is a mixed array containing executable objects and plain English strings, e.g. `steps[4]: expected object, received string`.

The generator now explicitly instructs the model that **every** array entry must be `{id, description, action}`. If the output is invalid JSON or fails the local Zod schema, the **GroqCloud UI and CLI paths retry at most once** with safe path-specific schema feedback and the original requirements. This can result in **two hosted-model calls for one Generate click**, subject to GroqCloud limits; the UI explains this before generation and states when the retry was used.

If both attempts fail, the UI displays `schema-validation`, `Attempts: 2` and concise paths such as `steps[4]`, without returning model-generated raw text or inventing missing steps. An invalid draft cannot be approved, saved or executed. Safety checks (same-origin navigation, invented `human-confirmed` provenance) still reject even a schema-valid draft without automatic retry. A correction call does not guarantee the generated test is correct or covers all requirements; the tester must review every step.

## Debugging GroqCloud HTTP 400 during generation

If the GroqCloud model rejects a request, the review interface now separates:
- **Local input validation** (HTTP 400 from the local Test Builder)
- **Upstream GroqCloud errors** (Groq may return HTTP 400; the Test Builder responds with HTTP 502 and labels the **provider HTTP status**)
- **JSON/schema generation validation** (HTTP 422 from the Test Builder)

The error panel shows a **safe category**, optional provider error code/type/parameter, and length of the **user's instruction text**. The raw upstream error body is deliberately not echoed or logged, because providers sometimes include user input, credentials, or partial completions. No API key should ever be pasted into a bug report.

For critical [Issue #4](https://github.com/leonard01/ai-ui-testing-agent/issues/4), rerun the exact Test 1 requirements after updating and rebuilding. Capture the *whole error panel*, including source, category, provider status and safe code; if a request succeeds, capture the fact that it succeeded. That evidence is required before attributing the HTTP 400 to length, JSON generation, unsupported model settings or another cause. The test input is far shorter than the 12,000-character local limit.

The CI regression exercises a **mocked** Groq HTTP 400; it does not spend provider tokens and does not establish the cause of the user's original live failure. This issue stays open until a real provider reproduction or successful confirmation.

## Failure diagnoses

Diagnosis is **deterministic**, not a new AI request. Possible categories include assertion mismatch, ambiguous target, locator/timing issue and browser/environment issue. The UI labels likely causes as suggestions, not proven root causes.

- **Assertion failure**: preserve the original expected requirement and compare it with observed text. If the expected value was incorrect, use the human-reviewed text assertion panel to save a new test. Never change an expectation merely to obtain a pass.
- **Locator or intent failure**: inspect the role, name, nearby DOM evidence and captured screenshot; edit the test definition and approve/save a revised copy.
- **Ambiguous target**: the runner stops **without clicking**. When live DOM discovery returns distinct candidate names, the failed step presents radio choices with role and nearby text. Select the intended element and click **Save corrected copy and rerun from start**. The server accepts only a candidate recorded in that failed run, saves a replacement approved JSON file, removes the superseded saved version, and reruns it from step 1. Only that step's target intent changes; **all assertions stay unchanged**. No extra AI model call is made.
- **Identically named targets**: if candidates cannot be distinguished by name (or the candidate list is truncated), the one-click repair is rejected; manually refine the locator. Avoid choosing blindly.
- **Older reports**: runs created before this feature lack structured candidates. Restart the UI after pulling changes and **run the saved test again** to populate the choice list.
- **Browser failure**: inspect the full error and Playwright installation.

Artifacts are accessible through limited local UI routes for runs created in the current server session. No arbitrary filesystem paths can be read through the run-artifact endpoints.

Editing is intentionally small in this first version: field values, locators, descriptions, paths and expected text; adding/removing/reordering steps without regenerating is not yet supported. Revise the instructions and generate another draft to change the overall workflow.

## What it does not do yet

- Direct manipulation of the live page by AI, agentic exploration, multi-page discovery or iterative auto-repair
- Uploading PDF/Word files (use plain text or Markdown for now)
- Appending natural-language instructions into an existing approved JSON case
- Semantic correctness verification, reliable locator validation or guaranteed requirement coverage
- Automatic execution on approval (intentional), test-suite management/history viewer, or a deployed/multi-user server

If the test page does not expose a suitable Add User interface, an input such as **"add user Bob"** might generate a plausible but non-runnable plan. The reviewer must check the target application and expectations. This is why drafts require explicit approval.

## Security and cost notes

- The UI server binds **127.0.0.1:3100 only**, does not expose CORS, requires JSON requests and checks same-origin writes; it is not suitable for a public network deployment without proper authentication and additional defences.
- GroqCloud receives selected test instructions and bounded page data. Do not send credentials, confidential production data or sensitive records.
- API keys are read locally from `.env` by the server and are not embedded in HTML, JSON test definitions or displayed error messages. `.env` is already ignored by Git.
- GroqCloud is subject to provider free-tier rate and token allowances. A **Generate draft** click makes one model call, plus **at most one automatic correction call** when its JSON is malformed or schema-invalid. Test review, saving, and deterministic execution make no AI calls.
- The fixture mode is entirely offline with respect to AI. CI uses this mode and never sends a real GroqCloud request.
- No generated tests are silently executed. Initial draft approval does not automatically mark assertions as `human-confirmed`. The separate failed-assertion review explicitly marks only the revised assertion `human-confirmed` after the tester confirms it against requirements. Execution requires an explicit run request after saving.
- Screenshot and trace files can contain sensitive application data. The local server serves them only on 127.0.0.1 using explicit run IDs, but this prototype should not be exposed beyond loopback.
