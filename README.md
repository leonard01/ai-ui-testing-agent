# AI UI Testing Agent

**v0.1 prototype · AI-assisted requirements-to-test execution · Human-reviewed · Playwright-powered**

Turn plain-English test instructions and a live web page into reviewable test steps, save them as structured test scripts, run them in a browser, diagnose failures, and approve corrections—all from a local web interface. The aim is to make the complete QA workflow demonstrable while keeping expectations and test changes under human control.

**Status:** v0.1 functionality is implemented on `main`. This is a **working prototype / release candidate**, not a production-ready autonomous tester. A formal GitHub release/tag and final manual acceptance check are separate steps.

**Jump to:** [Current functionality](#current-functionality) · [Quick start](#quick-start) · [Example workflow](#example-workflow) · [CLI and automation](#cli-and-automation) · [Limitations](#limitations-and-v01-scope) · [Detailed docs](#documentation)

## Current functionality

Everything in this table is **implemented on `main`**, not a proposed feature.

| Area | What works in v0.1 |
| --- | --- |
| **AI-assisted test design** | Enter plain-English requirements and an application URL. Inspect a bounded snapshot of the live page and generate a structured test draft with **GroqCloud**. Use **Fixture** mode for a completely offline, prewritten demonstration (no AI). |
| **Human review and editing** | Read every proposed step in plain English, edit its action/locator/value/expectation, confirm steps individually or use **Add All**, then explicitly **Approve and save JSON test**. Generation and Add All never save or execute automatically. |
| **Structured test scripts** | Store validated, framework-neutral JSON definitions, including action steps, assertion provenance, optional requirement links and the originating website URL. Reject malformed definitions before browser execution. |
| **Website test suites** | Group approved scripts by website origin (scheme, host and port). Select a website and see **only its scripts** in both single-test and batch selectors. Edit/delete a script, or delete a website suite, with confirmation. Older unassigned scripts remain accessible. |
| **Browser execution** | Run one approved script or **1–10 scripts sequentially** in isolated Playwright Chromium contexts. Supported actions: navigate, click, fill, press keys, check/uncheck and select a native dropdown option. |
| **Assertions and diagnostics** | Verify exact normalized text, visibility, URL and element counts. Display step-by-step pass/fail, timings and expected/observed values; attempt screenshots and Playwright traces on failures. |
| **Selector inspection and repair** | Run read-only selector preflight; locate targets from explicit roles, labels, placeholders, visible text or live DOM intent. Show human-reviewable alternatives for missing/ambiguous locators and failed assertions. Distinguish blocked clicks from selector failures. Approved repairs save a corrected script and rerun from step 1. |
| **Requirements traceability** | Optionally link requirements to steps/assertions **manually**, show coverage gaps and view/export a read-only requirements matrix. AI cannot claim human-confirmed mappings. |
| **Playwright export** | Download a standalone `.spec.ts` for an approved script or export via CLI. Generated specs run with `@playwright/test`, without this agent or an AI service. |
| **Execution history** | Review completed executions **by website suite** at the bottom of the UI. History is collapsed behind **Show History**, filtered by website and paginated **10 at a time**. Reopen saved results after restarting; **Delete All History** clears run artifacts without deleting approved scripts. |
| **Developer workflow** | TypeScript, Node.js, local demo application, command-line runner/generator/exporter and GitHub Actions type-check, unit and Playwright browser tests. |

**Important terminology:** A **test suite** is a website's collection of saved **test scripts**. A **suite execution** is one occasion on which you run one script or a selected batch. A test can fail without stopping other scripts in the same batch.

The **structured JSON definition** is framework-neutral; **the v0.1 browser runner itself uses Playwright**. A framework-free execution backend is a future goal, not a current capability.

## Quick start

**Requirements:** Node.js **22+**, npm and Chromium (installed through Playwright). No API key, AI subscription or locally hosted model is needed for the Fixture demo.

### 1. Install

```bash
git clone https://github.com/leonard01/ai-ui-testing-agent.git
cd ai-ui-testing-agent
npm ci
npx playwright install chromium
npm run build
```

For an existing checkout, run `git switch main`, `git pull --ff-only` and `npm run build` instead. Run `npm ci` again if dependencies have changed.

### 2. Start the demo website

In **terminal 1**:

```bash
npm run demo
```

The local task-list application is at **http://127.0.0.1:3000**. Use this for a reliable first test; you can later supply a different application URL.

### 3. Start the testing UI

In **terminal 2**, from the same repository:

```bash
npm run review
```

Open **http://127.0.0.1:3100**.

### 4. Create and run your first test

1. Enter `http://127.0.0.1:3000` as the **Application URL**.
2. Describe a task such as **“Add a task called Prepare interview, verify it appears, complete it, then delete it and verify the list is empty.”**
3. Set **Generate with → Prewritten demonstration (Fixture)** and choose **Generate draft**. This is a fixed test fixture—not a real AI response.
4. In **Review proposed steps**, inspect and edit the draft. Tick confirmations individually or click **Add All**. Click **Approve and save JSON test**.
5. Under **Run Tests**, select the website test suite and its approved test script, then click **Run selected test**. You can also select several scripts from that website and click **Run selected suite**.
6. Examine the step results. On a failure, review the diagnostic evidence and any suggested corrections; the tool never silently changes an expected result.

**Saving is not execution.** Each test run requires a separate action. The browser runs headlessly from the UI, and test execution does **not** call an AI model.

## Example workflow

```text
Requirements / application URL
        ↓
Optional AI-generated or Fixture draft
        ↓
Review, edit and approve steps (or Add All)
        ↓
Save approved JSON test script
        ↓
Choose website test suite → run one or several scripts
        ↓
Inspect pass/fail results, screenshots and traces
        ↓
Human-approved locator/expectation correction → rerun
        ↓
Reopen execution history or export standalone Playwright spec
```

**Real AI generation:** In the UI choose **GroqCloud** and configure `GROQ_API_KEY` in a local `.env` file or your environment. Groq's free tier has provider-imposed limits; availability and quotas can change. The key remains in the local server and should **never** be committed. In the CLI, you can also explicitly choose **Ollama** (local model) or **OpenAI** (usage may incur charges). No cloud provider is selected automatically.

## CLI and automation

The UI is optional; the same repository supports direct JSON execution and export:

```bash
# Run the existing nine-step local-demo case (demo server must be running)
npm run agent -- run examples/add-task.json

# Watch the browser
npm run agent -- run examples/add-task.json --headed

# Export portable Playwright TypeScript (does not execute it)
npm run agent -- export examples/add-task.json --base-url http://127.0.0.1:3000 --output generated/add-task.spec.ts

# Generate a draft without contacting AI
npm run generate -- generate --provider fixture --requirements examples/requirements-task-list.md --output generated/fixture-draft.json

# Type-check, build, unit tests, and browser integration tests
npm run typecheck
npm run build
npm run test:unit
npm test
```

Run results are saved under `run-results/` by default. Successful runs report `passed`; failures distinguish `assertion-failed` from `execution-error`. Later steps are marked `skipped` after a failure. Failure screenshots (`failure.png`) and traces (`trace.zip`) are captured when available; evidence-capture failures are recorded separately.

Run a saved trace with `npx playwright show-trace path/to/trace.zip`. The browser test suite uses its own isolated fixtures and can start the local demo automatically.

**CI:** GitHub Actions runs type-checking, the build, unit tests and Playwright integration tests. The [v0.1 polish PR](https://github.com/leonard01/ai-ui-testing-agent/pull/26) passed **80 browser tests** before merging; see [GitHub Actions](https://github.com/leonard01/ai-ui-testing-agent/actions) for the latest verification.

## Limitations and v0.1 scope

This release is meant to **demonstrate an end-to-end QA workflow**, not replace mature testing frameworks yet.

- **Playwright-backed execution only.** Additional runner backends, framework integrations and exporters beyond Playwright are not yet implemented.
- **Human oversight is required.** AI-generated steps and expectations can be incorrect. `Add All` is a bulk reviewer action, not independent validation. A green execution does not prove that requirements were specified correctly.
- **Live AI quality is not benchmarked.** CI uses fixtures/mocks rather than paid model calls. Real hosted-model output and reliability on arbitrary websites need further evaluation.
- **Web UI testing only.** No API/mobile/load testing, automatic exploration, recording browser interactions or interactive human–AI browser takeover in v0.1.
- **Protected production websites are not reliable demo targets.** The tool does not bypass CAPTCHA, robot checks, access controls or anti-bot protection. Prefer test environments and official test fixtures.
- **Selector repairs can be fragile.** Numbered choices for identically named elements rely on DOM order and can break if the page changes. Human approval and subsequent reruns remain necessary.
- **Execution history is operational, not an immutable audit log.** Replacing a saved test may remove the superseded test and some related evidence. Removing an approved website suite does **not** automatically erase its history; **Delete All History** is a separate, global action.
- **Single browser execution at a time.** Suite runs are serial and use isolated contexts, intentionally reducing pressure on less powerful machines. The UI is a local development tool, not a hosted multi-user service.

**v0.1 release criterion:** Merge the final polish, complete a real-model generation → review → save → execution smoke test, and publish a `v0.1.0` GitHub release with known limitations. The package is versioned `0.1.0`, but a GitHub release/tag is **not implied** by this README.

## Documentation

| Guide | Focus |
| --- | --- |
| [Test review UI](docs/test-review-ui.md) | Step editing, Add All, execution and human-assisted repairs |
| [Requirements generation](docs/requirements-generation.md) | Groq, Ollama, OpenAI and Fixture configuration |
| [Website test suites](docs/website-test-suites.md) | Suite grouping, saved script organization and deletion |
| [Execution history](docs/persistent-history.md) | Restart recovery, pagination, deleting history and storage |
| [Standalone Playwright export](docs/playwright-export.md) | Portable specs and running them in another project |
| [Requirements traceability](docs/requirements-traceability.md) | Human-mapped requirements and coverage reports |
| [Live DOM discovery](docs/targeted-dom-discovery.md) | Intent locators, ambiguity and selector evidence |

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `npm` not recognized | Install Node.js 22+ and reopen your terminal |
| Chromium missing | Run `npx playwright install chromium` |
| `Cannot find module dist/...` | Run `npm run build` |
| Port 3000 or 3100 already in use | Stop the previously running demo/review server |
| Test reports `assertion-failed` | Compare the approved expected and observed values |
| Test reports `execution-error` | Check selector ambiguity, blocked clicks, timeouts or off-origin navigation |
| Real AI generation unavailable | Check the configured provider/key; Fixture needs no AI credentials |
| Robot check appears | Use an automation-friendly test environment; bypassing bot checks is out of scope |

## Contributing

Feedback, defect reports and reproducible examples are welcome through [GitHub Issues](https://github.com/leonard01/ai-ui-testing-agent/issues).

**Guiding principles:** explicit approvals; test expectations from requirements rather than observed bugs; reproducible browser runs; clear failure evidence; optional AI assistance; and portable, reviewable test definitions.
