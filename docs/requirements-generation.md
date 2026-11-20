# Requirements-to-test generation (first AI milestone)

This branch introduces **AI-generated JSON test drafts** from Markdown/plain-text acceptance criteria and a bounded live webpage snapshot. The existing deterministic runner remains responsible for execution.

## Setup

Node.js 22+, npm, Chromium and a valid OpenAI API key are required to use a real model. CI uses a deterministic model stub; no API credentials are used in tests.

```bash
npm ci
npx playwright install chromium
npm run build
```

In the first terminal, start the local demo:

```bash
npm run demo
```

In another terminal (Git Bash on Windows):

```bash
export OPENAI_API_KEY="your-api-key"
export OPENAI_MODEL="gpt-4.1-mini"
npm run generate -- generate --requirements examples/requirements-task-list.md --output generated/task-draft.json
```

Generated files are **drafts**, and generation does not launch a test run. Review each action, locator and expected result before running:

```bash
npm run agent -- run generated/task-draft.json --headed
```

To ask for a conservative initial draft without provided requirements:

```bash
npm run generate -- generate --output generated/exploratory-draft.json
```

Use `--base-url URL` for another site you have permission to test; the browser inspector and test runner restrict navigation and requests to the configured HTTP(S) origin. Use `--model MODEL` to choose a different supported model. Do not commit API keys; the tool doesn't load `.env` files automatically.

## What the feature does

- Captures a bounded snapshot: title, headings, form controls, status and limited text.
- Gives the model supplied requirements plus the untrusted page snapshot.
- Requests JSON through the OpenAI Responses API and validates it against the existing strict Zod test schema.
- Rejects off-origin navigation and model claims that an expectation is already `human-confirmed`.
- Saves a **reviewable test JSON file**, not an automatically approved/executed test.

## Explicit limitations

- One-page snapshot only: no multi-page autonomous exploration or AI-driven clicking.
- AI can propose incorrect expectations and locators; schema validation alone does not prove test correctness.
- Page text is untrusted; prompt instructions reduce but cannot eliminate prompt-injection risks.
- The developer/tester must read and approve a generated draft before execution.
- Unit and browser tests inject a **stubbed model**, so CI verifies integration and fault detection, **not live-model quality**.
- The seeded defect test confirms a *known* requirement-based assertion detects a broken completed-count implementation. It is **not** evidence of autonomous bug discovery.

## Local checks

```bash
npm run typecheck
npm run build
npm run test:unit
npm test
```

**Next:** introduce an explicit approval/review UI or command, model-output evaluation against independently specified requirements, and a richer controlled browser exploration loop.
