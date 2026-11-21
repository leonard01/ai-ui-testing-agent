# AI UI Testing Agent

An AI-powered UI testing platform being built to turn requirements or live webpages into test cases, ordered steps and executable scripts, covering the full workflow from test design to execution. Designed for human–AI collaboration, it aims to run tests with or without a traditional UI testing framework and integrate generated tests into existing automation suites.

## Current status

**Last repository review:** 21 November 2026. PRs #3, #11, #12 and #13 are merged into `main`. Standalone Playwright TypeScript export is in development on `feature/playwright-typescript-export`.


**The main branch now includes the structured runner, AI draft generation, local review UI, and human-assisted failure repair. Real-model generation quality still needs benchmarking.**

| Item | Current position |
| --- | --- |
| Latest implementation | `main` |
| Most recent merged feature | [Pull request #13](https://github.com/leonard01/ai-ui-testing-agent/pull/13), sequential test suite execution |
| Default branch | `main` includes the runner, AI generation, review UI and repair controls |
| Verification | Automated unit and browser integration tests; see Actions for the latest results |
| Evidence | [Successful PR #3 CI run](https://github.com/leonard01/ai-ui-testing-agent/actions/runs/44900395935) |
| Stack | TypeScript, Playwright/Chromium, Node.js and GitHub Actions |

### What you can use now

**Current workflow:** describe a test in plain English → optionally generate an AI draft → review and approve structured steps → run Playwright deterministically → diagnose, repair and rerun. You can also edit and execute JSON directly without AI.


| Capability | Implemented behaviour |
| --- | --- |
| JSON test cases | Edit steps and expected results without writing a Playwright test |
| Validation | Reject malformed cases, unsupported actions, duplicate step IDs and missing assertions before opening the browser |
| Browser actions | Navigate, click, fill, native dropdown select, check/uncheck and permitted keyboard keys |
| Assertions | Check exact normalized text, visibility, URL and matched-element counts |
| Target descriptions | Exact role/name, label or text matching |
| Isolated runs | Start each case in a fresh browser context |
| Visible execution | Use `--headed` to watch Chromium locally |
| Results | JSON verdict, individual step outcomes, timings and expected/observed text |
| Failure handling | Stop at the first failure and mark later steps as skipped |
| Failure evidence | Attempt to save a screenshot and browser trace; record evidence-capture errors separately |
| Demo application | Add, complete and delete tasks on a local webpage |
| CI | Type-check, compile, run unit/browser checks and upload reports |

The example case has nine steps covering an empty list, adding a task, checking visibility, marking it complete, checking the count, deleting it and checking the empty state again.

### Requirements-to-test generation (on main)

The application includes a **review-first** test generator. A bounded browser snapshot plus optional Markdown/plain-text requirements yields a schema-validated JSON draft; **no draft is executed automatically**.

Choose where its output comes from:

| Generation provider | What it tests | API credits |
| --- | --- | --- |
| `fixture` | The full integration pipeline with a **prewritten** test, no AI | **None** |
| `ollama` | Actual AI-generated JSON using a locally running model | **None** (hardware costs apply) |
| `groq` | Actual AI-generated JSON using GroqCloud's hosted free-tier model | **Groq free tier** (account limits apply) |
| `openai` | Actual AI-generated JSON using an optional cloud model | **Paid usage** |

```bash
# Start the demo in another terminal: npm run demo
npm run build

# First test at zero cost; the output is a fixture, NOT AI-generated:
npm run generate -- generate --provider fixture --requirements examples/requirements-task-list.md --output generated/fixture-draft.json

# Inspect/approve the JSON first, then execute:
npm run agent -- run generated/fixture-draft.json --headed

# Optional REAL local AI after installing Ollama and pulling qwen2.5-coder:3b:
npm run generate -- generate --provider ollama --model qwen2.5-coder:3b --requirements examples/requirements-task-list.md --output generated/ollama-draft.json

# Recommended for older laptops: put GROQ_API_KEY="gsk_..." in .env (never commit it).
# The generator loads .env automatically; no Ollama or extra npm package is needed:
npm run generate -- generate --provider groq --model openai/gpt-oss-20b --requirements examples/requirements-task-list.md --output generated/groq-draft.json
```

The OpenAI option remains available via `--provider openai`, but AI inference is never required to run an approved test. CI mocks all model providers and makes no real hosted-model request; it verifies tooling, not live-model quality. See [all four setup paths and limitations](docs/requirements-generation.md).

### Live DOM discovery for intent-based test steps (on main)

The runner now supports a selector-free **intent target**, resolved against the DOM **when that step executes**:

```json
"target": { "by": "intent", "value": "Add task", "role": "button" }
```

Playwright examines relevant visible elements and their nearby text, checks uniqueness, and records the verified match in the step's `resolution` section of `report.json`. Ambiguous or missing matches stop safely rather than guess. This supports dynamically created controls and poorly associated labels, while existing role/label/text targets remain compatible. AI drafting is instructed to prefer intent targets when element details are unknown.

```bash
# Terminal 1: npm run demo
# Terminal 2:
npm run agent -- run examples/task-intent.json
```

[Architecture, example, limits and evidence format](docs/targeted-dom-discovery.md).

### Human-reviewed text assertions (on main)

When a text assertion fails, the Test Builder shows **expected vs observed** and lets the tester edit the expected text. A **Use observed text as draft** shortcut is provided, but the change requires explicit confirmation that the new expectation matches the requirements. **Save reviewed assertion and rerun from start** creates a *new* saved test, marks only the revised assertion as `human-confirmed`, removes the superseded saved version and reruns from step 1. No model call is required, and the application output is **never accepted automatically**.

### Amended saved tests replace failed versions

The UI no longer accumulates failed saved-test revisions. Saving a correction first writes the new test, then removes the superseded entry from the dropdown and discards its completed run artifacts from the current session. Failed saves leave the original untouched; newly generated unrelated tests remain separate.

### Editable DOM search on failed assertions

A failed assertion now offers a **Search visible DOM text** field alongside discovered candidates. Enter or refine a phrase, click **Search captured DOM**, inspect verified uniquely addressable matching elements, and explicitly choose the corrected selector. The app searches a bounded in-memory DOM snapshot captured at the failure, without replaying prior actions or using Groq. It does **not** change the assertion's expected result: that remains a separate explicitly reviewed operation. A saved repair replaces the failed script, rather than creating clutter.

### Full-page visible-text recovery for incorrect assertion targets

An exact text assertion may find an element but find the **wrong one** (e.g. expected `Sauce Labs Backpack` while a button displays `Add to cart`). At failure time, the agent searches visible page text across regular elements such as product-name `div` blocks, verifies any suggested selector is unique and visible, and offers **Find assertion target in live DOM**. The tester can choose the correct text element through the UI; the expected result never changes automatically. Exact DOM text is required; when absent, the assertion remains failed.

### Failed assertion DOM search (on main)

If a visibility/text assertion uses the wrong role or locator, the failed-step UI searches the **live DOM** for the requested text. For example, `getByRole("heading", {name:"Products"})` can be repaired by selecting a verified visible `<span>Products</span>` through **Find assertion target in live DOM**. The choice updates only the selector (never the expected assertion), supersedes the failed saved version and reruns the scenario. It does not auto-pass the test and does not use a model call.

### UI-only test editing and repair (on main)

**No manual JSON changes required.** A saved test can be reopened from **Execute and diagnose → Edit selected saved test in review form**, corrected with human-readable fields, reconfirmed and saved as a replacement. The old entry is removed only after successful saving. When an explicit locator finds no element (e.g. `getByLabel("Add")` for a button), the failed execution also offers **Choose a replacement element** from uniquely verified live DOM candidates. The tester chooses the intended element; the application saves a corrected copy and reruns. The runner never guesses or changes assertions.

### Human-assisted locator choice (on main)

If live DOM discovery finds several equally plausible elements, it **stops before acting** and records structured candidate details in the execution report. The Test Builder now displays radio-button choices with the element names, roles and nearby text. Selecting the correct one and clicking **Save corrected copy and rerun from start** saves a corrected test, removes the superseded saved version, and starts a fresh deterministic Playwright run.

This preserves expected results and requires human selection; no AI model call is needed to repair the locator. Candidates with indistinguishable names or truncated lists still require a manual locator correction. A fresh run is required after updating the app to produce structured choice data; earlier reports cannot be repaired directly.

[Human-assisted locator workflow and limits](docs/test-review-ui.md).

### Plain-English test review UI (early MVP, on main)

For testers who don't want to write Markdown files and edit raw JSON, the project includes a **local web interface** for natural-language test drafting and review.

```bash
# Terminal 1: demo application
npm run demo

# Terminal 2: lightweight review server, after npm run build
npm run review
```

Open **http://127.0.0.1:3100/**. Enter an instruction such as **"Add a task called Prepare interview; verify it appears; complete it and delete it."** or import a `.txt`/`.md` file. Choose GroqCloud (hosted model) or Fixture (prewritten no-AI example). The result is a **plain-English ordered step preview** with locator details, expected outcomes and provenance. Testers can edit individual fields, verify each step and explicitly approve saving the draft JSON.

**Saving doesn't execute any tests.** After approval, use the new **3. Execute and diagnose** panel to select an approved saved case and click **Run selected test** (or use the CLI). The interface runs deterministic Playwright, displays pass/fail details for every step, expected/observed assertion values, locator-discovery evidence, and a likely cause and next action when a step fails. Where available, you can view the failure screenshot, download the Playwright trace, or open the full JSON report **without using the command line**. The `GROQ_API_KEY` stays on the local server; executing saved tests does not require another model call.

Runs are intentionally **explicit, headless and serialized** so the older laptop does not have several Chromium instances competing for memory. The UI lists existing approved `generated/reviewed-*.json` tests after restarting. Real Groq model accuracy and workflows on arbitrary sites still need evaluation.

[Full interface instructions, limitations, and security notes](docs/test-review-ui.md).

### Pre-execution selector validation (new feature branch)

In the draft review UI, **Check selectors (read-only)** inspects the starting page in an isolated browser context. It checks explicit role/name, label, and text locators for uniqueness and visibility. For example, a missing `getByLabel("Add")` can produce a grounded suggestion to inspect an existing **button named Add**.

This optional check does **not** click, fill, replay steps, modify expectations or targets, call a model, or approve any test. Locators for dynamic elements after clicks/fills or further navigation may be **deferred**. Results are warnings, not proof of test success, and they are invalidated when fields are edited.

This feature is merged into `main` through PR #11.

### Broader browser actions and assertions (new feature branch)

The structured runner, AI generator prompt and human review editor now recognise six additional action kinds:

| Action | Behaviour and supported fields |
| --- | --- |
| `check` / `uncheck` | Set native checkbox state explicitly; `check` also works for radio inputs |
| `select-option` | Choose a native dropdown option by **value** |
| `press` | Press an allowed keyboard key on a focused target (e.g., `Enter`, `Tab`, `ArrowDown`) |
| `assert-url` | Wait for the current URL to equal an expected same-origin URL or relative path, including query/hash |
| `assert-count` | Wait for the exact number of elements matching an explicit role/label/text locator, including zero matches |

For example, a valid test can contain:

```json
{"id":"delivery","description":"Choose express delivery","action":{"kind":"select-option","target":{"by":"role","role":"combobox","name":"Shipping"},"value":"fast"}}
```

Counts use Playwright locator matching, without an extra visibility filter; role locators normally exclude accessibility-hidden elements. A count assertion intentionally **cannot** use an intent target, because live intent resolution requires one unique element. Check and select target resolution happens at execution time. All assertions keep provenance, and a wrong expected URL/count is a genuine assertion failure with expected/observed evidence. The actions do not automatically execute until the tester approves and runs the saved case.

**Development status:** merged into `main` through PR #12.

### Sequential test-suite execution (new feature branch)

In **3. Execute and diagnose → Run a test suite**, select 1–10 approved saved tests and click **Run selected suite**. The application validates **all** saved scripts and same-origin navigation targets before the first browser run. Tests execute **sequentially**, each with a new isolated browser context. An assertion or execution error in one case does **not** stop the remaining cases.

The live suite dashboard displays progress, per-test verdicts, completed counts, total passes/failures, and duration. **View details** opens the original per-step report, screenshot and trace in the existing diagnosis panel, including human-approved repair functionality. You can also open a consolidated JSON report; an additional report file is saved to `run-results/suites/<suite-id>/report.json`.

Suite runs share the same execution lock as single-test runs and selector preflight, so they cannot compete for browser resources on slower laptops. A pending case cannot be replaced while its suite is running. Execution requires an explicit click, uses the saved approved JSON files, and makes no model requests. Suite history remains available **in the current server session**; reloading history after server restart remains a future task.

This feature is merged into `main` through PR #13.

### Standalone Playwright TypeScript export (new feature branch)

The UI now has **Export Playwright (.spec.ts)** beside each selected approved test. The downloaded file imports only `@playwright/test`, contains one readable `test.step` per reviewed step and runs **without this agent, GroqCloud, the JSON file or a custom runtime module**. It translates role/label/text targets to normal Playwright locators; live DOM **intent** targets use an embedded deterministic helper rather than another AI call.

All current runner actions and assertions have translations, including select/check/keyboard/URL/count. The exporter preserves expected results and assertion provenance, converts same-origin absolute URLs into environment-portable paths, and lets users override the base URL with `TEST_BASE_URL` in another project. No test executes during export. You can also export from the CLI:

```bash
npm run agent -- export examples/add-task.json --base-url http://127.0.0.1:3000 --output generated/add-task.spec.ts
```

A real exported file is exercised by the automated Playwright suite. See [full export instructions, limitations and security notes](docs/playwright-export.md). The feature remains on `feature/playwright-typescript-export` until its pull request is verified and merged.

### Not implemented yet

- Fully evaluated AI generation quality (including live GroqCloud model output), automatic approval or autonomous multi-page exploration (first generator is a review-only draft).
- AI discovery of workflows or interpretation of browser targets.
- Recording a user's interactions into a test case.
- Execution speed controls, pause/resume, single-step, skip and manual takeover (the review UI provides limited per-step timeout selection).
- Full project management, step reordering, appending natural-language instructions to an existing case or editing by demonstration (the early draft review UI supports field edits only).
- Exporting to frameworks other than Playwright (standalone Playwright TypeScript is now available on the feature branch).
- API, mobile and load testing, or additional language exporters.\n- Advanced keyboard chords, rich multiselect semantics, and visual assertions.

The current runner executes explicitly authored cases. Its data contracts and browser actions provide the execution layer for these later capabilities.

## Quick start

**Requirements:** Node.js 22 or later, npm and a computer that can run Chromium. Use Node.js 22 to match CI. No model account or API key is required.

### 1. Get the project

For a new checkout:

```bash
git clone https://github.com/leonard01/ai-ui-testing-agent.git
cd ai-ui-testing-agent
```

If you already have a checkout, switch to `main` and pull the merged changes:

```bash
git switch main
git pull --ff-only
```

### 2. Install and build

Open **VS Code → Terminal → Git Bash** on Windows, or a shell of your choice on macOS/Linux. Run the following in the repository root:

```bash
node --version
npm --version
npm ci
npx playwright install chromium
npm run typecheck
npm run build
```

Node.js 22 or newer is required. If `npm` is not found on Windows despite installing Node.js, restart VS Code so its terminal inherits the new PATH. On Linux CI, the workflow uses `npx playwright install --with-deps chromium` to install operating-system libraries as well.

`npm ci` uses the committed lockfile. The build creates `dist/`. Rebuild after changing TypeScript source; editing a JSON case does not require rebuilding.

The build creates `dist/`. Rebuild after changing TypeScript source. Editing a JSON case does not require a rebuild.

### 3. Start the demo

In your first terminal:

```bash
npm run demo
```

Leave that terminal running. Open [the task-list demo](http://127.0.0.1:3000) to use it manually. Every page load starts with an empty list.

### 4. Run the example test

**This is an executable browser test, not just a Playwright installation check.** Its nine JSON-defined steps cover initial state, adding a task, completion and deletion, with assertions along the way.


In a second terminal, from the same repository root:

```bash
npm run agent -- run examples/add-task.json --headed
```

Chromium opens, performs the nine-step case and closes when the run ends. The terminal prints the result and report path.

For a headless run, omit `--headed`:

```bash
npm run agent -- run examples/add-task.json
```

Edit [examples/add-task.json](examples/add-task.json) to change the steps, task name or expected results, then rerun the command. The case is executed directly; no generated test script is involved.

## Modify and rerun an existing test

Tests are defined in plain JSON. Open [`examples/add-task.json`](examples/add-task.json) and change a test value, description or expected result. For instance, the initial status assertion currently uses:

```json
{
  "kind": "assert-text",
  "target": { "by": "role", "role": "status" },
  "expected": "0 tasks, 0 completed",
  "provenance": "human-confirmed"
}
```

Change the expected status to an incorrect value such as `"99 tasks, 0 completed"`, save the JSON and run the example again. The runner should report `assertion-failed`, include expected/observed text, stop before later actions, and attempt to save a screenshot and trace.

**Do not commit deliberate failures to `main`.** Undo experimental edits after testing. JSON tests can also be edited in the review UI; editing by demonstrating browser interactions is planned but not implemented.

## Run the automated checks

After installation and building:

```bash
npm run typecheck
npm run build
npm run test:unit
npm test
```

Run the Playwright tests in its interactive UI if you prefer:

```bash
npm run test:ui
```

The test UI controls **the project's automated checks**, not the proposed human–AI takeover interface.

The browser suite starts the demo server automatically. Locally, it can reuse an already-running demo on port 3000. You do not need to start the demo separately for these checks.

| Check group | What it verifies |
| --- | --- |
| 7 validation/CLI checks | Valid and invalid schemas, unique IDs, required assertions, navigation boundaries, error reports and unreadable files |
| 6 browser integration checks | Task lifecycle and fresh sessions, incorrect expectations, missing targets, failure artifacts, CLI success/failure exit codes and the original smoke test |

Tests that deliberately supply an incorrect expectation pass when the runner correctly reports an assertion failure. They do not change the expectation to make the case pass.

GitHub Actions runs on pushes to `main`, pull requests and manual dispatch. It uploads HTML/JUnit reports and test output as the `playwright-results` artifact. The original foundation and this runner milestone have both been verified in CI.

## CLI options and results

```bash
npm run agent -- run examples/add-task.json --base-url http://127.0.0.1:3000 --timeout 5000 --output run-results/demo --headed
```

| Option | Purpose | Default |
| --- | --- | --- |
| `--base-url` | Application origin and base for relative navigation | `http://127.0.0.1:3000` |
| `--timeout` | Timeout per action/assertion, in milliseconds; 1–60000 | `5000` |
| `--output` | Report and evidence directory | A unique directory inside `run-results/` |
| `--headed` | Show the browser locally | Off |

Use a separate output directory for concurrent runs. Reusing an explicit directory replaces its report.

| Output | When produced |
| --- | --- |
| `report.json` | Test-case runs, including file-read, validation and browser-launch errors, when the output directory is writable |
| `failure.png` | Attempted on a failed run after a browser page has been created |
| `trace.zip` | Attempted on a failed run after tracing has started |

The report distinguishes `passed`, `assertion-failed` and `execution-error`. Later steps become `skipped` after the first failure. Evidence-capture errors are recorded separately. Invalid CLI usage and report-writing errors are printed to the terminal.

To inspect a failed run saved to `run-results/demo`:

```bash
npx playwright show-trace run-results/demo/trace.zip
```

For the automated suite's HTML report:

```bash
npx playwright show-report
```

| Exit code | Meaning |
| --- | --- |
| 0 | All steps and assertions passed |
| 1 | An assertion failed |
| 2 | Invalid input, missing target or another execution error |

## Troubleshooting (Windows / VS Code)

| Symptom | What to check |
| --- | --- |
| `npm: command not found` | Install Node.js 22+ (npm is bundled), restart VS Code, then check `node --version` and `npm --version` |
| Browser executable is missing | Run `npx playwright install chromium` in the repository directory |
| `Cannot find module dist/...` | Run `npm run build` and confirm you're in the repository root |
| `EADDRINUSE` for port 3000 | Close the earlier demo terminal or stop the process already using port 3000 |
| Test exits with code 1 | Check the assertion's `expected` and `observed` values in its `report.json` |
| Test exits with code 2 | Check for invalid JSON, an unsupported action, missing/ambiguous target, navigation boundary or browser error |
| `trace.zip` missing on a passing test | Expected: the structured runner saves failure traces, not traces for passing runs |
| Generated JSON from AI not available | Check the review UI and your GroqCloud key; Fixture mode replays a prewritten test rather than generating a new one |

## Case format and current limits

A case contains `schemaVersion`, `id`, `title`, `version` and ordered `steps`. Each step has an ID, description and action. See the [complete example](examples/add-task.json).

- On `main`: `navigate`, `click`, `fill`, `assert-text` and `assert-visible`. This feature branch adds `check`, `uncheck`, `select-option`, `press`, `assert-url` and `assert-count`.
- The first step must navigate; every case must contain an assertion and have unique step IDs.
- Assertions specify expectation provenance: `requirements`, `human-confirmed` or `inferred`. The runner preserves the supplied case's meaning; it does not infer correctness.
- Text assertions compare text content after collapsing whitespace.
- Targets must identify one element. A missing or ambiguous target is an execution error.
- Navigation and network requests are limited to the configured HTTP(S) application origin. Applications requiring third-party resources are outside this milestone's scope.
- Each case starts a fresh session. Authentication setup, reusable data fixtures and multi-user workflows remain future work.
- Headed mode is implemented; the automated CI checks run headlessly.

## Development status and next milestones

| Milestone | Status |
| --- | --- |
| Project setup, TypeScript, Playwright and GitHub Actions | Implemented |
| Structured JSON runner, validation, browser evidence and demo | Implemented and CI-verified |
| Generate a reviewable test from requirements or a page snapshot | Implemented on `main` (quality still being evaluated) |
| Read-only starting-page selector preflight | Feature branch, not merged |
| Record test steps from human browser use | Planned |
| Edit an existing test by observing a user's corrections | Planned |
| Live human ↔ AI browser handoff and playback controls | Planned |
| Export independent Playwright TypeScript scripts | Implemented on feature branch, not yet merged |

Requirements-to-test generation and reviewed failure repair are now on `main`. The preflight feature remains separate until verified.

## Direction and next milestones

The long-term goal is to let a QA engineer design, demonstrate, execute and maintain tests through an AI-assisted interface while retaining editable definitions, reviewable changes and portable code exports.

Next priorities are selector preflight, broader browser actions, test-suite execution and TypeScript export; recording and interactive handoff remain future work. The separate functionality tracker records accepted, proposed, deferred and rejected items alongside release and delivery status.

Design principles:

- Keep humans in control of browser ownership and changes to expected behaviour.
- Distinguish observed behaviour from specified or confirmed behaviour.
- Preserve assertions and evidence rather than silently weakening checks.
- Prefer repeatable execution and use AI reasoning where it adds value.
- Keep the test representation independent of its browser backend.

## Project structure

```text
.github/workflows/ci.yml     TypeScript, unit and browser integration checks
src/domain.ts               Test, step, report and session types
src/schema.ts               Strict validation of JSON test definitions
src/runner.ts               Structured browser execution and evidence
src/cli.ts                  Command-line entry point
src/demo/server.ts          Local demo server
src/index.ts                Public exports
demo/index.html             Application under test
examples/add-task.json      Editable nine-step lifecycle case
tests/runner.spec.ts        Browser and CLI integration checks
tests/unit/schema.test.mjs  Validation and pre-browser rejection checks
tests/smoke.spec.ts         Browser tooling smoke test
```

## Contributions

Feedback, issues and discussion are welcome.
