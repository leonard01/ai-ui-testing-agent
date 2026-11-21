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
8. Click **Approve and save JSON test**. This saves an ordinary, framework-neutral file under `generated/`. It **does not execute** the test.
9. In **3. Execute and diagnose**, choose your saved test (newly saved tests are selected automatically), choose a 5/10/15-second per-step timeout, and click **Run selected test**.
10. The local server launches headless Playwright for that explicitly saved test, with **one browser execution at a time** to reduce pressure on slower laptops.
11. The UI polls for completion, then shows per-step results, expected and observed text, locator-discovery evidence, and the first failure's likely category. When available, click **Open failure screenshot**, **Download Playwright trace** or **View full JSON report**.

After restarting the UI server, the saved test dropdown repopulates from `generated/reviewed-*.json`. The UI retains execution reports on disk in `run-results/`. The current prototype does not reload historical reports after a server restart; use the saved JSON report files for those historical runs.

## Human-assisted locator choice

When a step such as `Complete` matches both `Complete preparing a presentation` and `Complete reviewing documentation`, the failure report now includes a structured `ambiguity` array with candidates from the **live DOM**. The UI renders them as selectable options. A tester can pick the intended control and explicitly save a repaired test definition **without editing JSON**.

The original execution stops without taking the ambiguous action. Approval creates a **new** `generated/reviewed-*.json` file; the chosen correction is then tested by a **fresh Playwright run from step 1**, not a resume of the stopped browser. Follow-up failures are still possible, and their expected values are never rewritten to make them pass.

The local API `POST /api/repair` takes a completed `runId` and a candidate index, validates them against the recorded run, and rejects unknown, missing, truncated or identically named candidate selections. It does not accept arbitrary new selectors. This does not provide full interactive debugging or approval while a session is paused: that is a future milestone.

## Debugging GroqCloud HTTP 400 during generation

If the GroqCloud model rejects a request, the review interface now separates:
- **Local input validation** (HTTP 400 from the local Test Builder)
- **Upstream GroqCloud errors** (Groq may return HTTP 400; the Test Builder responds with HTTP 502 and labels the **provider HTTP status**)
- **JSON/schema generation validation** (HTTP 422 from the Test Builder)

The error panel shows a **safe category**, optional provider error code/type/parameter, and length of the **user's instruction text**. The raw upstream error body is deliberately not echoed or logged, because providers sometimes include user input, credentials, or partial completions. No API key should ever be pasted into a bug report.

For critical [Issue #4](https://github.com/leonard01/ai-ui-testing-agent/issues/4), rerun the exact Test 1 requirements after updating and rebuilding. Capture the *whole error panel*, including source, category, provider status and safe code; if a request succeeds, capture the fact that it succeeded. That evidence is required before attributing the HTTP 400 to length, JSON generation, unsupported model settings or another cause. The test input is far shorter than the 12,000-character local limit.

The CI regression exercises a **mocked** Groq HTTP 400; it does not spend provider tokens and does not establish the cause of the user's original live failure. This issue stays open until a real provider reproduction or successful confirmation.

## Failure diagnoses

Diagnosis is **deterministic**, not a new AI request. Possible categories include assertion mismatch, ambiguous target, locator/timing issue and browser/environment issue. The UI labels likely causes as suggestions, not proven root causes.

- **Assertion failure**: preserve the expected requirement; compare it with the observed value. Do not automatically change assertions to make tests pass.
- **Locator or intent failure**: inspect the role, name, nearby DOM evidence and captured screenshot; edit the test definition and approve/save a revised copy.
- **Ambiguous target**: the runner stops **without clicking**. When live DOM discovery returns distinct candidate names, the failed step presents radio choices with role and nearby text. Select the intended element and click **Save corrected copy and rerun from start**. The server accepts only a candidate recorded in that failed run, saves a separate approved JSON file and reruns it from step 1. Only that step's target intent changes; **assertions and the original saved file stay unchanged**. No extra AI model call is made.
- **Identically named targets**: if candidates cannot be distinguished by name (or the candidate list is truncated), the one-click repair is rejected; manually refine the locator. Avoid choosing blindly.
- **Older reports**: runs created before this feature lack structured candidates. Restart the UI after pulling changes and **run the saved test again** to populate the choice list.
- **Browser failure**: inspect the full error and Playwright installation.

Artifacts are accessible through limited local UI routes for runs created in the current server session. No arbitrary filesystem paths can be read through the run-artifact endpoints.

Editing is intentionally small in this first version: field values, locators, descriptions, paths and expected text; adding/removing/reordering steps without regenerating is not yet supported. Revise the instructions and generate another draft to change the overall workflow.

## What it does not do yet

- Direct manipulation of the live page by AI, agentic exploration, multi-page discovery or iterative auto-repair
- Uploading PDF/Word files (use plain text or Markdown for now)
- Appending natural-language instructions into an existing approved JSON case
- Semantic correctness verification, reliable locator validation or guaranteed requirement coverage
- Automatic execution on approval (intentional), test-suite management/history viewer, or a deployed/multi-user server

If the test page does not expose a suitable Add User interface, an input such as **"add user Bob"** might generate a plausible but non-runnable plan. The reviewer must check the target application and expectations. This is why drafts require explicit approval.

## Security and cost notes

- The UI server binds **127.0.0.1:3100 only**, does not expose CORS, requires JSON requests and checks same-origin writes; it is not suitable for a public network deployment without proper authentication and additional defences.
- GroqCloud receives selected test instructions and bounded page data. Do not send credentials, confidential production data or sensitive records.
- API keys are read locally from `.env` by the server and are not embedded in HTML, JSON test definitions or displayed error messages. `.env` is already ignored by Git.
- GroqCloud is subject to provider free-tier rate and token allowances. A **Generate draft** click makes a model call; test review, saving, and deterministic execution do not.
- The fixture mode is entirely offline with respect to AI. CI uses this mode and never sends a real GroqCloud request.
- No generated tests are silently executed. Approval does not automatically mark assertions as `human-confirmed`; that provenance requires an intentional future workflow. Execution requires clicking Run selected test after saving.
- Screenshot and trace files can contain sensitive application data. The local server serves them only on 127.0.0.1 using explicit run IDs, but this prototype should not be exposed beyond loopback.
