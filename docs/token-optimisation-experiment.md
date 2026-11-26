# GroqCloud token optimisation — November 26, 2026

## Method
GPT-OSS 20B, 2500 completion token ceiling (includes reasoning), paired JSON/text and low/medium reasoning requests. Original matrix: 40 cases, 10 task-list descriptions. Independent holdout: 20 cases, five synthetic snapshots (commerce, search, forms, dashboard, Unicode). Cases paired across configurations, order rotated. Benchmark bypasses application-level fallback; normal finish is not functional correctness. HTTP 429 retries respect reset headers with a minimum 60 seconds, bounded to two retries.

## Input estimation
Harmony ordinary-text encoding counts system and user messages. Original observed differences on 34 responses with usage: JSON +102, text +74. Calibration is scoped to GroqCloud GPT-OSS 20B and effective response format; other models/providers retain uncalibrated estimates. Independent holdout: 19/19 measured inputs exact, one response lacked usage. Mean and maximum absolute percentage error both 0%, exceeding targets <2% and <5%. This is input-only estimation, not total consumption prediction or a guarantee across future provider changes.

## Response outcomes
Across both experiments (15 per configuration), normal finishes: JSON low 15, text low 14, JSON medium 6, text medium 7. Holdout mean total tokens: JSON low 1828.4 (5), text low 1765.4 (5), JSON medium 3631 (4), text medium 3350 (5). Missing usage and truncation prevent interpreting unpaired means as equivalent successful work. Medium reasoning sometimes consumes 2498 of 2500 completion tokens. Original and holdout recovered 14/14 and 6/6 rate-limit incidents respectively.

## Decision
Default GPT-OSS 20B to low reasoning and JSON-only policy. Explicit text and legacy hybrid remain available for controlled experiments/rollback; existing local .env settings override defaults. Keep 2500 completion budget. Do not add new JSON recovery until response-hardening work. Benchmark execution status indicates matrix completion, not functional success.

## Release gates
Run build, full unit suite, Playwright regression, and targeted manual generation/execution tests with JSON/low. Verify requirement preservation, negative assertions, longer scenarios, site memory/login, ambiguous locators and incremental regeneration. Verify explicit policy overrides and that default JSON failures do not trigger text fallback. Do not merge until failures are reviewed. Holdout snapshots are synthetic and do not establish browser execution correctness. No additional large token experiment required for 0.3 unless regression findings invalidate assumptions.
