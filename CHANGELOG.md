# Changelog

This project is a pre-1.0 prototype. Release increments are deliberately small; later `0.2.x` updates can add focused functionality as well as fixes.

## [0.2.0] — Prepared, not yet published

### Added
- **Incremental AI reinterpretation:** Replace one selected test step, or that step and all following steps, with a reviewed AI-generated patch. Preserve approvals and IDs outside the changed range; require human approval of replacement steps.
- **Resumable working drafts:** Save incomplete reviews independently of runnable tests, reopen drafts after restarting, and retain original versus amended instructions.
- **Existing-test editing:** Reopen saved tests, explicitly save changes or save a separate test without silently modifying an approved script.
- **Application-memory proof of concept:** For each website origin, derive limited evidence from fully passed approved shopping workflows that logged in first. Offer an optional, unverified login-prerequisite suggestion; do not store credentials or raw DOM in this memory.
- **Help and configuration onboarding:** Prominent Help dialog; tracked `.env.example`, GroqCloud key instructions and link to https://console.groq.com/keys.

### Improved
- **Run Tests usability:** Side-by-side suite/test selection, selected-suite filtering, and step timeout controls (5, 10, or 15 seconds).
- **Generation/review clarity:** Readiness and progress messaging, explicit required fields, active URL source highlighting, and clearer failed-generation handling that avoids saving stale draft steps.
- **Draft generation diagnostics:** Review initial-page HTTP/load evidence, blocked cross-origin resource counts and validated generated JSON. Advisory warnings identify unexpected error-page assertions and missing quoted requirement values before approval.
- **Regression coverage and stability:** Automated validation of new workflows and safer HTTP test-server cleanup.

### Known limitations
- AI step generation can be non-deterministic. Incremental regeneration uses an **initial** page snapshot rather than replaying the already-approved prefix to observe later page state.
- Per-website memory is deliberately narrow, based only on qualifying login-then-shopping observations; it does not discover or store credentials, retrieve arbitrary past tests, or prove login is mandatory.
- The primary browser execution engine is Playwright/Chromium; framework-neutral JSON definitions are not a second framework-free runner.
- Real-model GroqCloud quality and arbitrary-site success are not guaranteed by fixture/mocked CI tests. GroqCloud usage limits apply.

### Verification
- Before release preparation: GitHub Actions on `main` completed successfully with **105 automated browser tests** alongside type-check, build and schema/unit checks ([successful run](https://github.com/leonard01/ai-ui-testing-agent/actions/runs/45035904113)).
- Release-preparation CI and a final manual GroqCloud smoke test are separate gates. No tag or GitHub release is implied by this changelog.

## v0.1 baseline

Initial working prototype covering plain-English test generation, explicit human approval, validated JSON scripts, website suites, Playwright execution, diagnostics and repairs, execution history, traceability and portable Playwright export. Exact published versions are tracked at [GitHub Releases](https://github.com/leonard01/ai-ui-testing-agent/releases).
