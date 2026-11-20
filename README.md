# AI UI Testing Agent

> **Status: Early development — architecture defined; AI functionality not yet implemented.**

An AI-native UI test automation platform designed around **human–AI collaboration**. The long-term goal is to let a QA engineer design, demonstrate, run, amend, and maintain UI tests without having to work directly with conventional automation frameworks—while still being able to export editable, standalone test code.


## Vision

A QA engineer should be able to:

1. Supply application requirements **or** ask an AI agent to explore an application and propose test cases.
2. Demonstrate a user journey in a live browser and turn that interaction into an executable test.
3. Run a test while watching the browser, adjusting speed, pausing, stepping, or skipping.
4. Hand browser control to the AI at **any point** and take control back, retaining session state.
5. Load an **existing** test, demonstrate a correction, review a proposed diff, and update the test.
6. Export maintainable TypeScript tests and run them independently in GitHub Actions.
7. Inspect evidence, failures, assumptions and test changes rather than accepting opaque AI decisions.

A separate functionality tracker records the scope and distinguishes **Accepted**, **Proposed**, **To be considered later** and **Rejected** from delivery status and release target. It will be added to the repository separately.

## Current scope and technology

| Area | Direction |
| --- | --- |
| Primary language | TypeScript |
| Browser adapter | Playwright (proposed; Chromium first) |
| First exported test format | Standalone TypeScript / Playwright |
| Test representation | Framework-independent, structured test definitions |
| CI/CD | GitHub Actions |
| AI orchestration | Provider and SDK to be selected |
| User experience | Observable browser sessions with human/AI handoff |

The tool owns the *test definitions and workflow*. Playwright is a likely browser execution and export backend, not the central product abstraction.

## Project status

This repository contains a validated JSON test format, a structured browser runner, a command-line interface and a local task-list demo. Tests execute through Playwright and produce JSON step results with screenshots and traces on failure. The AI agent, recorder, interactive browser controls, existing-test editor, code exporter and test generator remain planned capabilities.

### Initial implementation milestones

- **M0 — Repository foundation:** TypeScript configuration, test runner, CI checks, architecture documentation and feature register.
- **M1 — One end-to-end AI-authored test:** Application URL and/or requirements → structured case → browser execution → evidence → TypeScript export.
- **M2 — Record and edit:** Observe a human browser demonstration to create or revise a test; show changes for approval.
- **M3 — Live human/AI collaboration:** Visible execution, pause/step/skip/speed, AI takeover and manual takeover in the same browser session.
- **M4 — Reliability and portability:** Export verification, CI runs, diagnostics, test-data controls, safety boundaries and benchmark suites.
- **M5 — Wider roadmap:** Work through the remaining proposed and later-release features in the tracker, with explicit prioritization.

## Development setup

Requirements: Node.js 22 or later and npm. Use Node.js 22 to match CI.

```bash
npm ci
npx playwright install --with-deps chromium
npm run typecheck
npm run build
npm run test:unit
npm test
```

The smoke test creates a small page locally, clicks a button and verifies the status changes. It needs no external website, model credentials or AI service. It verifies the browser tooling, not AI functionality.

The runner integration tests start the local demo server automatically. They verify a complete task lifecycle, fresh sessions, assertion failures, missing targets, failure artifacts and CLI exit codes. Tests of expected failure handling pass when the runner correctly reports that failure.

## Run a structured test case

After building, start the demo in one terminal:

```bash
npm run demo
```

Open http://127.0.0.1:3000 to use the demo yourself. In another terminal:

```bash
npm run agent -- run examples/add-task.json --headed
```

Omit `--headed` to run without a visible browser. Edit the JSON case to change the steps and expected results, then run it again. No Playwright test script is needed to author a case.

Optional flags: `--base-url http://127.0.0.1:3000`, `--timeout 5000` (per action or assertion, 1–60000 milliseconds), and `--output run-results/my-run`. The default output directory is unique per invocation; reusing an explicit directory replaces its report. Run one process per explicit output directory.

Supported actions are `navigate`, `click`, `fill`, `assert-text` and `assert-visible`. Targets use exact role/name, label or text matching. Text assertions compare text content after collapsing whitespace. Assertions carry requirement, human-confirmed or inferred provenance. The first step must navigate, step IDs must be unique, and every case must contain an assertion.

The runner validates the case before launching Chromium, uses a fresh browser context, and stops execution at the first failure. Later steps are recorded as skipped. Navigation and network requests are restricted to the configured application origin, so third-party-dependent applications are outside this milestone's scope.

Each run writes `report.json` with its verdict, per-step timings, expected/observed text and errors. Failures after a page is created attempt to save `failure.png` and `trace.zip`. Evidence-capture errors are recorded separately. Invalid cases and browser launch errors still produce an execution-error report. Report-writing failures are printed to the terminal.

| CLI exit code | Meaning |
| --- | --- |
| 0 | All steps and assertions passed |
| 1 | An assertion failed |
| 2 | Invalid input, missing target or another execution error |

These are deterministic authored cases. The runner does not yet infer targets, generate test cases, pause execution or export scripts.

GitHub Actions runs these checks on pushes to main and pull requests, and can be started manually. HTML and JUnit reports are uploaded as artifacts; failed tests also retain screenshots and traces. The foundation passed its first [GitHub Actions run](https://github.com/leonard01/ai-ui-testing-agent/actions/runs/44738495584), including dependency installation, Chromium setup, type-checking, compilation and the browser smoke test.

## Design principles

- **AI assists; humans remain in control.** Browser control can be explicitly transferred in either direction.
- **Preserve existing tests.** Script edits must be reviewable; unchanged steps should stay unchanged.
- **Do not confuse observed behaviour with correct behaviour.** Requirements, confirmed expectations, and AI assumptions must be distinguishable.
- **No silent assertion healing.** A test must not be made to pass by weakening expected outcomes without approval.
- **Portable outputs.** Exported TypeScript should run outside this application.
- **Repeatable execution first.** Prefer stable replay; use AI reasoning when needed rather than for every action.
- **Safe browser automation.** Restrict permitted hosts/actions and treat webpage text as untrusted input.
- **Evidence over claims.** Record execution diagnostics and publish measured benchmark results when available.

## Project structure

```text
.github/workflows/ci.yml      TypeScript, unit and browser integration checks
src/domain.ts                Test, step, report and session types
src/schema.ts                Strict validation of JSON test definitions
src/runner.ts                Structured browser execution and evidence
src/cli.ts                   Command-line entry point
src/demo/server.ts           Local demo server
src/index.ts                 Public exports
demo/index.html              Task-list application under test
examples/add-task.json       Editable nine-step lifecycle case
tests/runner.spec.ts          Browser and CLI integration tests
tests/unit/schema.test.mjs   Validation and pre-browser rejection tests
tests/smoke.spec.ts           Browser tooling smoke test
planning/                     Planned requirements register (not committed yet)
docs/architecture.md          Planned architecture document
docs/roadmap.md               Planned detailed roadmap
docs/decisions/               Planned architecture decision records
```

## Contributions

This is initially a solo portfolio project. Feedback, issues and discussion are welcome.
