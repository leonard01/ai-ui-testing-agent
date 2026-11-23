# AI UI Testing Agent

**v0.2.0 release candidate · AI-assisted browser test creation, review and execution · Playwright-powered**

**Describe a test in plain English, generate proposed browser steps, review or edit them, and execute the approved test.** No test automation code is needed for the primary web UI workflow.

> **Release status (23 November 2026):** v0.2.0 is **ready to publish** following the maintainer's completed manual testing and green CI on `main` (3/3 independent E2E smoke tests; 119/119 browser regression tests). The package version is `0.2.0`. **No Git tag or GitHub Release has been published yet.** This is a local QA prototype, not a production-ready autonomous testing platform.

## Current functionality — implemented on `main`

| Capability | What you can do now |
| --- | --- |
| **Plain-English test creation** | Enter the website URL and natural-language instructions; GroqCloud uses a bounded initial-page snapshot to propose steps. **Fixture** mode works without AI. |
| **Human review** | Inspect and edit steps, locators and expectations. Approve individually or use **Add All**; nothing saves or executes without an explicit action. |
| **Generation diagnostics (v0.2)** | Inspect the initial page snapshot, HTTP status, allowed/blocked third-party resource counts and generated JSON. Advisory warnings flag suspicious error-page assertions or quoted requirement values missing from the draft. On initial HTTP 4xx/5xx, generation stops before calling AI; HTTP 403 highlights a possible website automation block without claiming that is the only explanation. |
| **Search-flow safeguards (v0.2)** | Preserve an explicitly quoted search query as a separate **Fill** step before **Press Enter** when the draft omitted typing. Validate requested search text against identifiable returned result cards, not the search field or page-wide text; unsupported result markup fails rather than producing a false pass. |
| **Incremental regeneration (v0.2)** | Use **Reinterpret with AI** on a selected step to replace only that step, or that step and all subsequent steps. Preview the proposal and reapprove changes while retaining unaffected approvals. |
| **Working drafts and test editing (v0.2)** | Use **Save Draft** for unfinished work, find drafts in the always-visible picker, resume them later, preserve original and amended instructions, and edit existing tests or **Save as New Test**. |
| **Website suites and execution** | Organise saved scripts by website. Run one script or up to **10** sequentially in isolated Chromium contexts, with **5/10/15-second** step timeout options. |
| **Diagnostics and repair** | Review per-step results, timing, actual vs expected values, screenshots/traces when available, selector preflight and human-approved locator/assertion repairs. |
| **Application memory proof of concept (v0.2)** | Learn only limited per-website evidence of a successful shopping flow following login, and suggest login as an **unverified** prerequisite on later relevant tests. Opt-out supported; credentials are not stored in this memory. |
| **Requirements traceability** | Manually map requirements to test actions/assertions, see gaps and export a read-only coverage matrix. |
| **Portable Playwright export** | Export an approved script as standalone Playwright `.spec.ts`; later execution does not require the AI provider. |
| **Run history and developer tools** | Review historic executions by site; use CLI generation, execution and export; access Help and `.env.example` onboarding instructions. |

