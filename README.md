# AI UI Testing Agent

An AI-powered UI testing platform being built to turn requirements or live webpages into test cases, ordered steps and executable scripts, covering the full workflow from test design to execution. Designed for human–AI collaboration, it aims to run tests with or without a traditional UI testing framework and integrate generated tests into existing automation suites.

## Current status

**The structured test runner is implemented and verified in CI. AI functionality is not implemented yet.**

| Item | Current position |
| --- | --- |
| Latest implementation | `main` |
| Review | [Pull request #1](https://github.com/leonard01/ai-ui-testing-agent/pull/1), merged |
| Default branch | `main` includes the structured runner, demo and current instructions |
| Verification | **13 checks passed:** 7 validation/CLI checks and 6 browser integration checks |
| Evidence | [Successful runner CI run](https://github.com/leonard01/ai-ui-testing-agent/actions/runs/44742359816) |
| Stack | TypeScript, Playwright/Chromium, Node.js and GitHub Actions |

### What you can use now

| Capability | Implemented behaviour |
| --- | --- |
| JSON test cases | Edit steps and expected results without writing a Playwright test |
| Validation | Reject malformed cases, unsupported actions, duplicate step IDs and missing assertions before opening the browser |
| Browser actions | Navigate, click and fill |
| Assertions | Check exact normalized text and element visibility |
| Target descriptions | Exact role/name, label or text matching |
| Isolated runs | Start each case in a fresh browser context |
| Visible execution | Use `--headed` to watch Chromium locally |
| Results | JSON verdict, individual step outcomes, timings and expected/observed text |
| Failure handling | Stop at the first failure and mark later steps as skipped |
| Failure evidence | Attempt to save a screenshot and browser trace; record evidence-capture errors separately |
| Demo application | Add, complete and delete tasks on a local webpage |
| CI | Type-check, compile, run unit/browser checks and upload reports |

The example case has nine steps covering an empty list, adding a task, checking visibility, marking it complete, checking the count, deleting it and checking the empty state again.

### Not implemented yet

- AI-generated test cases, with or without supplied requirements.
- AI discovery of workflows or interpretation of browser targets.
- Recording a user's interactions into a test case.
- Execution speed controls, pause/resume, single-step, skip and manual takeover.
- A test-management interface or editing existing tests by demonstration.
- Exporting cases as standalone TypeScript scripts.
- API, mobile and load testing, or additional language exporters.

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

Run these commands from the repository root:

```bash
npm ci
npx playwright install --with-deps chromium
npm run typecheck
npm run build
```

The build creates `dist/`. Rebuild after changing TypeScript source. Editing a JSON case does not require a rebuild.

### 3. Start the demo

In your first terminal:

```bash
npm run demo
```

Leave that terminal running. Open [the task-list demo](http://127.0.0.1:3000) to use it manually. Every page load starts with an empty list.

### 4. Run the example test

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

## Run the automated checks

After installation and building:

```bash
npm run test:unit
npm test
```

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

## Case format and current limits

A case contains `schemaVersion`, `id`, `title`, `version` and ordered `steps`. Each step has an ID, description and action. See the [complete example](examples/add-task.json).

- Supported actions: `navigate`, `click`, `fill`, `assert-text` and `assert-visible`.
- The first step must navigate; every case must contain an assertion and have unique step IDs.
- Assertions specify expectation provenance: `requirements`, `human-confirmed` or `inferred`. The runner preserves the supplied case's meaning; it does not infer correctness.
- Text assertions compare text content after collapsing whitespace.
- Targets must identify one element. A missing or ambiguous target is an execution error.
- Navigation and network requests are limited to the configured HTTP(S) application origin. Applications requiring third-party resources are outside this milestone's scope.
- Each case starts a fresh session. Authentication setup, reusable data fixtures and multi-user workflows remain future work.
- Headed mode is implemented; the automated CI checks run headlessly.

## Direction and next milestones

The long-term goal is to let a QA engineer design, demonstrate, execute and maintain tests through an AI-assisted interface while retaining editable definitions, reviewable changes and portable code exports.

The next steps are to build AI generation and target resolution on the structured runner, then add recording, interactive execution controls and TypeScript export. The separate functionality tracker records accepted, proposed, deferred and rejected items alongside release and delivery status.

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
