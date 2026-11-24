# CI testing strategy

Every CI run type-checks, builds and runs the complete deterministic unit suite. Development branches (`fix/`, `chore/`, `feat/`, `test/`) and draft PRs run the browser sanity subset. Use draft PRs during iterative development; mark ready for review to trigger full regression before merging into an integration branch (`feature/`) or `main`. Pushes to integration branches and `main`, and manual workflow dispatches, run the full suite and independent E2E smoke gate. Superseded runs on the same ref are cancelled. Branch naming convention: reserve `feature/` for integration branches; use `feat/` for sub-features.

## Sanity suite

Run `npm ci`, `npx playwright install chromium`, `npm run build`, then `npm run test:sanity` locally. The suite selects existing tests tagged `@sanity` or `@e2e-smoke`; it does not duplicate their implementations. Coverage includes draft generation, explicit approval, execution/history, draft persistence, website suites, required inputs, site memory, instruction mismatch handling, incremental amendments and review, credential guards, locator discovery/repair, malformed model output recovery, failure diagnostics and export. Tests use local fixtures or mocked AI responses; live AI acceptance remains separate. New major workflows should receive a representative sanity case. Full regression still includes every sanity test.

Do not merge a ready PR into an integration branch or main until its full gate is green. This workflow does not itself configure GitHub branch protection.
