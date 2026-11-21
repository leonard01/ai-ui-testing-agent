# Export approved tests as standalone Playwright TypeScript

The review UI can download a saved, approved test as an ordinary editable `.spec.ts` file. The file uses **only** `@playwright/test`; it does not import the agent, run GroqCloud, or need the original JSON at runtime.

## From the review UI

1. Run the demo or your target application, then start the review UI (`npm run build && npm run review`).
2. Generate or open a test, review its steps and expectations, and explicitly save it.
3. Under **Execute and diagnose**, choose that approved test in the **Approved saved test** dropdown.
4. Confirm **Application URL** and **Step timeout**. Click **Export Playwright (.spec.ts)** to download the independent script.
5. Copy the downloaded file into the `tests/` directory of an existing Playwright TypeScript project, or start one with `npm init playwright@latest`.

The download is read-only. It never starts a test, changes the JSON, contacts an AI model, or creates another saved test entry. The local API only exports validated `reviewed-*.json` files.

## Running independently

From the destination Playwright project:

```bash
npm install --save-dev @playwright/test
npx playwright install chromium
npx playwright test tests/reviewed-example.spec.ts
```

The generated spec embeds the application URL selected at export time. For a different environment, set `TEST_BASE_URL` before running:

```bash
# macOS/Linux shell
TEST_BASE_URL=https://staging.example.com npx playwright test tests/reviewed-example.spec.ts

# Windows PowerShell
$env:TEST_BASE_URL = "https://staging.example.com"
npx playwright test tests/reviewed-example.spec.ts
```

Navigation and URL assertions use the **path, query and fragment** of the original approved same-origin URL, so changing `TEST_BASE_URL` can point the same test at a different deployment. Any page request outside the configured origin is aborted, matching the agent runner's initial security boundary. Tests requiring third-party resources may therefore need a deliberate update before reuse.

## CLI export (local JSON)

```bash
npm run build
npm run agent -- export examples/add-task.json --base-url http://127.0.0.1:3000 --output generated/my-task.spec.ts
```

The CLI accepts any **schema-valid** JSON file, so you are responsible for reviewing it. The **review UI**, unlike the generic CLI, restricts downloads to already saved approved tests. Both routes work offline and do not invoke the runner or AI.

## Mapping and interoperability

| Reviewed action | Exported Playwright API |
| --- | --- |
| `navigate` | `page.goto(sameOriginURL(path))` |
| `click` | `locator.click()` |
| `fill` | `locator.fill(value)` |
| `check` / `uncheck` | `locator.check()` / `locator.uncheck()` |
| `select-option` | `locator.selectOption(value)` |
| `press` | `locator.press(key)` |
| `assert-text` | `expect(locator).toHaveText(expected)` |
| `assert-visible` | `expect(locator).toBeVisible()` |
| `assert-url` | `expect(page).toHaveURL(url)` |
| `assert-count` | `expect(locator).toHaveCount(count)` |

Every action is wrapped in `test.step` with the reviewed description. Assertion provenance is preserved as a source comment, and values/expectations are emitted as escaped string literals rather than executable code.

Role/name, label and text targets become idiomatic Playwright locators. **Intent** targets embed a small self-contained live DOM resolver with the agent's deterministic candidate/ambiguity approach; there is no model call at runtime. For long-term portability, prefer editing ambiguous or unstable intent targets to explicit accessible locators before export. The script remains editable TypeScript and can be integrated into existing projects and CI pipelines.

## Important limits

- The resulting script is **not** a fixture dump, nor a screenshot recording. It cannot reproduce external authentication state, secrets, network mocks or setup that was never included in the approved steps.
- The standalone spec uses Playwright's own assertions, diagnostics and timeouts. Reporting, traces, and screenshots depend on the destination Playwright configuration and may differ from the agent's custom JSON report.
- The exported script preserves the approved expected results, including erroneous or inferred expectations; exporting does not correct tests or guarantee they pass.
- The export may include user-entered values such as test credentials. **Review and redact sensitive data before committing or sharing** the downloaded file.
- Export currently produces one test per file. Batch export, additional frameworks and persistent cross-project test management are not implemented.

## Verification

The project's integration suite generates a real `.spec.ts`, launches a separate Playwright process against the demo app, and verifies both passing and deliberately failing cases. This checks executable portability, not just text generation.
