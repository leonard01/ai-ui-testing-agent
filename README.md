# AI UI Testing Agent

> **Status: Early development — architecture defined; AI functionality not yet implemented.**

An AI-native UI test automation platform designed around **human–AI collaboration**. The long-term goal is to let a QA engineer design, demonstrate, run, amend, and maintain UI tests without having to work directly with conventional automation frameworks—while still being able to export editable, standalone test code.

This is an engineering portfolio and learning project. Commercialization is optional, not its primary goal.

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

This repository contains a TypeScript development scaffold, provisional domain contracts, a deterministic Playwright browser smoke test and a GitHub Actions workflow. The AI agent, recorder, interactive browser viewer, existing-test editor and test generator are planned capabilities, not completed features.

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
npm test
```

The smoke test creates a small page locally, clicks a button and verifies the status changes. It needs no external website, model credentials or AI service. It verifies the browser tooling, not AI functionality.

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
.github/workflows/ci.yml      CI checks and Chromium smoke test
src/domain.ts                 Initial test and session data contracts
src/index.ts                  Public package exports
tests/smoke.spec.ts           Deterministic Playwright setup verification
planning/                     Planned requirements register (not committed yet)
docs/architecture.md          Planned architecture document
docs/roadmap.md               Planned detailed roadmap
docs/decisions/               Planned architecture decision records
```

## Contributions

This is initially a solo portfolio project. Feedback, issues and discussion are welcome.
