# Natural-language test review UI (early MVP)

This is a **local-only** test-draft builder, not a deployed SaaS application. It runs on your computer, while GroqCloud handles model inference remotely. The browser never receives the API key.

## Start

From the repository root, with Node.js 22+, Playwright Chromium installed, and the generation feature branch checked out:

```bash
git pull --ff-only
npm ci
npm run build
```

Put your actual GroqCloud key in ignored `.env`:

```dotenv
GROQ_API_KEY="gsk_your_key"
```

Start the application under test in terminal 1:

```bash
npm run demo
```

Start the review UI in terminal 2:

```bash
npm run review
```

Open **http://127.0.0.1:3100/** in a browser.

## Use

1. Set the application URL (initially `http://127.0.0.1:3000`).
2. Write plain-English actions and expected results, e.g. **"Add a task called Prepare interview, check that it appears, complete it, then delete it."**
3. Optionally import a **.txt or .md** file. Its text is appended to the textarea; you can revise it before submission. Input is capped at 12,000 characters.
4. Select **GroqCloud** (real hosted model, using free-tier limits) or **Fixture** (prewritten nine-step test for debugging; does *not* generate new steps from the entered request).
5. Click **Generate draft**. The server inspects the specified page in a headless Chromium session, sends the selected instructions and bounded snapshot to the chosen model, and validates the returned JSON with the existing schema.
6. Inspect the **human-readable plan**. Each card shows the real operation, target, value or expectation and assertion provenance. Inferred assertions and suspicious named listitem locators are flagged.
7. Change fields via **Edit fields** if needed, including switching a locator between accessible role/name, form label and visible text. For example, replace an incorrect form-label locator for the **Add** button with role **button**, accessible name **Add**. Then individually confirm each step represents your intended behaviour.
8. Click **Approve and save JSON test**. This saves an ordinary, framework-neutral file under `generated/`. It **does not execute** the test. Use the displayed `npm run agent -- run ...` command afterward.

Editing is intentionally small in this first version: field values, locators, descriptions, paths and expected text; adding/removing/reordering steps without regenerating is not yet supported. Revise the instructions and generate another draft to change the overall workflow.

## What it does not do yet

- Direct manipulation of the live page by AI, agentic exploration, multi-page discovery or iterative auto-repair
- Uploading PDF/Word files (use plain text or Markdown for now)
- Appending natural-language instructions into an existing approved JSON case
- Semantic correctness verification, reliable locator validation or guaranteed requirement coverage
- Automatic execution on approval, test-suite management, or a deployed/multi-user server

If the test page does not expose a suitable Add User interface, an input such as **"add user Bob"** might generate a plausible but non-runnable plan. The reviewer must check the target application and expectations. This is why drafts require explicit approval.

## Security and cost notes

- The UI server binds **127.0.0.1:3100 only**, does not expose CORS, requires JSON requests and checks same-origin writes; it is not suitable for a public network deployment without proper authentication and additional defences.
- GroqCloud receives selected test instructions and bounded page data. Do not send credentials, confidential production data or sensitive records.
- API keys are read locally from `.env` by the server and are not embedded in HTML, JSON test definitions or displayed error messages. `.env` is already ignored by Git.
- GroqCloud is subject to provider free-tier rate and token allowances. A **Generate draft** click makes a model call; test review, saving, and deterministic execution do not.
- The fixture mode is entirely offline with respect to AI. CI uses this mode and never sends a real GroqCloud request.
- No generated tests are silently executed. Approval does not automatically mark assertions as `human-confirmed`; that provenance requires an intentional future workflow.