**Start here:** [Release history](#release-history) · [Publish v0.2.0](#publishing-v020-on-github) · [Quick start](#quick-start) · [GroqCloud API setup](#groqcloud-api-setup) · [Demo video](#watch-the-demo-73-seconds) · [More feature details](#feature-details) · [Known limitations](#limitations-and-known-gaps) · [Documentation](#documentation)

## Release history

| Version | Scope | State |
| --- | --- | --- |
| **v0.2.0** | Incremental AI reinterpretation; working drafts and existing-test editing; per-website login-prerequisite memory proof of concept; Run Tests UI improvements; generation diagnostics; guarded HTTP 403 handling; search-flow correctness fixes | **Ready to publish** — manual acceptance and CI passed; tag and GitHub release pending |
| **v0.1.0** | Baseline prototype: plain-English to reviewed JSON tests, Playwright execution, repair assistance, suites, history, traceability and standalone export | Baseline functionality; check [GitHub Releases](https://github.com/leonard01/ai-ui-testing-agent/releases) for published versions |

**Release approach:** Small incremental versions may carry focused fixes with their own tests and documentation. Duplicate-name rejection, multi-term search predicates and general AND/NOT assertions are planned for **v0.3**, not v0.2.0 (see [#59](https://github.com/leonard01/ai-ui-testing-agent/issues/59), [#60](https://github.com/leonard01/ai-ui-testing-agent/issues/60) and [#61](https://github.com/leonard01/ai-ui-testing-agent/issues/61)). Broader application memory and additional hosted-model integrations are also future work. See [CHANGELOG.md](CHANGELOG.md) for release notes.

## Publishing v0.2.0 on GitHub

**Maintainer checklist — the repository is ready; publication is a separate action:**

1. Open the [latest successful `main` CI run](https://github.com/leonard01/ai-ui-testing-agent/actions/runs/45160164806) and confirm that the release commit contains the documentation you want to publish. Manual acceptance for v0.2.0 was completed on 23 November 2026.
2. Open [GitHub Releases → Draft a new release](https://github.com/leonard01/ai-ui-testing-agent/releases/new).
3. Under **Choose a tag**, type `v0.2.0` and select **Create new tag on publish** targeting **`main`** (or create it from the final release commit). Do **not** reuse an earlier release/tag.
4. Set the release title to **`v0.2.0 — AI UI Testing Agent (Prototype)`**. Use the `[0.2.0]` section in [CHANGELOG.md](CHANGELOG.md) as the release notes, including its limitations.
5. Consider checking **Set as a pre-release** because this is a pre-1.0, local, human-reviewed prototype. Click **Publish release** when satisfied.

No build artifacts, standalone installer or production deployment are required for this source-code release. Users clone the repository and follow [Quick start](#quick-start). Do not put API keys or `.env` secrets in a release. The current package version is already `0.2.0`.

## Quick start

Requires Node.js **22+**, npm and Playwright Chromium. Run these commands in a terminal:

```bash
git clone https://github.com/leonard01/ai-ui-testing-agent.git
cd ai-ui-testing-agent
npm ci
npx playwright install chromium
npm run start:demo
```

Open the **test builder** at **http://127.0.0.1:3100**. The sample website is at **http://127.0.0.1:3000**.

Enter a **test name**, the sample URL and an instruction such as *“Add a task called Prepare interview, verify it appears, complete it, then delete it and verify the list is empty.”* Choose **Fixture** to avoid AI calls, click **Generate draft**, review/approve the steps, save the script, then select the website under **Run Tests** and execute.

For existing clones, use `git switch main` and `git pull --ff-only`. Your local `.env` will not be overwritten.

## GroqCloud API setup

To generate real AI test steps, obtain an API key at [GroqCloud API Keys](https://console.groq.com/keys), then copy the repository template:

```bash
cp .env.example .env
```

Add your own key in `.env`:

```dotenv
GROQ_API_KEY=gsk_your_actual_key
GROQ_MODEL=openai/gpt-oss-20b
```

`GROQ_MODEL` is optional. Restart the server after editing. **Do not commit `.env` or share credentials.** GroqCloud quota limits apply; Fixture mode and running already approved tests do not require Groq requests.

## Independent Playwright E2E smoke suite

Run a fast **application-level release smoke** check from the repository root:

```bash
npm ci
npx playwright install chromium
npm run test:smoke
```

The dedicated `tests/e2e-smoke.spec.ts` suite drives the **real test-builder UI using Playwright directly**. It checks Fixture-mode generation, explicit human approval, saving and executing a test, run history, working-draft persistence, and running a two-test website suite. Each test uses isolated temporary storage and a separate local review server. No hosted AI key, external website or agent-authored JSON test harness is needed. Failures retain Playwright trace/screenshot evidence.

This is a **deterministic release gate**, not a verification of GroqCloud response quality. The maintainer has completed manual acceptance; live-model behaviour is still non-deterministic and is not benchmarked by the CI fixtures. The regular `npm test` command runs the broader regression suite.

**Latest verified release-candidate pipeline:** [GitHub Actions on `main`, 23 November 2026](https://github.com/leonard01/ai-ui-testing-agent/actions/runs/45160164806): **3/3 independent UI E2E smoke tests and 119/119 browser regression tests passed**, plus type-check, build and unit/schema validation. These counts describe automated deterministic coverage, not 119 real GroqCloud generation calls.

## Watch the demo (73 seconds)

[![Watch the AI UI Testing Agent v0.1 demo — plain-English test creation, approval, execution and results](assets/demo-thumbnail.jpg)](https://raw.githubusercontent.com/leonard01/ai-ui-testing-agent/main/assets/AI_UI_Testing_Agent_v0.1_LinkedIn_Demo.mp4)

**[▶ Play the demo video (MP4)](https://raw.githubusercontent.com/leonard01/ai-ui-testing-agent/main/assets/AI_UI_Testing_Agent_v0.1_LinkedIn_Demo.mp4)**

This recording shows the sample application, a plain-English test description, AI-generated steps, human approval, browser execution and the final passing result. No test automation code is written during the demonstration.

## Feature details

The table above summarises the current capabilities; the following gives more operational detail.

| Area | Implementation details |
| --- | --- |
| **AI-assisted test design** | Enter plain-English requirements and an application URL. Inspect a bounded snapshot of the live page and generate a structured test draft with **GroqCloud**. Use **Fixture** mode for a completely offline, prewritten demonstration (no AI). |
| **Human review and editing** | Read every proposed step in plain English, edit its action/locator/value/expectation, confirm steps individually or use **Add All**, then choose **Save Test** or **Save & Run**. The latter persists the approved test and moves focus to live execution. **Save Draft** preserves incomplete work without making it runnable. Generation and Add All never save or execute automatically. |
| **Structured test scripts** | Store validated, framework-neutral JSON definitions, including action steps, assertion provenance, optional requirement links and the originating website URL. Reject malformed definitions before browser execution. |
| **Website test suites** | Group approved scripts by website origin (scheme, host and port). Select a website and see **only its scripts** in both single-test and batch selectors. Edit/delete a script, or delete a website suite, with confirmation. Older unassigned scripts remain accessible. |
| **Browser execution** | Run one approved script or **1–10 scripts sequentially** in isolated Playwright Chromium contexts. Supported actions: navigate, click, fill, press keys, check/uncheck and select a native dropdown option. |
| **Assertions and diagnostics** | Verify exact or contained text, visibility, URL and element counts. Search-result text assertions can check *identifiable returned result cards* rather than page-wide query echoes; show a failure if suitable result cards cannot be identified. Display per-step verdicts, expected/observed values, timings and screenshots/traces when available. |
| **Selector inspection and repair** | Run read-only selector preflight; locate targets from explicit roles, labels, placeholders, visible text or live DOM intent. Show human-reviewable alternatives for missing/ambiguous locators and failed assertions. Distinguish blocked clicks from selector failures. Approved repairs save a corrected script and rerun from step 1. |
| **Requirements traceability** | Optionally link requirements to steps/assertions **manually**, show coverage gaps and view/export a read-only requirements matrix. AI cannot claim human-confirmed mappings. |
| **Playwright export** | Download a standalone `.spec.ts` for an approved script or export via CLI. Generated specs run with `@playwright/test`, without this agent or an AI service. |
| **Execution history** | Review completed executions **by website suite** at the bottom of the UI. History is collapsed behind **Show History**, filtered by website and paginated **10 at a time**. Reopen saved results after restarting; **Delete All History** clears run artifacts without deleting approved scripts. |
| **Developer workflow** | TypeScript, Node.js, local demo application, command-line runner/generator/exporter and GitHub Actions type-check, unit and Playwright browser tests. |

**Important terminology:** A **test suite** is a website's collection of saved **test scripts**. A **suite execution** is one occasion on which you run one script or a selected batch. A test can fail without stopping other scripts in the same batch.

The **structured JSON definition** is framework-neutral; **the current browser runner uses Playwright**. A framework-free execution backend is a future goal, not a current capability.

## Setup and usage reference

The [Quick start](#quick-start) above is the shortest setup path. The details below cover alternative launch methods.

### Quick launch (Windows, macOS or Linux)

After one-time setup (`npm ci` and `npx playwright install chromium`), run either command from the project root:

| Command | What it does |
| --- | --- |
| `npm start` | Builds the project and runs the test review UI at **http://127.0.0.1:3100**. |
| `npm run start:demo` | Builds once and runs **both** the demo app at **http://127.0.0.1:3000** and the test review UI at **http://127.0.0.1:3100**. |

Leave the terminal running and use **Ctrl+C** to stop the server(s). The two Node servers run concurrently in the combined command, so one does not block the other. The original `npm run build`, `npm run review`, and `npm run demo` commands also remain available individually.

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
4. In **Review proposed steps**, inspect and edit the draft. Tick confirmations individually or click **Add All**. Choose **Save Draft** (for unfinished work), **Save Test** (persist without running), or **Save & Run** (save, start execution, and focus on live results). Previously saved drafts remain accessible in **Saved working drafts**, even while the editor is open.
5. Under **Run Tests**, select the website test suite and its approved test script, then click **Run selected test** to rerun without saving a duplicate. You can also select several scripts from that website and click **Run selected suite**.
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

**Real AI generation:** See [GroqCloud API setup](#groqcloud-api-setup) at the top. In the UI choose **GroqCloud**. Copy `.env.example` to `.env` in the repository root (`cp .env.example .env`), then set `GROQ_API_KEY` to your key from https://console.groq.com/keys. The optional `GROQ_MODEL` defaults to `openai/gpt-oss-20b`. Restart the app after editing `.env`; your local `.env` is gitignored and won't be overwritten by pulls. Alternatively, set `GROQ_API_KEY` in your environment. Groq's free tier has provider-imposed limits; availability and quotas can change. The key remains in the local server and should **never** be committed. In the CLI, you can also explicitly choose **Ollama** (local model) or **OpenAI** (usage may incur charges). No cloud provider is selected automatically.

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

**CI:** GitHub Actions runs type-checking, build, unit/schema validation, the independent UI E2E smoke suite and Playwright browser tests. The verified [v0.2.0 `main` run](https://github.com/leonard01/ai-ui-testing-agent/actions/runs/45160164806) passed **3/3 smoke tests and 119/119 browser tests**; see [GitHub Actions](https://github.com/leonard01/ai-ui-testing-agent/actions) for subsequent runs.

## Limitations and known gaps

This prototype is meant to **demonstrate an end-to-end QA workflow**, not replace mature testing frameworks yet.

- **Playwright-backed execution only.** Additional runner backends, framework integrations and exporters beyond Playwright are not yet implemented.
- **Human oversight is required.** AI-generated steps and expectations can be incorrect. `Add All` is a bulk reviewer action, not independent validation. A green execution does not prove that requirements were specified correctly.
- **Live AI quality is not benchmarked.** CI uses fixtures/mocks rather than paid model calls. Real hosted-model output and reliability on arbitrary websites need further evaluation.
- **Authentication prerequisites are unverified.** Application memory can suggest that a shopping flow may need login, but it does not establish valid credentials. An AI draft may still propose unsupported username/password values; reviewers must reject or replace them with authorised test data before saving or running ([issue #45](https://github.com/leonard01/ai-ui-testing-agent/issues/45)).
- **Web UI testing only.** No API/mobile/load testing, automatic exploration, recording browser interactions or interactive human–AI browser takeover in the current release candidate.
- **Protected production websites are not reliable demo targets.** The tool does not bypass CAPTCHA, robot checks, access controls or anti-bot protection. Prefer test environments and official test fixtures.
- **Selector repairs can be fragile.** Numbered choices for identically named elements rely on DOM order and can break if the page changes. Human approval and subsequent reruns remain necessary.
- **Execution history is operational, not an immutable audit log.** Replacing a saved test may remove the superseded test and some related evidence. Removing an approved website suite does **not** automatically erase its history; **Delete All History** is a separate, global action.
- **Single browser execution at a time.** Suite runs are serial and use isolated contexts, intentionally reducing pressure on less powerful machines. The UI is a local development tool, not a hosted multi-user service.

**v0.2 release status:** Manual functional acceptance and the latest deterministic CI have passed. The package version is `0.2.0`; the `v0.2.0` Git tag and GitHub release are **not yet published**. Incremental regeneration sees the initial page snapshot, not the live page state after preceding steps. General AND/NOT assertions and independent multi-term result checks belong to v0.3.

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
| Generation stops at HTTP 403 | The site refused automated inspection. Bot protection is possible but not proven; check normal browser access and ask the test-environment owner about permissions or allowlisting |

## Contributing

Feedback, defect reports and reproducible examples are welcome through [GitHub Issues](https://github.com/leonard01/ai-ui-testing-agent/issues).

**Guiding principles:** explicit approvals; test expectations from requirements rather than observed bugs; reproducible browser runs; clear failure evidence; optional AI assistance; and portable, reviewable test definitions.
